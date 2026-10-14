#!/usr/bin/env python3
"""Apply a fresh ERP product archive export to a KM operations workbook."""

from __future__ import annotations

import argparse
import copy
import json
import sys
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

import add_tracking_source_sheet as tracking
import update_overseas_intransit as xlsx


TARGET_SHEET_NAME = "ERP产品档案"
OPS_SHEET_NAME = "产品表"
SOURCE_FIELDS = (
    "产品SKU",
    "产品名称",
    "三级品类",
    "品类等级",
    "产品销售状态",
    "产品实际等级",
    "产品目标等级",
)
OPS_FIELDS = ("仓库SKU", "产品名称", "三级品类", "产品销售状态", "品类等级")
PRODUCT_TARGETS = {
    "产品名称": "产品名称",
    "三级品类": "三级品类",
    "产品销售状态": "产品销售状态",
    "品类等级": "产品实际等级",
}


def product_source_sheet(
    parts: dict[str, bytes],
) -> tuple[ET.Element, str, str]:
    _, _, sheets = xlsx.workbook_sheets(parts)
    if len(sheets) != 1:
        raise ValueError(
            f"Expected one worksheet in product export, found {len(sheets)}"
        )
    _, _, part_name = sheets[0]
    relationship_part = f"xl/worksheets/_rels/{Path(part_name).name}.rels"
    safe_parts = dict(parts)
    if relationship_part in parts:
        relationships = ET.fromstring(parts[relationship_part])
        allowed_types = {"drawing", "comments", "vmlDrawing"}
        unexpected = [
            relationship.attrib.get("Type", "")
            for relationship in relationships
            if relationship.attrib.get("Type", "").rsplit("/", 1)[-1]
            not in allowed_types
        ]
        if unexpected:
            raise ValueError(
                "Product worksheet has unsupported related objects: "
                + ", ".join(unexpected)
            )
        del safe_parts[relationship_part]

    sheet, name, source_part = tracking.source_sheet(safe_parts)
    for tag in ("drawing", "legacyDrawing", "legacyDrawingHF", "picture"):
        for element in list(sheet.findall(xlsx.M + tag)):
            sheet.remove(element)
    return sheet, name, source_part


def product_records(sheet: ET.Element) -> tuple[list[dict[str, str]], dict]:
    header_row, columns = tracking.find_headers(sheet, SOURCE_FIELDS, [])
    rows = xlsx.rows_by_number(sheet)
    records: list[dict[str, str]] = []
    brand_column = None
    header_cells = xlsx.row_cells(rows[header_row])
    for column, cell in header_cells.items():
        value = tracking.normalized(xlsx.cell_text(cell, []))
        if value in {"品牌", "公司品牌"}:
            brand_column = column
            break
    brands: set[str] = set()
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
        if brand_column is not None:
            brand = xlsx.cell_text(cells.get(brand_column), []).strip()
            if brand:
                brands.add(brand)
    if brand_column is not None and brands != {"Kemimoto"}:
        raise ValueError(
            "Product archive 品牌 selection is not exactly Kemimoto: "
            + ", ".join(sorted(brands))
        )
    return records, {
        "header_row": header_row,
        "data_rows": len(records),
        "worksheet_rows": len(rows),
        "worksheet_cells": sum(
            len(row.findall(xlsx.M + "c")) for row in rows.values()
        ),
        "worksheet_formulas": len(sheet.findall(".//" + xlsx.M + "f")),
        "brand_column_present": brand_column is not None,
        "brands": sorted(brands),
    }


def deduplicate_records(
    records: list[dict[str, str]],
) -> tuple[dict[str, dict[str, str]], int, int, int]:
    result: dict[str, dict[str, str]] = {}
    duplicate_rows = 0
    blank_keys = 0
    conflicts: set[str] = set()
    for record in records:
        key = record["产品SKU"].strip()
        if not key:
            blank_keys += 1
            continue
        if key in result:
            duplicate_rows += 1
            if any(
                result[key][field] != record[field]
                for field in PRODUCT_TARGETS.values()
            ):
                conflicts.add(key)
            continue
        result[key] = record
    return result, duplicate_rows, blank_keys, len(conflicts)


def validate_paths(
    operations: Path,
    products: Path,
    output: Path | None,
    fresh_after: float,
) -> None:
    for label, path in (("Operations", operations), ("Products", products)):
        if not path.is_file():
            raise ValueError(f"{label} workbook does not exist: {path}")
        if path.suffix.lower() != ".xlsx":
            raise ValueError(f"{label} workbook must be .xlsx: {path}")
    if products.stat().st_mtime < fresh_after:
        raise ValueError(f"Product archive was not downloaded during this run: {products}")
    if output is not None:
        if output.resolve() in {operations.resolve(), products.resolve()}:
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
    _, columns = tracking.find_headers(sheet, OPS_FIELDS, strings, 2)
    return sheet, part_name, strings, columns


