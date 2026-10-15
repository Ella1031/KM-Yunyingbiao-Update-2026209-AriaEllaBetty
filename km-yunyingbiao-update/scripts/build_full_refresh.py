#!/usr/bin/env python3
"""Build a complete KM workbook in dependency-safe order.

The external workflow remains BI Step1 followed by ERP Step2 for downloads and
authentication. Workbook processing must run ERP first so launch months and new
SKUs exist before the BI arrival matcher evaluates eligibility.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent


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
    parser.add_argument("--erp-fresh-after", required=True, type=float)
    parser.add_argument("--bi-fresh-after", required=True, type=float)
    parser.add_argument("--today", type=dt.date.fromisoformat, default=dt.date.today())
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if bool(args.platform) != bool(args.sales):
        raise ValueError("--platform and --sales must be provided together or both omitted")
    if args.output.exists() or args.cleaned_bi_output.exists():
        raise ValueError("Output paths must not already exist")

    with tempfile.TemporaryDirectory(prefix="km-full-refresh-") as temp_dir:
        erp_output = Path(temp_dir) / "erp-step2.xlsx"
        erp_command = [
            sys.executable,
            str(SCRIPT_DIR / "update_erp_step2.py"),
            "--workbook", str(args.workbook),
            "--tracking", str(args.tracking),
            "--products", str(args.products),
            "--output", str(erp_output),
            "--fresh-after", str(args.erp_fresh_after),
        ]
        if args.platform:
            erp_command.extend(["--platform", str(args.platform), "--sales", str(args.sales)])
        erp_result = run_json(erp_command)

        bi_result = run_json([
            sys.executable,
            str(SCRIPT_DIR / "update_overseas_intransit.py"),
            "--operations", str(erp_output),
            "--bi", str(args.bi),
            "--cleaned-bi-output", str(args.cleaned_bi_output),
            "--output", str(args.output),
            "--today", args.today.isoformat(),
            "--fresh-after", str(args.bi_fresh_after),
        ])
        verify_result = run_json([
            sys.executable,
            str(SCRIPT_DIR / "verify_overseas_output.py"),
            "--input", str(erp_output),
            "--cleaned-bi", str(args.cleaned_bi_output),
            "--output", str(args.output),
        ])

    print(json.dumps({
        "output": str(args.output.resolve()),
        "processing_order": ["ERP Step2", "BI Step1 arrival matching"],
        "erp": erp_result,
        "bi": bi_result,
        "verification": verify_result,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
