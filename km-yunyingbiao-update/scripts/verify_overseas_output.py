#!/usr/bin/env python3
"""Verify a Step3 overseas in-transit output without modifying any workbook."""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import update_overseas_intransit as step3


def sheet_part(parts: dict[str, bytes], name: str) -> str:
    matches = [item[2] for item in step3.workbook_sheets(parts)[2] if item[0] == name]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one worksheet named {name!r}; found {len(matches)}")
    return matches[0]


def cells_by_ref(sheet: ET.Element) -> dict[str, ET.Element]:
    return {
        cell.attrib["r"]: cell
        for row in sheet3_rows(sheet).values()
        for cell in row.findall(step3.M + "c")
    }


def sheet3_rows(sheet: ET.Element) -> dict[int, ET.Element]:
    return step3.rows_by_number(sheet)


def product_headers(sheet: ET.Element, strings: list[str]) -> tuple[int, dict[str, int]]:
    required = {"平台SKU", "新品首批预计到货时间", "新品首批到货数量"}
    for row_number, row in sorted(sheet3_rows(sheet).items())[:10]:
        values = {
            step3.cell_text(cell, strings).replace("\n", "").strip(): col
            for col, cell in step3.row_cells(row).items()
        }
        if required.issubset(values):
            return row_number, values
    raise ValueError("Could not locate required product headers")


def verify(input_path: Path, cleaned_bi_path: Path, output_path: Path) -> dict:
    for path in (input_path, cleaned_bi_path, output_path):
        with zipfile.ZipFile(path, "r") as archive:
            bad = archive.testzip()
            if bad:
                raise AssertionError(f"Corrupt XLSX part in {path.name}: {bad}")

    source_parts = step3.load_package(input_path)
    clean_parts = step3.load_package(cleaned_bi_path)
    output_parts = step3.load_package(output_path)

    clean_sheets = step3.workbook_sheets(clean_parts)[2]
    if len(clean_sheets) != 1 or clean_sheets[0][0] != step3.TARGET_SHEET_NAME:
        raise AssertionError("Cleaned BI workbook does not contain only the horizontal worksheet")
    if "xl/sharedStrings.xml" in clean_parts:
        raise AssertionError("Cleaned BI workbook still contains shared strings from removed worksheets")

    clean_sheet = ET.fromstring(clean_parts[clean_sheets[0][2]])
    clean_strings = step3.shared_strings(clean_parts)
    clean_rows = sheet3_rows(clean_sheet)
    unexpected_subjects = {
        step3.cell_text(step3.row_cells(row).get(3), clean_strings).strip()
        for number, row in clean_rows.items()
        if number >= 3
        and step3.cell_text(step3.row_cells(row).get(3), clean_strings).strip()
        and step3.cell_text(step3.row_cells(row).get(3), clean_strings).strip() not in step3.ALLOWED_SUBJECTS
    }
    if unexpected_subjects:
        raise AssertionError("Unexpected BI subjects: " + ", ".join(sorted(unexpected_subjects)))

    output_bi_part = sheet_part(output_parts, step3.TARGET_SHEET_NAME)
    output_bi = ET.fromstring(output_parts[output_bi_part])
    output_strings = step3.shared_strings(output_parts)
    output_bi_rows = sheet3_rows(output_bi)
    if step3.cell_text(step3.row_cells(output_bi_rows[2]).get(6), output_strings).strip() != "平台SKU":
        raise AssertionError("Processed BI worksheet is missing the inserted F2 platform-SKU header")

    source_product_part = sheet_part(source_parts, step3.OPS_SHEET_NAME)
    output_product_part = sheet_part(output_parts, step3.OPS_SHEET_NAME)
    source_product = ET.fromstring(source_parts[source_product_part])
    output_product = ET.fromstring(output_parts[output_product_part])
    source_strings = step3.shared_strings(source_parts)
    header_row, headers = product_headers(source_product, source_strings)
    target_cols = {
        headers["新品首批预计到货时间"],
        headers["新品首批到货数量"],
    }
    source_cells = cells_by_ref(source_product)
    output_cells = cells_by_ref(output_product)
    changed_by_col = {col: 0 for col in target_cols}
    for ref in sorted(set(source_cells) | set(output_cells)):
        col, row = step3.split_ref(ref)
        before = source_cells.get(ref)
        after = output_cells.get(ref)
        before_signature = step3.cell_signature(before) if before is not None else None
        after_signature = step3.cell_signature(after) if after is not None else None
        if col not in target_cols:
            if before_signature != after_signature:
                raise AssertionError(f"Product worksheet changed outside permitted columns: {ref}")
            continue
        if row <= header_row:
            if step3.cell_signature(before) != step3.cell_signature(after):
                raise AssertionError(f"Product header changed unexpectedly: {ref}")
            continue
        before_blank = before is None or step3.cell_is_blank(before, source_strings)
        after_blank = after is None or step3.cell_is_blank(after, output_strings)
        if before_signature != after_signature:
            if not before_blank or after_blank:
                raise AssertionError(f"Invalid overwrite in permitted product column: {ref}")
            changed_by_col[col] += 1

    allowed_parts = {
        "[Content_Types].xml",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        source_product_part,
    }
    source_bi_matches = [
        item[2]
        for item in step3.workbook_sheets(source_parts)[2]
        if item[0] == step3.TARGET_SHEET_NAME
    ]
    if len(source_bi_matches) > 1:
        raise AssertionError("Input contains duplicate horizontal BI worksheets")
    if source_bi_matches:
        allowed_parts.add(source_bi_matches[0])
    unrelated_changes = [
        name for name, data in source_parts.items()
        if name not in allowed_parts and output_parts.get(name) != data
    ]
    if unrelated_changes:
        raise AssertionError("Unrelated existing package parts changed: " + ", ".join(unrelated_changes))

    return {
        "validated": True,
        "cleaned_bi_sheet_count": len(clean_sheets),
        "cleaned_bi_rows": len(clean_rows),
        "output_bi_rows": len(output_bi_rows),
        "allowed_subjects": sorted(step3.ALLOWED_SUBJECTS),
        "arrival_date_cells_added": changed_by_col[headers["新品首批预计到货时间"]],
        "arrival_quantity_cells_added": changed_by_col[headers["新品首批到货数量"]],
        "unrelated_existing_parts_changed": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--cleaned-bi", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.input, args.cleaned_bi, args.output)
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
