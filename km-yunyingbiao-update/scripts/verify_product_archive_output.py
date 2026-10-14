#!/usr/bin/env python3
"""Independently verify a product archive workbook refresh."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import add_product_archive_sheet as product
import update_overseas_intransit as xlsx


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(operations: Path, products: Path, output: Path) -> dict:
    operation_parts = xlsx.load_package(operations)
    output_parts = xlsx.load_package(output)
    product_parts = xlsx.load_package(products)

    source, _, _ = product.product_source_sheet(product_parts)
    source_rows, source_stats = product.product_records(source)
    records, _, _, _ = product.deduplicate_records(source_rows)

    before, _, before_strings, before_columns = product.operations_sheet(
        operation_parts
    )
    after, _, after_strings, after_columns = product.operations_sheet(output_parts)
    if before_columns != after_columns:
        raise AssertionError("Operations columns changed")

    before_rows = xlsx.rows_by_number(before)
    after_rows = xlsx.rows_by_number(after)
    target_columns = {before_columns[name] for name in product.PRODUCT_TARGETS}
    verified_updates = 0
    verified_unchanged_rows = 0
    verified_unchanged_cells = 0

    for row_number, before_row in before_rows.items():
        after_row = after_rows.get(row_number)
        if after_row is None:
            raise AssertionError(f"Missing operations row {row_number}")
        before_cells = xlsx.row_cells(before_row)
        after_cells = xlsx.row_cells(after_row)
        key = xlsx.cell_text(
            before_cells.get(before_columns["仓库SKU"]), before_strings
        ).strip()
        record = records.get(key)
        if record is None:
            if ET.tostring(before_row) != ET.tostring(after_row):
                raise AssertionError(f"Unmatched row changed: {row_number}")
            verified_unchanged_rows += 1
            continue

        for target, source_name in product.PRODUCT_TARGETS.items():
            actual = xlsx.cell_text(
                after_cells.get(after_columns[target]), after_strings
            ).strip()
            if actual != record[source_name].strip():
                raise AssertionError(
                    f"Mapped value mismatch at row {row_number}, field {target}"
                )
        verified_updates += 1

        for column, before_cell in before_cells.items():
            if column in target_columns:
                continue
            after_cell = after_cells.get(column)
            if ET.tostring(before_cell) != ET.tostring(after_cell):
                raise AssertionError(
                    f"Non-target cell changed at row {row_number}, column {column}"
                )
            verified_unchanged_cells += 1

    target = next(
        item
        for item in xlsx.workbook_sheets(output_parts)[2]
        if item[0] == product.TARGET_SHEET_NAME
    )
    copied_source = ET.fromstring(output_parts[target[2]])
    copied_rows, copied_stats = product.product_records(copied_source)
    if copied_rows != source_rows or copied_stats != source_stats:
        raise AssertionError("Copied ERP product archive differs from source data")

    with zipfile.ZipFile(output, "r") as archive:
        bad_part = archive.testzip()
        if bad_part:
            raise AssertionError(f"Corrupt XLSX part: {bad_part}")

    return {
        "operations_sha256": file_hash(operations),
        "products_sha256": file_hash(products),
        "output_sha256": file_hash(output),
        "verified_updates": verified_updates,
        "verified_unchanged_rows": verified_unchanged_rows,
        "verified_unchanged_non_target_cells": verified_unchanged_cells,
        "copied_source_rows": len(copied_rows),
        "new_formula_errors": len(
            product.tracking.formula_errors(after)
            - product.tracking.formula_errors(before)
        ),
        "zip_integrity": "ok",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operations", required=True, type=Path)
    parser.add_argument("--products", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            verify(args.operations, args.products, args.output),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
