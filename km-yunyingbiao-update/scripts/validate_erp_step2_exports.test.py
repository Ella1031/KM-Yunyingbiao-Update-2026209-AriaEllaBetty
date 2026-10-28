#!/usr/bin/env python3

import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook

import validate_erp_step2_exports as validator


class ThreeGroupCoverageTest(unittest.TestCase):
    def test_sales_requires_all_three_groups(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "sales.xlsx"
            book = Workbook()
            sheet = book.active
            sheet.title = "MSKU销售面板"
            sheet.append(
                ["店铺", "MSKU", "ASIN", "小组"]
                + [f"标签{i:02d}" for i in range(1, 11)]
            )
            sheet.append(["US", "M2", "A2", "DP000423【KM一部二组】"] + [""] * 10)
            sheet.append(["US", "M3", "A3", "DP000425【KM一部三组】"] + [""] * 10)
            book.save(path)

            with self.assertRaisesRegex(ValueError, "KM一部一组"):
                validator.validate_sales(path)

            sheet.append(["US", "M1", "A1", "DP000422【KM一部一组】"] + [""] * 10)
            book.save(path)
            result = validator.validate_sales(path)
            self.assertEqual(
                set(result["representedGroups"]),
                validator.ALLOWED_GROUPS,
            )

    def test_platform_requires_all_three_subjects(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "platform.xlsx"
            book = Workbook()
            sheet = book.active
            sheet.title = "平台SKU映射&备货"
            sheet.append(["导出说明"])
            sheet.append(
                ["主体", "平台SKU", "系统SKU", "店铺别名", "运营", "备货状态", "小组"]
            )
            sheet.append(["KM一部一组", "P1", "S1", "", "", "", "KM一部一组"])
            sheet.append(["KM一部二组", "P2", "S2", "", "", "", "KM一部二组"])
            book.save(path)

            with self.assertRaisesRegex(ValueError, "KM一部三组"):
                validator.validate_platform(path)


if __name__ == "__main__":
    unittest.main()
