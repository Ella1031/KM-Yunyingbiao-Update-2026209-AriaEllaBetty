#!/usr/bin/env python3

import datetime as dt
import unittest
from xml.etree import ElementTree as ET

import update_overseas_intransit as subject


def inline_cell(ref: str, value: str) -> ET.Element:
    cell = ET.Element(subject.M + "c", {"r": ref, "t": "inlineStr"})
    inline = ET.SubElement(cell, subject.M + "is")
    ET.SubElement(inline, subject.M + "t").text = value
    return cell


def product_parts(launch_month: str = "") -> dict[str, bytes]:
    workbook = ET.Element(subject.M + "workbook")
    sheets = ET.SubElement(workbook, subject.M + "sheets")
    ET.SubElement(sheets, subject.M + "sheet", {
        "name": subject.OPS_SHEET_NAME,
        "sheetId": "1",
        subject.R + "id": "rId1",
    })
    rels = ET.Element(subject.PR + "Relationships")
    ET.SubElement(rels, subject.PR + "Relationship", {
        "Id": "rId1",
        "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
        "Target": "worksheets/sheet1.xml",
    })
    sheet = ET.Element(subject.M + "worksheet")
    data = ET.SubElement(sheet, subject.M + "sheetData")
    header = ET.SubElement(data, subject.M + "row", {"r": "1"})
    for ref, value in (
        ("A1", "平台SKU"),
        ("B1", "新品首批预计到货时间"),
        ("C1", "新品首批到货数量"),
        ("D1", "新品期开售月"),
    ):
        header.append(inline_cell(ref, value))
    row = ET.SubElement(data, subject.M + "row", {"r": "2"})
    row.append(inline_cell("A2", "B0110-15799-CL"))
    if launch_month:
        row.append(inline_cell("D2", launch_month))
    return {
        "xl/workbook.xml": subject.xml_bytes(workbook),
        "xl/_rels/workbook.xml.rels": subject.xml_bytes(rels),
        "xl/worksheets/sheet1.xml": subject.xml_bytes(sheet),
    }


class OverseasArrivalOrderTest(unittest.TestCase):
    def test_missing_launch_month_is_audited_and_not_written(self):
        parts = product_parts()
        totals = {"B0110-15799-CL": {dt.date(2026, 11, 24): 35.0}}
        stats = subject.update_operations_sheet(parts, totals, dt.date(2026, 10, 15))
        self.assertEqual(stats["eligible_operation_rows"], 0)
        self.assertEqual(stats["bi_matched_rows_missing_launch_month"], 1)

    def test_erp_launch_month_must_exist_before_bi_matching(self):
        parts = product_parts("2026/12")
        totals = {"B0110-15799-CL": {dt.date(2026, 11, 24): 35.0}}
        stats = subject.update_operations_sheet(parts, totals, dt.date(2026, 10, 15))
        self.assertEqual(stats["eligible_operation_rows"], 1)
        self.assertEqual(stats["arrival_date_cells_written"], 1)
        self.assertEqual(stats["arrival_quantity_cells_written"], 1)
        sheet = ET.fromstring(parts["xl/worksheets/sheet1.xml"])
        cells = subject.row_cells(subject.rows_by_number(sheet)[2])
        self.assertEqual(subject.cell_text(cells[2], []), "2026-11-24")
        self.assertEqual(subject.cell_text(cells[3], []), "35")


if __name__ == "__main__":
    unittest.main()
