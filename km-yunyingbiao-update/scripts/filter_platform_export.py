#!/usr/bin/env python3
"""Create the strict three-subject platform export used by Step2."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pandas as pd


ALLOWED_SUBJECTS = {"KM一部一组", "KM一部二组", "KM一部三组"}
SHEET_NAME = "平台SKU映射&备货"


def clean(value):
    return "" if value is None else str(value).strip()


def canonical_subject(value):
    text = clean(value)
    for subject in ALLOWED_SUBJECTS:
        pattern = rf"(?<![\u4e00-\u9fffA-Za-z0-9]){re.escape(subject)}(?![\u4e00-\u9fffA-Za-z0-9])"
        if re.search(pattern, text):
            return subject
    return ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if not args.input.is_file():
        raise ValueError(f"平台 SKU 原始导出不存在：{args.input}")
    if args.output.exists():
        raise ValueError(f"严格筛选输出已存在：{args.output}")
    if args.input.resolve() == args.output.resolve():
        raise ValueError("严格筛选输出不能覆盖原始导出")

    workbook = pd.ExcelFile(args.input)
    if SHEET_NAME not in workbook.sheet_names:
        raise ValueError(f"平台 SKU 导出缺少工作表：{SHEET_NAME}")
    first_row = pd.read_excel(args.input, sheet_name=SHEET_NAME, header=None, nrows=1, dtype=object)
    source = pd.read_excel(args.input, sheet_name=SHEET_NAME, header=1, dtype=object).fillna("")
    workbook.close()
    normalized_headers = {clean(column).replace(" ", "").replace("\n", ""): column for column in source.columns}
    if "主体" not in normalized_headers:
        raise ValueError("平台 SKU 导出未找到主体列")
    subject_column = normalized_headers["主体"]
    canonical = source[subject_column].map(canonical_subject)
    filtered = source.loc[canonical != ""].copy()
    subjects = sorted({value for value in canonical if value})
    if filtered.empty:
        raise ValueError("平台 SKU 原始导出没有三个指定主体的数据")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(args.output, engine="openpyxl") as writer:
        first_row.to_excel(writer, sheet_name=SHEET_NAME, header=False, index=False)
        filtered.to_excel(writer, sheet_name=SHEET_NAME, startrow=1, index=False)

    print(json.dumps({
        "rawPath": str(args.input.resolve()),
        "outputPath": str(args.output.resolve()),
        "rawRows": len(source),
        "filteredRows": len(filtered),
        "subjects": subjects,
        "allowedSubjects": sorted(ALLOWED_SUBJECTS),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
