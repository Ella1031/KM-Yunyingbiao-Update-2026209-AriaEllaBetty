#!/usr/bin/env python3
"""Build or resume a complete KM workbook refresh with persistent stages."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import run_state


SCRIPT_DIR = Path(__file__).resolve().parent
ERP_SOURCE_VALIDATION_VERSION = 2
BI_SOURCE_VALIDATION_VERSION = 2


def run_json(command: list[str]) -> dict:
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    if completed.returncode:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(detail or f"Command failed with exit code {completed.returncode}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Processor returned invalid JSON: {completed.stdout}") from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", required=True, type=Path)
    parser.add_argument("--tracking", required=True, type=Path)
    parser.add_argument("--products", required=True, type=Path)
    parser.add_argument("--platform", type=Path)
    parser.add_argument("--sales", type=Path)
    parser.add_argument("--bi", required=True, type=Path)
    parser.add_argument("--cleaned-bi-output", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--state-file", type=Path)
    parser.add_argument("--erp-fresh-after", type=float)
    parser.add_argument("--bi-fresh-after", type=float)
    parser.add_argument("--today", type=dt.date.fromisoformat, default=dt.date.today())
    parser.add_argument("--replace-workbook", action="store_true")
    parser.add_argument("--replace-existing-output", action="store_true")
    return parser


def same_file_content(left: Path, right: Path) -> bool:
    return (
        left.is_file()
        and right.is_file()
        and left.stat().st_size == right.stat().st_size
        and run_state.sha256(left) == run_state.sha256(right)
    )


def archive_failed_stage(path: Path, run_dir: Path) -> None:
    if not path.exists():
        return
    failed_dir = run_dir / "failed-artifacts"
    failed_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path.replace(failed_dir / f"{stamp}-{path.name}")


def source_reusable(state: dict, name: str, path: Path) -> bool:
    saved = state.get("sources", {}).get(name)
    return (
        bool(saved)
        and saved.get("status") == "validated"
        and saved.get("path") == str(path.resolve())
        and run_state.fingerprint_matches(saved)
    )


def validate_sources(args, state: dict, state_file: Path, erp_fresh_after: float, bi_fresh_after: float) -> dict:
    erp_paths = {"tracking": args.tracking, "products": args.products}
    if args.platform:
        erp_paths.update({"platform": args.platform, "sales": args.sales})
    erp_validation_stage = state.get("stages", {}).get("erp_sources_validation", {})
    erp_reusable = (
        all(source_reusable(state, name, path) for name, path in erp_paths.items())
        and erp_validation_stage.get("status") == "complete"
        and erp_validation_stage.get("result", {}).get("validationVersion")
        == ERP_SOURCE_VALIDATION_VERSION
    )
    if erp_reusable:
        erp_validation = state["stages"]["erp_sources_validation"]["result"]
    else:
        command = [
            sys.executable,
            str(SCRIPT_DIR / "validate_erp_step2_exports.py"),
            "--tracking", str(args.tracking),
            "--products", str(args.products),
            "--fresh-after", str(erp_fresh_after),
        ]
        if args.platform:
            command.extend(["--platform", str(args.platform), "--sales", str(args.sales)])
        try:
            erp_validation = run_json(command)
            erp_validation["validationVersion"] = ERP_SOURCE_VALIDATION_VERSION
            for name, path in erp_paths.items():
                run_state.record_source(
                    state, name, path, "erp", "validated", erp_validation["exports"].get(name)
                )
            run_state.set_stage(state, "erp_sources_validation", "complete", list(erp_paths.values()), erp_validation)
            run_state.save_state(state_file, state)
        except Exception as error:
            run_state.set_stage(state, "erp_sources_validation", "failed", error=str(error))
            run_state.save_state(state_file, state)
            raise

    bi_validation_stage = state.get("stages", {}).get("bi_source_validation", {})
    bi_reusable = (
        source_reusable(state, "bi", args.bi)
        and bi_validation_stage.get("status") == "complete"
        and bi_validation_stage.get("result", {}).get("validationVersion")
        == BI_SOURCE_VALIDATION_VERSION
    )
    if bi_reusable:
        bi_validation = state["stages"]["bi_source_validation"]["result"]
    else:
        try:
            bi_validation = run_json([
                sys.executable,
                str(SCRIPT_DIR / "update_overseas_intransit.py"),
                "--operations", str(args.workbook),
                "--bi", str(args.bi),
                "--today", args.today.isoformat(),
                "--fresh-after", str(bi_fresh_after),
            ])
            bi_validation["validationVersion"] = BI_SOURCE_VALIDATION_VERSION
            run_state.record_source(state, "bi", args.bi, "bi", "validated", bi_validation)
            run_state.set_stage(state, "bi_source_validation", "complete", [args.bi], bi_validation)
            run_state.save_state(state_file, state)
        except Exception as error:
            run_state.set_stage(state, "bi_source_validation", "failed", error=str(error))
            run_state.save_state(state_file, state)
            raise
    return {
        "erp": erp_validation,
        "bi": bi_validation,
        "reused": {"erp": erp_reusable, "bi": bi_reusable},
    }


def safe_deliver(source: Path, destination: Path, allow_replace: bool, run_dir: Path) -> dict:
    destination = destination.resolve()
    source = source.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and same_file_content(source, destination):
        return {"path": str(destination), "reused": True, "backup": None}
    backup = None
    if destination.exists():
        if not allow_replace:
            raise ValueError(f"输出文件已存在，未获准覆盖：{destination}")
        backup_dir = run_dir / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = backup_dir / f"{destination.stem}-{stamp}{destination.suffix}.bak"
        shutil.copy2(destination, backup)
    temp = destination.parent / f".{destination.stem}.{os.getpid()}.tmp{destination.suffix}"
    try:
        shutil.copy2(source, temp)
        run_state.workbook_integrity(temp)
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)
    return {"path": str(destination), "reused": False, "backup": str(backup) if backup else None}


def main() -> int:
    args = build_parser().parse_args()
    if bool(args.platform) != bool(args.sales):
        raise ValueError("--platform and --sales must be provided together or both omitted")

    args.run_dir = args.run_dir.resolve()
    args.run_dir.mkdir(parents=True, exist_ok=True)
    state_file = (args.state_file or (args.run_dir / "run-state.json")).resolve()
    state = run_state.load_state(state_file, args.run_dir)

    source_configuration = {
        "tracking": str(args.tracking.resolve()),
        "products": str(args.products.resolve()),
        "platform": str(args.platform.resolve()) if args.platform else None,
        "sales": str(args.sales.resolve()) if args.sales else None,
        "bi": str(args.bi.resolve()),
    }
    saved_configuration = state.get("inputs", {}).get("sourceConfiguration")
    if saved_configuration and saved_configuration != source_configuration:
        raise ValueError("续跑的数据源路径与状态清单不一致；新数据源必须使用新的 --run-dir")
    state["inputs"]["sourceConfiguration"] = source_configuration

    saved_today = state.get("parameters", {}).get("today")
    if saved_today:
        args.today = dt.date.fromisoformat(saved_today)
    else:
        state.setdefault("parameters", {})["today"] = args.today.isoformat()

    workbook_fingerprint = run_state.fingerprint(args.workbook)
    saved_workbook = state.get("inputs", {}).get("workbook")
    if saved_workbook and (
        saved_workbook.get("path") != workbook_fingerprint["path"]
        or saved_workbook.get("sha256") != workbook_fingerprint["sha256"]
    ):
        delivered_path = state.get("delivery", {}).get("workbook", {}).get("path")
        replacing_completed_input = (
            state.get("status") == "complete"
            and delivered_path == workbook_fingerprint["path"]
            and state["delivery"]["workbook"]["fingerprint"].get("sha256") == workbook_fingerprint["sha256"]
        )
        if not replacing_completed_input:
            raise ValueError("运行状态属于另一份基表；请使用新的 --run-dir 开始新一轮更新")
    state["inputs"]["workbook"] = workbook_fingerprint

    erp_fresh_after = state.get("freshness", {}).get("erp") or args.erp_fresh_after
    bi_fresh_after = state.get("freshness", {}).get("bi") or args.bi_fresh_after
    if erp_fresh_after is None or bi_fresh_after is None:
        raise ValueError("首次运行必须提供 --erp-fresh-after 和 --bi-fresh-after；续跑沿用状态清单中的原始时间")
    state["freshness"]["erp"] = erp_fresh_after
    state["freshness"]["bi"] = bi_fresh_after
    state["status"] = "in_progress"
    run_state.save_state(state_file, state)

    source_validation = validate_sources(args, state, state_file, erp_fresh_after, bi_fresh_after)
    if not source_validation["reused"]["erp"]:
        for name in ("erp_processing", "bi_processing", "final_verification", "delivery"):
            if name in state["stages"]:
                state["stages"][name]["status"] = "invalidated"
                state["stages"][name]["error"] = "ERP source validation was refreshed"
    elif not source_validation["reused"]["bi"]:
        for name in ("bi_processing", "final_verification", "delivery"):
            if name in state["stages"]:
                state["stages"][name]["status"] = "invalidated"
                state["stages"][name]["error"] = "BI source validation was refreshed"
    run_state.save_state(state_file, state)
    stages_dir = args.run_dir / "stages"
    stages_dir.mkdir(parents=True, exist_ok=True)
    erp_output = stages_dir / "erp-step2.xlsx"
    cleaned_stage = stages_dir / "cleaned-bi.xlsx"
    final_candidate = stages_dir / "final-candidate.xlsx"

    if run_state.stage_reusable(state, "erp_processing", [erp_output]):
        erp_result = state["stages"]["erp_processing"]["result"]
        erp_reused = True
    else:
        archive_failed_stage(erp_output, args.run_dir)
        erp_command = [
            sys.executable,
            str(SCRIPT_DIR / "update_erp_step2.py"),
            "--workbook", str(args.workbook),
            "--tracking", str(args.tracking),
            "--products", str(args.products),
            "--output", str(erp_output),
            "--fresh-after", str(erp_fresh_after),
        ]
        if args.platform:
            erp_command.extend(["--platform", str(args.platform), "--sales", str(args.sales)])
        try:
            erp_result = run_json(erp_command)
            run_state.set_stage(state, "erp_processing", "complete", [erp_output], erp_result)
            run_state.save_state(state_file, state)
            erp_reused = False
        except Exception as error:
            run_state.set_stage(state, "erp_processing", "failed", [erp_output], error=str(error))
            run_state.save_state(state_file, state)
            raise

    if run_state.stage_reusable(state, "bi_processing", [cleaned_stage, final_candidate]):
        bi_result = state["stages"]["bi_processing"]["result"]
        bi_reused = True
    else:
        archive_failed_stage(cleaned_stage, args.run_dir)
        archive_failed_stage(final_candidate, args.run_dir)
        try:
            bi_result = run_json([
                sys.executable,
                str(SCRIPT_DIR / "update_overseas_intransit.py"),
                "--operations", str(erp_output),
                "--bi", str(args.bi),
                "--cleaned-bi-output", str(cleaned_stage),
                "--output", str(final_candidate),
                "--today", args.today.isoformat(),
                "--fresh-after", str(bi_fresh_after),
            ])
            run_state.set_stage(state, "bi_processing", "complete", [cleaned_stage, final_candidate], bi_result)
            run_state.save_state(state_file, state)
            bi_reused = False
        except Exception as error:
            run_state.set_stage(state, "bi_processing", "failed", [cleaned_stage, final_candidate], error=str(error))
            run_state.save_state(state_file, state)
            raise

    try:
        verify_result = run_json([
            sys.executable,
            str(SCRIPT_DIR / "verify_overseas_output.py"),
            "--input", str(erp_output),
            "--cleaned-bi", str(cleaned_stage),
            "--output", str(final_candidate),
        ])
        run_state.set_stage(state, "final_verification", "complete", [cleaned_stage, final_candidate], verify_result)
        run_state.save_state(state_file, state)
    except Exception as error:
        run_state.set_stage(state, "final_verification", "failed", [cleaned_stage, final_candidate], error=str(error))
        run_state.save_state(state_file, state)
        raise

    output_is_workbook = args.output.resolve() == args.workbook.resolve()
    if output_is_workbook and not args.replace_workbook:
        raise ValueError("--output 与基表相同；必须显式提供 --replace-workbook 才能在验收后安全覆盖")
    cleaned_delivery = safe_deliver(cleaned_stage, args.cleaned_bi_output, args.replace_existing_output, args.run_dir)
    output_delivery = safe_deliver(
        final_candidate,
        args.output,
        args.replace_workbook if output_is_workbook else args.replace_existing_output,
        args.run_dir,
    )
    state["delivery"] = {
        "workbook": {**output_delivery, "fingerprint": run_state.fingerprint(args.output)},
        "cleanedBi": {**cleaned_delivery, "fingerprint": run_state.fingerprint(args.cleaned_bi_output)},
        "completedAt": run_state.utc_now(),
    }
    state["status"] = "complete"
    run_state.set_stage(state, "delivery", "complete", [args.output, args.cleaned_bi_output], state["delivery"])
    run_state.save_state(state_file, state)

    print(json.dumps({
        "output": str(args.output.resolve()),
        "cleanedBiOutput": str(args.cleaned_bi_output.resolve()),
        "runDirectory": str(args.run_dir),
        "stateFile": str(state_file),
        "processingOrder": ["ERP Step2", "BI Step1 arrival matching"],
        "resumed": {"erpProcessing": erp_reused, "biProcessing": bi_reused},
        "sourceValidation": source_validation,
        "erp": erp_result,
        "bi": bi_result,
        "verification": verify_result,
        "delivery": state["delivery"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
