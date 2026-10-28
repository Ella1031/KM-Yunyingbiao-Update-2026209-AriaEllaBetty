#!/usr/bin/env python3
"""Persistent state and file fingerprints for resumable KM refresh runs."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import tempfile
import zipfile
from pathlib import Path
from typing import Any


STATE_VERSION = 1


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def workbook_integrity(path: Path) -> str:
    if path.suffix.lower() != ".xlsx":
        return "not-xlsx"
    with zipfile.ZipFile(path, "r") as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f"工作簿 ZIP 已损坏：{path} -> {bad}")
    return "ok"


def fingerprint(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if not resolved.is_file():
        raise ValueError(f"文件不存在：{resolved}")
    stat = resolved.stat()
    return {
        "path": str(resolved),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "mtimeNs": str(stat.st_mtime_ns),
        "sha256": sha256(resolved),
        "integrity": workbook_integrity(resolved),
    }


def fingerprint_matches(saved: dict[str, Any] | None) -> bool:
    if not saved or not saved.get("path"):
        return False
    path = Path(saved["path"])
    if not path.is_file():
        return False
    stat = path.stat()
    if stat.st_size != saved.get("size") or str(stat.st_mtime_ns) != str(saved.get("mtimeNs")):
        return False
    return sha256(path) == saved.get("sha256")


def new_state(run_dir: Path) -> dict[str, Any]:
    now = utc_now()
    return {
        "version": STATE_VERSION,
        "runId": run_dir.name,
        "runDirectory": str(run_dir.resolve()),
        "createdAt": now,
        "updatedAt": now,
        "status": "in_progress",
        "freshness": {},
        "inputs": {},
        "sources": {},
        "stages": {},
        "delivery": {},
    }


def load_state(path: Path, run_dir: Path | None = None) -> dict[str, Any]:
    if not path.exists():
        return new_state(run_dir or path.parent)
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("version") != STATE_VERSION:
        raise ValueError(f"不支持的运行状态版本：{state.get('version')}")
    return state


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updatedAt"] = utc_now()
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as output:
            json.dump(state, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.replace(temp_name, path)
    except Exception:
        Path(temp_name).unlink(missing_ok=True)
        raise


def record_source(
    state: dict[str, Any],
    name: str,
    path: Path,
    domain: str,
    status: str,
    validation: dict[str, Any] | None = None,
) -> None:
    state["sources"][name] = {
        **fingerprint(path),
        "domain": domain,
        "status": status,
        "validatedAt": utc_now() if status == "validated" else None,
        "validation": validation,
    }


def stage_reusable(state: dict[str, Any], name: str, paths: list[Path]) -> bool:
    stage = state.get("stages", {}).get(name, {})
    if stage.get("status") != "complete":
        return False
    saved_outputs = stage.get("outputs", [])
    if len(saved_outputs) != len(paths):
        return False
    expected = {str(path.resolve()) for path in paths}
    actual = {item.get("path") for item in saved_outputs if fingerprint_matches(item)}
    return actual == expected


def set_stage(
    state: dict[str, Any],
    name: str,
    status: str,
    outputs: list[Path] | None = None,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    state["stages"][name] = {
        "status": status,
        "updatedAt": utc_now(),
        "outputs": [fingerprint(path) for path in (outputs or []) if path.is_file()],
        "result": result,
        "error": error,
    }


def status_summary(state: dict[str, Any]) -> dict[str, Any]:
    sources = {
        name: {
            "status": item.get("status"),
            "path": item.get("path"),
            "fingerprintMatches": fingerprint_matches(item),
        }
        for name, item in state.get("sources", {}).items()
    }
    stages = {
        name: {"status": item.get("status"), "error": item.get("error")}
        for name, item in state.get("stages", {}).items()
    }
    validated = {name for name, item in sources.items() if item["status"] == "validated" and item["fingerprintMatches"]}
    if state.get("status") == "complete":
        action = "complete"
    elif {"bi", "tracking", "products"}.issubset(validated):
        action = "resume_processing_or_validation"
    elif "bi" in validated:
        action = "download_or_validate_erp"
    elif {"tracking", "products"}.issubset(validated):
        action = "download_or_validate_bi"
    else:
        action = "validate_existing_downloads_before_login"
    return {
        "runId": state.get("runId"),
        "status": state.get("status"),
        "recommendedAction": action,
        "freshness": state.get("freshness", {}),
        "sources": sources,
        "stages": stages,
        "delivery": state.get("delivery", {}),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    state = load_state(args.state)
    print(json.dumps(status_summary(state), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