def matching_plan(
    sheet: ET.Element,
    strings: list[str],
    columns: dict[str, int],
    records: dict[str, dict[str, str]],
) -> dict:
    rows = xlsx.rows_by_number(sheet)
    existing: dict[str, list[int]] = defaultdict(list)
    for row_number, row in rows.items():
        if row_number < 3:
            continue
        key = xlsx.cell_text(
            xlsx.row_cells(row).get(columns["仓库SKU"]), strings
        ).strip()
        if key:
            existing[key].append(row_number)
    matched = set(records) & set(existing)
    return {
        "source_unique_product_skus": len(records),
        "existing_operation_warehouse_skus": len(existing),
        "matched_product_skus": len(matched),
        "matched_operation_rows_to_update": sum(
            len(existing[key]) for key in matched
        ),
        "unmatched_operation_warehouse_skus": len(set(existing) - set(records)),
        "existing_operation_duplicate_warehouse_keys": sum(
            1 for row_numbers in existing.values() if len(row_numbers) > 1
        ),
    }


def update_operations(
    sheet: ET.Element,
    strings: list[str],
    columns: dict[str, int],
    records: dict[str, dict[str, str]],
) -> dict:
    rows = xlsx.rows_by_number(sheet)
    preexisting_errors = tracking.formula_errors(sheet)
    matched_keys: set[str] = set()
    updated_rows = 0
    for row_number in sorted(rows):
        if row_number < 3:
            continue
        row = rows[row_number]
        cells = xlsx.row_cells(row)
        key = xlsx.cell_text(cells.get(columns["仓库SKU"]), strings).strip()
        source = records.get(key)
        if source is None:
            continue
        matched_keys.add(key)
        for target, source_name in PRODUCT_TARGETS.items():
            cell = xlsx.get_or_create_cell(
                row,
                columns[target],
                cells.get(columns[target]),
            )
            tracking.set_text(cell, source[source_name])
        updated_rows += 1
    new_errors = sorted(tracking.formula_errors(sheet) - preexisting_errors)
    if new_errors:
        raise AssertionError(
            "Product update introduced formula errors: "
            + ", ".join(new_errors[:20])
        )
    return {
        "matched_product_skus": len(matched_keys),
        "matched_operation_rows_updated": updated_rows,
        "new_formula_errors": 0,
    }


def run(
    operations: Path,
    products: Path,
    output: Path | None,
    fresh_after: float,
) -> dict:
    validate_paths(operations, products, output, fresh_after)
    operation_parts = xlsx.load_package(operations)
    original_operation_parts = dict(operation_parts)
    product_parts = xlsx.load_package(products)
    source, source_name, _ = product_source_sheet(product_parts)
    source_rows, source_stats = product_records(source)
    records, duplicate_rows, blank_keys, conflicts = deduplicate_records(source_rows)
    operation_sheet, operation_part, strings, columns = operations_sheet(
        operation_parts
    )
    plan = matching_plan(operation_sheet, strings, columns, records)
    common = {
        "source_sheet": source_name,
        "source_duplicate_product_sku_rows": duplicate_rows,
        "source_blank_product_sku_rows": blank_keys,
        "source_conflicting_duplicate_keys": conflicts,
        **source_stats,
        **plan,
    }
    if output is None:
        return {"validated": True, **common}

    operation_parts["xl/styles.xml"], style_map = xlsx.merge_styles(
        operation_parts["xl/styles.xml"], product_parts["xl/styles.xml"]
    )
    xlsx.remap_sheet_styles(source, style_map)
    update_stats = update_operations(
        operation_sheet,
        strings,
        columns,
        records,
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
    output_sheets = xlsx.workbook_sheets(output_parts)[2]
    output_target = next(
        (item for item in output_sheets if item[0] == TARGET_SHEET_NAME),
        None,
    )
    if output_target is None:
        raise AssertionError(f"Output is missing worksheet: {TARGET_SHEET_NAME}")
    output_source = ET.fromstring(output_parts[output_target[2]])
    output_rows, output_stats = product_records(output_source)
    if output_rows != source_rows or output_stats != source_stats:
        raise AssertionError(
            "Output product archive worksheet does not match the validated export"
        )

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
    parser.add_argument("--products", required=True, type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        help="Omit to validate and report the match plan without writing",
    )
    parser.add_argument("--fresh-after", required=True, type=float)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = run(
            args.operations,
            args.products,
            args.output,
            args.fresh_after,
        )
    except Exception as error:
        print(f"Product archive refresh failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
