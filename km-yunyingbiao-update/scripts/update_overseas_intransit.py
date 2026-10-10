#!/usr/bin/env python3
"""Safely add BI overseas in-transit data to a KM operations workbook.

The script edits XLSX package XML directly. This keeps unrelated workbook parts
byte-for-byte intact and remaps BI style IDs into the destination workbook.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import math
import posixpath
import re
import sys
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types"
M = "{" + MAIN + "}"
R = "{" + REL + "}"
PR = "{" + PKG_REL + "}"
CT = "{" + CONTENT + "}"

ET.register_namespace("", MAIN)
ET.register_namespace("r", REL)

TARGET_SHEET_PREFIX = "海外在途预计上架（横版）"
TARGET_SHEET_NAME = "海外在途预计上架（横版）"
OPS_SHEET_NAME = "产品表"
ALLOWED_SUBJECTS = {"KM一部一组", "KM一部二组", "KM一部三组"}
CELL_REF_RE = re.compile(r"^([A-Z]+)([0-9]+)$")
RANGE_REF_RE = re.compile(r"^([A-Z]+)([0-9]+):([A-Z]+)([0-9]+)$")


def xml_bytes(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def col_number(letters: str) -> int:
    value = 0
    for char in letters:
        value = value * 26 + ord(char) - 64
    return value


def col_letters(number: int) -> str:
    result = ""
    while number:
        number, rem = divmod(number - 1, 26)
        result = chr(65 + rem) + result
    return result


def split_ref(ref: str) -> tuple[int, int]:
    match = CELL_REF_RE.match(ref)
    if not match:
        raise ValueError(f"Unsupported cell reference: {ref}")
    return col_number(match.group(1)), int(match.group(2))


def shifted_ref(ref: str, insert_col: int) -> str:
    match = CELL_REF_RE.match(ref)
    if match:
        col, row = col_number(match.group(1)), int(match.group(2))
        if col >= insert_col:
            col += 1
        return f"{col_letters(col)}{row}"
    match = RANGE_REF_RE.match(ref)
    if match:
        c1, r1 = col_number(match.group(1)), int(match.group(2))
        c2, r2 = col_number(match.group(3)), int(match.group(4))
        if c1 >= insert_col:
            c1 += 1
            c2 += 1
        elif c1 < insert_col <= c2:
            c2 += 1
        return f"{col_letters(c1)}{r1}:{col_letters(c2)}{r2}"
    return ref


def load_package(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path, "r") as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def write_package(path: Path, parts: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)


def resolve_target(owner_part: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(owner_part), target))


def workbook_sheets(parts: dict[str, bytes]) -> tuple[ET.Element, ET.Element, list[tuple[str, str, str]]]:
    workbook = ET.fromstring(parts["xl/workbook.xml"])
    rels = ET.fromstring(parts["xl/_rels/workbook.xml.rels"])
    targets = {
        rel.attrib["Id"]: resolve_target("xl/workbook.xml", rel.attrib["Target"])
        for rel in rels
    }
    sheets = []
    for sheet in workbook.find(M + "sheets"):
        rid = sheet.attrib[R + "id"]
        sheets.append((sheet.attrib["name"], rid, targets[rid]))
    return workbook, rels, sheets


def shared_strings(parts: dict[str, bytes]) -> list[str]:
    if "xl/sharedStrings.xml" not in parts:
        return []
    root = ET.fromstring(parts["xl/sharedStrings.xml"])
    return ["".join(node.text or "" for node in item.iter(M + "t")) for item in root.findall(M + "si")]


def cell_text(cell: ET.Element | None, strings: list[str]) -> str:
    if cell is None:
        return ""
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        inline = cell.find(M + "is")
        return "" if inline is None else "".join(n.text or "" for n in inline.iter(M + "t"))
    value = cell.find(M + "v")
    if value is None or value.text is None:
        return ""
    if cell_type == "s":
        return strings[int(value.text)]
    return value.text


def cell_is_blank(cell: ET.Element | None, strings: list[str]) -> bool:
    if cell is None:
        return True
    if cell.find(M + "f") is not None:
        return False
    return not cell_text(cell, strings).strip()


def row_cells(row: ET.Element) -> dict[int, ET.Element]:
    result = {}
    for cell in row.findall(M + "c"):
        col, _ = split_ref(cell.attrib["r"])
        result[col] = cell
    return result


def cell_signature(cell: ET.Element) -> bytes:
    clone = copy.deepcopy(cell)
    clone.attrib.pop("r", None)
    return ET.tostring(clone, encoding="utf-8")


def rows_by_number(sheet: ET.Element) -> dict[int, ET.Element]:
    sheet_data = sheet.find(M + "sheetData")
    if sheet_data is None:
        raise ValueError("Worksheet has no sheetData")
    return {int(row.attrib["r"]): row for row in sheet_data.findall(M + "row")}


def set_inline_string(cell: ET.Element, value: str) -> None:
    for child in list(cell):
        cell.remove(child)
    cell.attrib["t"] = "inlineStr"
    inline = ET.SubElement(cell, M + "is")
    text = ET.SubElement(inline, M + "t")
    if value.startswith(" ") or value.endswith(" "):
        text.attrib["{http://www.w3.org/XML/1998/namespace}space"] = "preserve"
    text.text = value


def set_number(cell: ET.Element, value: float) -> None:
    for child in list(cell):
        cell.remove(child)
    cell.attrib.pop("t", None)
    node = ET.SubElement(cell, M + "v")
    node.text = str(int(value)) if float(value).is_integer() else format(value, ".15g")


def get_or_create_cell(row: ET.Element, col: int, style_from: ET.Element | None = None) -> ET.Element:
    row_number = int(row.attrib["r"])
    cells = row.findall(M + "c")
    for cell in cells:
        current_col, _ = split_ref(cell.attrib["r"])
        if current_col == col:
            return cell
    cell = ET.Element(M + "c", {"r": f"{col_letters(col)}{row_number}"})
    if style_from is not None and "s" in style_from.attrib:
        cell.attrib["s"] = style_from.attrib["s"]
    for index, existing in enumerate(cells):
        current_col, _ = split_ref(existing.attrib["r"])
        if current_col > col:
            row.insert(index, cell)
            break
    else:
        row.append(cell)
    return cell


def parse_date(value: str) -> dt.date | None:
    text = value.strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        serial = float(text)
        if serial > 0:
            return dt.date(1899, 12, 30) + dt.timedelta(days=int(serial))
    match = re.match(r"^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?", text)
    if match:
        return dt.date(int(match.group(1)), int(match.group(2)), int(match.group(3) or 1))
    return None


def parse_amount(value: str) -> float | None:
    text = value.strip().replace(",", "")
    if not text:
        return None
    try:
        amount = float(text)
    except ValueError:
        return None
    return amount if math.isfinite(amount) else None


def first_of_month(value: dt.date) -> dt.date:
    return value.replace(day=1)


def prepare_bi_sheet(parts: dict[str, bytes]) -> tuple[ET.Element, dict[str, dict[dt.date, float]], dict]:
    _, _, sheets = workbook_sheets(parts)
    matches = [item for item in sheets if item[0].startswith(TARGET_SHEET_PREFIX)]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one BI horizontal worksheet, found {len(matches)}")
    _, _, part_name = matches[0]
    sheet = ET.fromstring(parts[part_name])
    if sheet.findall(".//" + M + "f"):
        raise ValueError("BI horizontal worksheet contains formulas; safe column insertion is not supported")
    strings = shared_strings(parts)
    rows = rows_by_number(sheet)
    if 1 not in rows or 2 not in rows:
        raise ValueError("BI horizontal worksheet is missing header rows")

    original_cells = {
        cell.attrib["r"]: cell_signature(cell)
        for row in rows.values()
        for cell in row.findall(M + "c")
    }

    for row in rows.values():
        for cell in reversed(row.findall(M + "c")):
            col, row_number = split_ref(cell.attrib["r"])
            if col >= 6:
                cell.attrib["r"] = f"{col_letters(col + 1)}{row_number}"
        row[:] = sorted(
            row,
            key=lambda node: split_ref(node.attrib["r"])[0] if node.tag == M + "c" else -1,
        )

    cols = sheet.find(M + "cols")
    if cols is not None:
        source_col = None
        for column in cols.findall(M + "col"):
            minimum, maximum = int(column.attrib["min"]), int(column.attrib["max"])
            if minimum <= 2 <= maximum:
                source_col = copy.deepcopy(column)
            if minimum >= 6:
                column.attrib["min"] = str(minimum + 1)
                column.attrib["max"] = str(maximum + 1)
            elif maximum >= 6:
                column.attrib["max"] = str(maximum + 1)
        if source_col is not None:
            source_col.attrib["min"] = source_col.attrib["max"] = "6"
            cols.insert(min(5, len(cols)), source_col)

    for tag in ("autoFilter", "dimension"):
        for node in sheet.iter(M + tag):
            if "ref" in node.attrib:
                node.attrib["ref"] = shifted_ref(node.attrib["ref"], 6)
    for node in sheet.iter(M + "mergeCell"):
        ref = node.attrib.get("ref", "")
        match = RANGE_REF_RE.match(ref)
        if not match:
            continue
        c1, r1 = col_number(match.group(1)), int(match.group(2))
        c2, r2 = col_number(match.group(3)), int(match.group(4))
        if c1 >= 6:
            c1 += 1
            c2 += 1
        elif c2 == 5:
            # The BI group heading originally spans A:E. Include inserted F.
            c2 += 1
        node.attrib["ref"] = f"{col_letters(c1)}{r1}:{col_letters(c2)}{r2}"

    derived_count = 0
    product_number_fallback_count = 0
    for row_number, row in rows.items():
        cells = row_cells(row)
        style_template = cells.get(2)
        if style_template is None:
            style_template = cells.get(5)
        new_cell = get_or_create_cell(row, 6, style_template)
        if row_number == 1:
            for child in list(new_cell):
                new_cell.remove(child)
            new_cell.attrib.pop("t", None)
        elif row_number == 2:
            set_inline_string(new_cell, "平台SKU")
        elif row_number >= 3:
            combined = cell_text(cells.get(1), strings).strip()
            product_number = cell_text(cells.get(2), strings).strip()
            account = cell_text(cells.get(5), strings).strip()
            sku = combined[len(account):] if account and combined.startswith(account) else ""
            if account and combined.startswith(account) and not sku:
                raise ValueError(f"BI row {row_number}: derived 平台SKU is blank")
            if combined and account and not combined.startswith(account):
                if product_number and combined.endswith(product_number):
                    sku = product_number
                    product_number_fallback_count += 1
                else:
                    raise ValueError(f"BI row {row_number}: 合拼 does not start with 账号")
            set_inline_string(new_cell, sku)
            if sku:
                derived_count += 1

    # Every original cell must still have identical content and style. Insertion
    # is represented only by shifting original F+ cells one column to the right.
    current_cells = {
        cell.attrib["r"]: cell_signature(cell)
        for row in rows.values()
        for cell in row.findall(M + "c")
    }
    for original_ref, signature in original_cells.items():
        expected_ref = shifted_ref(original_ref, 6)
        if current_cells.get(expected_ref) != signature:
            raise AssertionError(f"BI source cell changed unexpectedly: {original_ref}")

    unexpected_subjects = set()
    for row_number, row in rows.items():
        if row_number < 3:
            continue
        value = cell_text(row_cells(row).get(3), strings).strip()
        if value and value not in ALLOWED_SUBJECTS:
            unexpected_subjects.add(value)
    if unexpected_subjects:
        raise ValueError("BI export contains unapproved 主体 values: " + ", ".join(sorted(unexpected_subjects)))

    header = row_cells(rows[1])
    date_columns = {}
    for col, cell in header.items():
        if col >= 8:
            value = parse_date(cell_text(cell, strings))
            if value:
                date_columns[col] = value
    totals: dict[str, dict[dt.date, float]] = defaultdict(lambda: defaultdict(float))
    for row_number, row in rows.items():
        if row_number < 3:
            continue
        cells = row_cells(row)
        sku = cell_text(cells.get(6), strings).strip()
        if not sku:
            continue
        for col, date_value in date_columns.items():
            amount = parse_amount(cell_text(cells.get(col), strings))
            if amount is not None:
                totals[sku][date_value] += amount

    stats = {
        "bi_source_sheet": matches[0][0],
        "bi_rows": len(rows),
        "derived_platform_skus": derived_count,
        "product_number_fallback_skus": product_number_fallback_count,
        "bi_date_columns": len(date_columns),
    }
    return sheet, totals, stats


def append_style_records(
    dest_parent: ET.Element,
    src_parent: ET.Element,
    mapping: dict[int, int],
) -> None:
    start = len(dest_parent)
    for index, item in enumerate(src_parent):
        mapping[index] = start + index
        dest_parent.append(copy.deepcopy(item))
    dest_parent.attrib["count"] = str(len(dest_parent))


def merge_styles(dest_bytes: bytes, src_bytes: bytes) -> tuple[bytes, dict[int, int]]:
    dest = ET.fromstring(dest_bytes)
    src = ET.fromstring(src_bytes)
    maps = {name: {} for name in ("fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "dxfs")}

    for kind in ("fonts", "fills", "borders"):
        dest_parent, src_parent = dest.find(M + kind), src.find(M + kind)
        if dest_parent is None or src_parent is None:
            raise ValueError(f"styles.xml missing {kind}")
        append_style_records(dest_parent, src_parent, maps[kind])

    dest_numfmts = dest.find(M + "numFmts")
    src_numfmts = src.find(M + "numFmts")
    if dest_numfmts is None:
        dest_numfmts = ET.Element(M + "numFmts", {"count": "0"})
        dest.insert(0, dest_numfmts)
    used_ids = {int(item.attrib["numFmtId"]) for item in dest_numfmts}
    fmt_by_id = {int(item.attrib["numFmtId"]): item.attrib["formatCode"] for item in dest_numfmts}
    numfmt_map: dict[int, int] = {}
    next_id = max([163, *used_ids]) + 1
    if src_numfmts is not None:
        for item in src_numfmts:
            old_id = int(item.attrib["numFmtId"])
            code = item.attrib["formatCode"]
            existing = next((key for key, value in fmt_by_id.items() if value == code), None)
            if existing is not None:
                numfmt_map[old_id] = existing
                continue
            new_id = old_id if old_id not in used_ids and old_id >= 164 else next_id
            while new_id in used_ids:
                new_id += 1
            next_id = max(next_id, new_id + 1)
            clone = copy.deepcopy(item)
            clone.attrib["numFmtId"] = str(new_id)
            dest_numfmts.append(clone)
            used_ids.add(new_id)
            fmt_by_id[new_id] = code
            numfmt_map[old_id] = new_id
    dest_numfmts.attrib["count"] = str(len(dest_numfmts))

    def remap_xf(xf: ET.Element, include_xfid: bool) -> None:
        for attr, kind in (("fontId", "fonts"), ("fillId", "fills"), ("borderId", "borders")):
            if attr in xf.attrib:
                xf.attrib[attr] = str(maps[kind][int(xf.attrib[attr])])
        if "numFmtId" in xf.attrib:
            old = int(xf.attrib["numFmtId"])
            xf.attrib["numFmtId"] = str(numfmt_map.get(old, old))
        if include_xfid and "xfId" in xf.attrib:
            xf.attrib["xfId"] = str(maps["cellStyleXfs"][int(xf.attrib["xfId"])])

    dest_style_xfs, src_style_xfs = dest.find(M + "cellStyleXfs"), src.find(M + "cellStyleXfs")
    if dest_style_xfs is None or src_style_xfs is None:
        raise ValueError("styles.xml missing cellStyleXfs")
    style_xf_start = len(dest_style_xfs)
    for index in range(len(src_style_xfs)):
        maps["cellStyleXfs"][index] = style_xf_start + index
    for item in src_style_xfs:
        clone = copy.deepcopy(item)
        remap_xf(clone, include_xfid=False)
        dest_style_xfs.append(clone)
    dest_style_xfs.attrib["count"] = str(len(dest_style_xfs))

    dest_cell_xfs, src_cell_xfs = dest.find(M + "cellXfs"), src.find(M + "cellXfs")
    if dest_cell_xfs is None or src_cell_xfs is None:
        raise ValueError("styles.xml missing cellXfs")
    cell_xf_start = len(dest_cell_xfs)
    for index in range(len(src_cell_xfs)):
        maps["cellXfs"][index] = cell_xf_start + index
    for item in src_cell_xfs:
        clone = copy.deepcopy(item)
        remap_xf(clone, include_xfid=True)
        dest_cell_xfs.append(clone)
    dest_cell_xfs.attrib["count"] = str(len(dest_cell_xfs))

    dest_dxfs, src_dxfs = dest.find(M + "dxfs"), src.find(M + "dxfs")
    if src_dxfs is not None:
        if dest_dxfs is None:
            dest_dxfs = ET.Element(M + "dxfs", {"count": "0"})
            dest.append(dest_dxfs)
        append_style_records(dest_dxfs, src_dxfs, maps["dxfs"])

    return xml_bytes(dest), maps["cellXfs"]


def remap_sheet_styles(sheet: ET.Element, style_map: dict[int, int]) -> None:
    for node in sheet.iter():
        if "s" in node.attrib and node.tag in {M + "c", M + "row"}:
            node.attrib["s"] = str(style_map[int(node.attrib["s"])])
        if node.tag == M + "col" and "style" in node.attrib:
            node.attrib["style"] = str(style_map[int(node.attrib["style"])])


def add_or_replace_sheet(parts: dict[str, bytes], sheet: ET.Element) -> None:
    workbook, rels, sheets = workbook_sheets(parts)
    sheet_list = workbook.find(M + "sheets")
    existing = next((item for item in sheets if item[0] == TARGET_SHEET_NAME), None)
    if existing:
        part_name = existing[2]
    else:
        existing_numbers = [
            int(match.group(1))
            for name in parts
            if (match := re.fullmatch(r"xl/worksheets/sheet(\d+)\.xml", name))
        ]
        next_number = max(existing_numbers, default=0) + 1
        part_name = f"xl/worksheets/sheet{next_number}.xml"
        existing_rids = {rel.attrib["Id"] for rel in rels}
        rid_number = 1
        while f"rId{rid_number}" in existing_rids:
            rid_number += 1
        rid = f"rId{rid_number}"
        rel = ET.SubElement(rels, PR + "Relationship")
        rel.attrib.update({
            "Id": rid,
            "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
            "Target": f"worksheets/sheet{next_number}.xml",
        })
        max_sheet_id = max((int(item.attrib["sheetId"]) for item in sheet_list), default=0)
        ET.SubElement(sheet_list, M + "sheet", {
            "name": TARGET_SHEET_NAME,
            "sheetId": str(max_sheet_id + 1),
            R + "id": rid,
        })
        content_types = ET.fromstring(parts["[Content_Types].xml"])
        ET.SubElement(content_types, CT + "Override", {
            "PartName": "/" + part_name,
            "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        })
        parts["[Content_Types].xml"] = xml_bytes(content_types)
    parts[part_name] = xml_bytes(sheet)
    parts["xl/workbook.xml"] = xml_bytes(workbook)
    parts["xl/_rels/workbook.xml.rels"] = xml_bytes(rels)


def update_operations_sheet(
    parts: dict[str, bytes], totals: dict[str, dict[dt.date, float]], today: dt.date
) -> dict:
    _, _, sheets = workbook_sheets(parts)
    match = next((item for item in sheets if item[0] == OPS_SHEET_NAME), None)
    if match is None:
        raise ValueError(f"Operations workbook is missing worksheet: {OPS_SHEET_NAME}")
    part_name = match[2]
    sheet = ET.fromstring(parts[part_name])
    strings = shared_strings(parts)
    rows = rows_by_number(sheet)

    header_row_number = None
    header_columns = {}
    required = {"平台SKU", "新品首批预计到货时间", "新品首批到货数量", "新品期开售月"}
    for row_number in sorted(rows)[:10]:
        values = {
            re.sub(r"\s+", "", cell_text(cell, strings)): col
            for col, cell in row_cells(rows[row_number]).items()
        }
        if required.issubset(values):
            header_row_number = row_number
            header_columns = values
            break
    if header_row_number is None:
        raise ValueError("Could not locate required 产品表 headers")

    sku_col = header_columns["平台SKU"]
    arrival_col = header_columns["新品首批预计到货时间"]
    quantity_col = header_columns["新品首批到货数量"]
    launch_col = header_columns["新品期开售月"]
    lower_month = first_of_month(today)
    upper_date = today + dt.timedelta(days=90)
    upper_month = first_of_month(upper_date)

    original_non_targets = {
        cell.attrib["r"]: cell_signature(cell)
        for row in rows.values()
        for cell in row.findall(M + "c")
        if split_ref(cell.attrib["r"])[0] not in {arrival_col, quantity_col}
    }

    stats = defaultdict(int)
    for row_number in sorted(rows):
        if row_number <= header_row_number:
            continue
        row = rows[row_number]
        cells = row_cells(row)
        sku = cell_text(cells.get(sku_col), strings).strip()
        launch = parse_date(cell_text(cells.get(launch_col), strings))
        if not sku or launch is None:
            continue
        if not (lower_month <= first_of_month(launch) <= upper_month):
            continue
        stats["eligible_operation_rows"] += 1
        if sku not in totals:
            stats["unmatched_operation_rows"] += 1
            continue
        stats["matched_operation_rows"] += 1
        candidates = [
            (date_value, amount)
            for date_value, amount in totals[sku].items()
            if today <= date_value <= upper_date and amount > 0
        ]
        if not candidates:
            stats["matched_without_valid_arrival"] += 1
            continue
        arrival_date, amount = min(candidates, key=lambda item: item[0])

        arrival_cell = get_or_create_cell(row, arrival_col, cells.get(arrival_col))
        quantity_cell = get_or_create_cell(row, quantity_col, cells.get(quantity_col))
        if not cell_is_blank(arrival_cell, strings):
            stats["existing_arrival_dates_preserved"] += 1
        else:
            set_inline_string(arrival_cell, arrival_date.isoformat())
            stats["arrival_date_cells_written"] += 1
        if not cell_is_blank(quantity_cell, strings):
            stats["existing_arrival_quantities_preserved"] += 1
        else:
            set_number(quantity_cell, amount)
            stats["arrival_quantity_cells_written"] += 1

    current_non_targets = {
        cell.attrib["r"]: cell_signature(cell)
        for row in rows.values()
        for cell in row.findall(M + "c")
        if split_ref(cell.attrib["r"])[0] not in {arrival_col, quantity_col}
    }
    if current_non_targets != original_non_targets:
        raise AssertionError("产品表 changed outside the two permitted arrival columns")

    parts[part_name] = xml_bytes(sheet)
    return {
        "run_date": today.isoformat(),
        "launch_month_lower": lower_month.isoformat(),
        "launch_month_upper": upper_month.isoformat(),
        "arrival_date_upper": upper_date.isoformat(),
        **{key: stats[key] for key in (
            "eligible_operation_rows",
            "matched_operation_rows",
            "unmatched_operation_rows",
            "matched_without_valid_arrival",
            "arrival_date_cells_written",
            "arrival_quantity_cells_written",
            "existing_arrival_dates_preserved",
            "existing_arrival_quantities_preserved",
        )},
    }


def validate_paths(operations: Path, bi: Path, output: Path) -> None:
    for label, path in (("operations", operations), ("BI", bi)):
        if not path.is_file():
            raise ValueError(f"{label} workbook does not exist: {path}")
        if path.suffix.lower() != ".xlsx":
            raise ValueError(f"{label} workbook must be .xlsx: {path}")
    if output.resolve() in {operations.resolve(), bi.resolve()}:
        raise ValueError("Output must not overwrite either input workbook")
    if output.exists():
        raise ValueError(f"Output already exists: {output}")


def run(operations: Path, bi: Path, output: Path, today: dt.date) -> dict:
    validate_paths(operations, bi, output)
    operation_parts = load_package(operations)
    original_operation_parts = dict(operation_parts)
    bi_parts = load_package(bi)

    bi_sheet, totals, bi_stats = prepare_bi_sheet(bi_parts)
    operation_parts["xl/styles.xml"], style_map = merge_styles(
        operation_parts["xl/styles.xml"], bi_parts["xl/styles.xml"]
    )
    remap_sheet_styles(bi_sheet, style_map)
    operation_stats = update_operations_sheet(operation_parts, totals, today)
    add_or_replace_sheet(operation_parts, bi_sheet)

    allowed_existing_changes = {
        "[Content_Types].xml",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
    }
    _, _, sheets = workbook_sheets(original_operation_parts)
    product_part = next(item[2] for item in sheets if item[0] == OPS_SHEET_NAME)
    allowed_existing_changes.add(product_part)
    existing_bi = next((item[2] for item in sheets if item[0] == TARGET_SHEET_NAME), None)
    if existing_bi:
        allowed_existing_changes.add(existing_bi)
    changed_unrelated = [
        name
        for name, data in original_operation_parts.items()
        if name not in allowed_existing_changes and operation_parts.get(name) != data
    ]
    if changed_unrelated:
        raise AssertionError("Unexpected workbook parts changed: " + ", ".join(changed_unrelated))

    write_package(output, operation_parts)
    with zipfile.ZipFile(output, "r") as archive:
        bad_file = archive.testzip()
        if bad_file:
            raise AssertionError(f"Corrupt XLSX output part: {bad_file}")

    return {
        "output": str(output.resolve()),
        **bi_stats,
        **operation_stats,
        "style_ids_remapped": len(style_map),
        "unrelated_existing_parts_changed": 0,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operations", required=True, type=Path, help="Approved KM operations workbook")
    parser.add_argument("--bi", required=True, type=Path, help="BI exported workbook")
    parser.add_argument("--output", required=True, type=Path, help="New output .xlsx path")
    parser.add_argument("--today", type=dt.date.fromisoformat, default=dt.date.today(), help="Run date YYYY-MM-DD")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = run(args.operations, args.bi, args.output, args.today)
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
