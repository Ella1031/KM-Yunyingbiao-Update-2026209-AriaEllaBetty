#!/usr/bin/env python3
"""Apply a fresh ERP tracking export to a KM operations workbook.

The script edits XLSX package XML directly so unrelated workbook parts remain
unchanged. It replaces the 新品成功率 source sheet, updates matching 产品表 rows,
and appends eligible 2026+ platform SKUs without overwriting either input.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import re
import sys
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

import update_overseas_intransit as xlsx


TARGET_SHEET_NAME = "新品成功率"
OPS_SHEET_NAME = "产品表"
ALLOWED_SUBJECTS = {"KM一部一组", "KM一部二组", "KM一部三组"}
REQUIRED_BRAND = "Kemimoto"
SOURCE_FIELDS = (
    "SKU",
    "平台SKU",
    "主体",
    "预计开售时间",
    "新品期截止月",
    "预测销量完成比例",
    "公司品牌",
)
OPS_FIELDS = ("平台SKU", "仓库SKU", "新品期开售月", "新品期截止月", "最新新品成功率")
TRACKING_TARGETS = {
    "新品期开售月": "预计开售时间",
    "新品期截止月": "新品期截止月",
    "最新新品成功率": "预测销量完成比例",
}
FORMULA_ERROR_VALUES = {"#REF!", "#VALUE!", "#N/A", "#DIV/0!", "#NAME?", "#NUM!"}
CELL_REF_IN_FORMULA = re.compile(
    r"(?<![A-Z0-9_])(?P<col>\$?[A-Z]{1,3})(?P<row_abs>\$?)(?P<row>\d+)"
)


def normalized(value: str) -> str:
    return re.sub(r"\s+", "", value or "")


def source_sheet(parts: dict[str, bytes]) -> tuple[ET.Element, str, str]:
    _, _, sheets = xlsx.workbook_sheets(parts)
    if len(sheets) != 1:
        raise ValueError(f"Expected one worksheet in tracking export, found {len(sheets)}")
    name, _, part_name = sheets[0]
    relationship_part = f"xl/worksheets/_rels/{Path(part_name).name}.rels"
    if relationship_part in parts:
        raise ValueError("Tracking worksheet has related objects that cannot be copied safely")
    sheet = ET.fromstring(parts[part_name])
    strings = xlsx.shared_strings(parts)
    for cell in sheet.iter(xlsx.M + "c"):
        if cell.attrib.get("t") != "s":
            continue
        value = cell.find(xlsx.M + "v")
        text = "" if value is None or value.text is None else strings[int(value.text)]
        xlsx.set_inline_string(cell, text)
    rows = xlsx.rows_by_number(sheet)
    max_row = max(rows, default=1)
    max_col = max(
        (
            xlsx.split_ref(cell.attrib["r"])[0]
            for row in rows.values()
            for cell in row.findall(xlsx.M + "c")
        ),
        default=1,
    )
    dimension = sheet.find(xlsx.M + "dimension")
    if dimension is not None:
        dimension.attrib["ref"] = f"A1:{xlsx.col_letters(max_col)}{max_row}"
    return sheet, name, part_name


def find_headers(
    sheet: ET.Element,
    required: tuple[str, ...],
    strings: list[str],
    preferred_row: int | None = None,
) -> tuple[int, dict[str, int]]:
    rows = xlsx.rows_by_number(sheet)
    candidates = [preferred_row] if preferred_row is not None else sorted(rows)
    for row_number in candidates:
        row = rows.get(row_number)
        if row is None:
            continue
        columns = {
            normalized(xlsx.cell_text(cell, strings)): column
            for column, cell in xlsx.row_cells(row).items()
            if normalized(xlsx.cell_text(cell, strings))
        }
        if all(normalized(name) in columns for name in required):
            return row_number, {name: columns[normalized(name)] for name in required}
    raise ValueError("Worksheet is missing required columns: " + ", ".join(required))


def tracking_records(sheet: ET.Element) -> tuple[list[dict[str, str]], dict]:
    header_row, columns = find_headers(sheet, SOURCE_FIELDS, [])
    rows = xlsx.rows_by_number(sheet)
    subjects: set[str] = set()
    brands: set[str] = set()
    records: list[dict[str, str]] = []
    for row_number in sorted(rows):
        if row_number <= header_row:
            continue
        cells = xlsx.row_cells(rows[row_number])
        record = {
            name: xlsx.cell_text(cells.get(columns[name]), []).strip()
            for name in SOURCE_FIELDS
        }
        if not any(record.values()):
            continue
        records.append(record)
        if record["主体"]:
            subjects.add(record["主体"])
        if record["公司品牌"]:
            brands.add(record["公司品牌"])

    if subjects != ALLOWED_SUBJECTS:
        missing = ALLOWED_SUBJECTS - subjects
        unexpected = subjects - ALLOWED_SUBJECTS
        details = []
        if missing:
            details.append("missing " + ", ".join(sorted(missing)))
        if unexpected:
            details.append("unexpected " + ", ".join(sorted(unexpected)))
        raise ValueError("Tracking export 主体 selection is not exact: " + "; ".join(details))
    if brands != {REQUIRED_BRAND}:
        raise ValueError(
            "Tracking export 品牌 selection is not exactly Kemimoto: "
            + ", ".join(sorted(brands))
        )

    cell_count = sum(len(row.findall(xlsx.M + "c")) for row in rows.values())
    formula_count = len(sheet.findall(".//" + xlsx.M + "f"))
    return records, {
        "header_row": header_row,
        "data_rows": len(records),
        "subjects": sorted(subjects),
        "brands": sorted(brands),
        "worksheet_rows": len(rows),
        "worksheet_cells": cell_count,
        "worksheet_formulas": formula_count,
    }


def deduplicate_records(
    records: list[dict[str, str]],
) -> tuple[dict[str, dict[str, str]], int, int]:
    result: dict[str, dict[str, str]] = {}
    duplicate_rows = 0
    blank_keys = 0
    for record in records:
        key = record["平台SKU"].strip()
        if not key:
            blank_keys += 1
            continue
        if key in result:
            duplicate_rows += 1
            continue
        result[key] = record
    return result, duplicate_rows, blank_keys


def validate_paths(
    operations: Path,
    tracking: Path,
    output: Path | None,
    fresh_after: float,
) -> None:
    for label, path in (("Operations", operations), ("Tracking", tracking)):
        if not path.is_file():
            raise ValueError(f"{label} workbook does not exist: {path}")
        if path.suffix.lower() != ".xlsx":
            raise ValueError(f"{label} workbook must be .xlsx: {path}")
    if tracking.stat().st_mtime < fresh_after:
        raise ValueError(f"Tracking input was not downloaded during this run: {tracking}")
    if output is not None:
        if output.resolve() in {operations.resolve(), tracking.resolve()}:
            raise ValueError("Output must not overwrite either input workbook")
        if output.exists():
            raise ValueError(f"Output already exists: {output}")


def operations_sheet(
    parts: dict[str, bytes],
) -> tuple[ET.Element, str, list[str], dict[str, int]]:
    matches = [
        item for item in xlsx.workbook_sheets(parts)[2] if item[0] == OPS_SHEET_NAME
    ]
    if len(matches) != 1:
        raise ValueError(
            f"Expected exactly one {OPS_SHEET_NAME} worksheet, found {len(matches)}"
        )
    _, _, part_name = matches[0]
    sheet = ET.fromstring(parts[part_name])
    strings = xlsx.shared_strings(parts)
    _, columns = find_headers(sheet, OPS_FIELDS, strings, 2)
    return sheet, part_name, strings, columns


def clear_cell(cell: ET.Element) -> None:
    for child in list(cell):
        cell.remove(child)
    cell.attrib.pop("t", None)


def set_text(cell: ET.Element, value: str) -> None:
    if value == "":
        clear_cell(cell)
    else:
        xlsx.set_inline_string(cell, value)


def translated_formula(formula: str, row_delta: int) -> str:
    def replace(match: re.Match[str]) -> str:
        if match.group("row_abs"):
            return match.group(0)
        return f"{match.group('col')}{int(match.group('row')) + row_delta}"

    return CELL_REF_IN_FORMULA.sub(replace, formula)


def blank_row_from_template(
    template: ET.Element,
    target_row: int,
) -> tuple[ET.Element, int]:
    source_row = int(template.attrib["r"])
    row_delta = target_row - source_row
    clone = copy.deepcopy(template)
    clone.attrib["r"] = str(target_row)
    translated = 0
    for cell in clone.findall(xlsx.M + "c"):
        column, _ = xlsx.split_ref(cell.attrib["r"])
        cell.attrib["r"] = f"{xlsx.col_letters(column)}{target_row}"
        formula = cell.find(xlsx.M + "f")
        if formula is not None:
            formula.text = translated_formula(formula.text or "", row_delta)
            value = cell.find(xlsx.M + "v")
            if value is not None:
                cell.remove(value)
            translated += 1
        else:
            clear_cell(cell)
    return clone, translated


def replace_or_insert_row(sheet: ET.Element, row: ET.Element) -> None:
    sheet_data = sheet.find(xlsx.M + "sheetData")
    if sheet_data is None:
        raise ValueError("Worksheet has no sheetData")
    target = int(row.attrib["r"])
    existing_rows = sheet_data.findall(xlsx.M + "row")
    for index, existing in enumerate(existing_rows):
        current = int(existing.attrib["r"])
        if current == target:
            sheet_data.remove(existing)
            sheet_data.insert(index, row)
            return
        if current > target:
            sheet_data.insert(index, row)
            return
    sheet_data.append(row)


def add_yellow_style(styles_data: bytes, base_style_id: int) -> tuple[bytes, int]:
    root = ET.fromstring(styles_data)
    fills = root.find(xlsx.M + "fills")
    cell_xfs = root.find(xlsx.M + "cellXfs")
    if fills is None or cell_xfs is None:
        raise ValueError("Workbook styles.xml is missing fills or cellXfs")
    if base_style_id >= len(cell_xfs):
        raise ValueError(f"Invalid base style ID: {base_style_id}")

    fill = ET.Element(xlsx.M + "fill")
    pattern = ET.SubElement(fill, xlsx.M + "patternFill", {"patternType": "solid"})
    ET.SubElement(pattern, xlsx.M + "fgColor", {"rgb": "FFFFFF00"})
    ET.SubElement(pattern, xlsx.M + "bgColor", {"indexed": "64"})
    fills.append(fill)
    fills.attrib["count"] = str(len(fills))

    style = copy.deepcopy(cell_xfs[base_style_id])
    style.attrib["fillId"] = str(len(fills) - 1)
    style.attrib["applyFill"] = "1"
    cell_xfs.append(style)
    cell_xfs.attrib["count"] = str(len(cell_xfs))
    return xlsx.xml_bytes(root), len(cell_xfs) - 1


def formula_errors(sheet: ET.Element) -> set[str]:
    errors = set()
    for cell in sheet.iter(xlsx.M + "c"):
        if cell.attrib.get("t") != "e":
            continue
        value = cell.find(xlsx.M + "v")
        if value is not None and value.text in FORMULA_ERROR_VALUES:
            errors.add(f"{cell.attrib.get('r')}:{value.text}")
    return errors


def update_operations(
    sheet: ET.Element,
    strings: list[str],
    columns: dict[str, int],
    records: dict[str, dict[str, str]],
    styles_data: bytes,
) -> tuple[bytes, dict]:
    rows = xlsx.rows_by_number(sheet)
    existing_by_key: dict[str, list[int]] = defaultdict(list)
    last_data_row = 2
    for row_number in sorted(rows):
        if row_number < 3:
            continue
        cells = xlsx.row_cells(rows[row_number])
        if any(
            xlsx.cell_text(cell, strings).strip()
            or cell.find(xlsx.M + "f") is not None
            for cell in cells.values()
        ):
            last_data_row = row_number
        key = xlsx.cell_text(cells.get(columns["平台SKU"]), strings).strip()
        if key:
            existing_by_key[key].append(row_number)
    if last_data_row < 3:
        raise ValueError("产品表 contains no template data row")

    preexisting_errors = formula_errors(sheet)
    matched_keys = set(records) & set(existing_by_key)
    updated_rows = 0
    for key in sorted(matched_keys):
        source = records[key]
        for row_number in existing_by_key[key]:
            row = rows[row_number]
            cells = xlsx.row_cells(row)
            for target, source_name in TRACKING_TARGETS.items():
                style_from = cells.get(columns[target])
                cell = xlsx.get_or_create_cell(row, columns[target], style_from)
                set_text(cell, source[source_name])
            updated_rows += 1

    eligible: list[tuple[str, dict[str, str]]] = []
    for key, source in records.items():
        if key in existing_by_key:
            continue
        launch = xlsx.parse_date(source["预计开售时间"])
        if launch is None or launch < dt.date(2026, 1, 1):
            continue
        eligible.append((key, source))

    template = rows[last_data_row]
    template_cells = xlsx.row_cells(template)
    platform_template = template_cells.get(columns["平台SKU"])
    if platform_template is None:
        raise ValueError("产品表 template row has no 平台SKU cell")
    base_style_id = int(platform_template.attrib.get("s", "0"))
    styles_data, yellow_style_id = add_yellow_style(styles_data, base_style_id)

    translated_formulas = 0
    appended_rows: list[int] = []
    appended_keys: list[str] = []
    for offset, (key, source) in enumerate(eligible, start=1):
        row_number = last_data_row + offset
        row, translated = blank_row_from_template(template, row_number)
        translated_formulas += translated
        platform_cell = xlsx.get_or_create_cell(
            row, columns["平台SKU"], template_cells.get(columns["平台SKU"])
        )
        set_text(platform_cell, key)
        platform_cell.attrib["s"] = str(yellow_style_id)
        warehouse_cell = xlsx.get_or_create_cell(
            row, columns["仓库SKU"], template_cells.get(columns["仓库SKU"])
        )
        set_text(warehouse_cell, source["SKU"])
        for target, source_name in TRACKING_TARGETS.items():
            target_cell = xlsx.get_or_create_cell(
                row, columns[target], template_cells.get(columns[target])
            )
            set_text(target_cell, source[source_name])
        replace_or_insert_row(sheet, row)
        appended_rows.append(row_number)
        appended_keys.append(key)

    final_row = last_data_row + len(eligible)
    current_rows = xlsx.rows_by_number(sheet)
    dimension = sheet.find(xlsx.M + "dimension")
    if dimension is not None:
        max_col = max(
            xlsx.split_ref(cell.attrib["r"])[0]
            for row in current_rows.values()
            for cell in row.findall(xlsx.M + "c")
        )
        dimension.attrib["ref"] = (
            f"A1:{xlsx.col_letters(max_col)}{max(final_row, max(current_rows, default=1))}"
        )
    auto_filter = sheet.find(xlsx.M + "autoFilter")
    if auto_filter is not None and "ref" in auto_filter.attrib:
        ref = auto_filter.attrib["ref"]
        match = re.fullmatch(r"([A-Z]+\d+):([A-Z]+)\d+", ref)
        if match:
            auto_filter.attrib["ref"] = (
                f"{match.group(1)}:{match.group(2)}{final_row}"
            )

    new_errors = sorted(formula_errors(sheet) - preexisting_errors)
    if new_errors:
        raise AssertionError(
            "Update introduced formula errors: " + ", ".join(new_errors[:20])
        )

    current_rows = xlsx.rows_by_number(sheet)
    yellow_cells = []
    blank_appended = 0
    for row_number in appended_rows:
        cells = xlsx.row_cells(current_rows[row_number])
        platform_cell = cells.get(columns["平台SKU"])
        if (
            platform_cell is not None
            and platform_cell.attrib.get("s") == str(yellow_style_id)
        ):
            yellow_cells.append(platform_cell.attrib["r"])
        if not xlsx.cell_text(platform_cell, []).strip():
            blank_appended += 1
    all_new_style_cells = [
        cell.attrib["r"]
        for row in current_rows.values()
        for cell in row.findall(xlsx.M + "c")
        if cell.attrib.get("s") == str(yellow_style_id)
    ]
    if len(yellow_cells) != len(appended_rows) or sorted(all_new_style_cells) != sorted(
        yellow_cells
    ):
        raise AssertionError(
            "Yellow fill was not limited to newly appended 平台SKU cells"
        )
    if blank_appended:
        raise AssertionError(f"Append area contains {blank_appended} blank rows")

    duplicate_operation_keys = sum(
        1 for row_numbers in existing_by_key.values() if len(row_numbers) > 1
    )
    return styles_data, {
        "source_unique_platform_skus": len(records),
        "existing_operation_platform_skus": len(existing_by_key),
        "existing_operation_duplicate_keys": duplicate_operation_keys,
        "matched_platform_skus": len(matched_keys),
        "matched_operation_rows_updated": updated_rows,
        "unmatched_operation_skus": len(set(existing_by_key) - set(records)),
        "eligible_new_platform_skus": len(eligible),
        "appended_rows": len(appended_rows),
        "appended_row_start": appended_rows[0] if appended_rows else None,
        "appended_row_end": appended_rows[-1] if appended_rows else None,
        "blank_appended_rows": blank_appended,
        "yellow_platform_cells": len(yellow_cells),
        "translated_formulas": translated_formulas,
        "new_formula_errors": 0,
        "appended_keys": appended_keys,
    }


def plan_stats(
    operation_parts: dict[str, bytes],
    records: dict[str, dict[str, str]],
) -> dict:
    operation_sheet, _, strings, columns = operations_sheet(operation_parts)
    rows = xlsx.rows_by_number(operation_sheet)
    existing: dict[str, list[int]] = defaultdict(list)
    for row_number, row in rows.items():
        if row_number < 3:
            continue
        key = xlsx.cell_text(
            xlsx.row_cells(row).get(columns["平台SKU"]), strings
        ).strip()
        if key:
            existing[key].append(row_number)
    eligible = 0
    for key, record in records.items():
        launch = xlsx.parse_date(record["预计开售时间"])
        if (
            key not in existing
            and launch is not None
            and launch >= dt.date(2026, 1, 1)
        ):
            eligible += 1
    matched = set(records) & set(existing)
    return {
        "source_unique_platform_skus": len(records),
        "existing_operation_platform_skus": len(existing),
        "matched_platform_skus": len(matched),
        "matched_operation_rows_to_update": sum(len(existing[key]) for key in matched),
        "eligible_new_platform_skus": eligible,
        "unmatched_operation_skus": len(set(existing) - set(records)),
    }


def run(
    operations: Path,
    tracking: Path,
    output: Path | None,
    fresh_after: float,
) -> dict:
    validate_paths(operations, tracking, output, fresh_after)
    operation_parts = xlsx.load_package(operations)
    original_operation_parts = dict(operation_parts)
    tracking_parts = xlsx.load_package(tracking)
    source, source_name, _ = source_sheet(tracking_parts)
    source_rows, stats = tracking_records(source)
    unique_records, duplicate_source_rows, blank_source_keys = deduplicate_records(
        source_rows
    )
    plan = plan_stats(operation_parts, unique_records)
    common = {
        "source_sheet": source_name,
        "source_duplicate_platform_sku_rows": duplicate_source_rows,
        "source_blank_platform_sku_rows": blank_source_keys,
        **stats,
        **plan,
    }
    if output is None:
        return {"validated": True, **common}

    operation_parts["xl/styles.xml"], style_map = xlsx.merge_styles(
        operation_parts["xl/styles.xml"], tracking_parts["xl/styles.xml"]
    )
    xlsx.remap_sheet_styles(source, style_map)

    operation_sheet, operation_part, strings, columns = operations_sheet(
        operation_parts
    )
    operation_parts["xl/styles.xml"], update_stats = update_operations(
        operation_sheet,
        strings,
        columns,
        unique_records,
        operation_parts["xl/styles.xml"],
    )
    operation_parts[operation_part] = xlsx.xml_bytes(operation_sheet)

    xlsx.TARGET_SHEET_NAME = TARGET_SHEET_NAME
    xlsx.add_or_replace_sheet(operation_parts, copy.deepcopy(source))

    allowed_existing_changes = {
        "[Content_Types].xml",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        operation_part,
    }
    _, _, original_sheets = xlsx.workbook_sheets(original_operation_parts)
    existing_target = next(
        (item[2] for item in original_sheets if item[0] == TARGET_SHEET_NAME),
        None,
    )
    if existing_target:
        allowed_existing_changes.add(existing_target)
    changed_unrelated = [
        name
        for name, data in original_operation_parts.items()
        if name not in allowed_existing_changes and operation_parts.get(name) != data
    ]
    if changed_unrelated:
        raise AssertionError(
            "Unexpected workbook parts changed: " + ", ".join(changed_unrelated)
        )

    xlsx.write_package(output, operation_parts)
    with zipfile.ZipFile(output, "r") as archive:
        bad_file = archive.testzip()
        if bad_file:
            raise AssertionError(f"Corrupt XLSX output part: {bad_file}")

    output_parts = xlsx.load_package(output)
    _, _, output_sheets = xlsx.workbook_sheets(output_parts)
    output_target = next(
        (item for item in output_sheets if item[0] == TARGET_SHEET_NAME), None
    )
    if output_target is None:
        raise AssertionError(f"Output is missing worksheet: {TARGET_SHEET_NAME}")
    output_source = ET.fromstring(output_parts[output_target[2]])
    output_rows, output_stats = tracking_records(output_source)
    if output_stats != stats or output_rows != source_rows:
        raise AssertionError(
            "Output source worksheet does not match validated tracking export"
        )

    output_operation, _, output_strings, output_columns = operations_sheet(
        output_parts
    )
    output_operation_rows = xlsx.rows_by_number(output_operation)
    for key in update_stats["appended_keys"]:
        matches = [
            row_number
            for row_number, row in output_operation_rows.items()
            if row_number >= 3
            and xlsx.cell_text(
                xlsx.row_cells(row).get(output_columns["平台SKU"]), output_strings
            ).strip()
            == key
        ]
        if len(matches) != 1:
            raise AssertionError(
                f"Appended 平台SKU does not occur exactly once: {key}"
            )

    update_stats.pop("appended_keys")
    return {
        "output": str(output.resolve()),
        "target_sheet": TARGET_SHEET_NAME,
        "style_ids_remapped": len(style_map),
        "unrelated_existing_parts_changed": 0,
        **common,
        **update_stats,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operations", required=True, type=Path)
    parser.add_argument("--tracking", required=True, type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        help="Omit to validate and report the update plan without writing",
    )
    parser.add_argument("--fresh-after", required=True, type=float)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = run(
            args.operations,
            args.tracking,
            args.output,
            args.fresh_after,
        )
    except Exception as error:
        print(f"Tracking refresh failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
