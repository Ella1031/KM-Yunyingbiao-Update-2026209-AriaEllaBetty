#!/usr/bin/env python3
"""Regression tests for the established Step2 platform-mapping condition."""

from datetime import datetime

import pandas as pd
from openpyxl import Workbook

from update_erp_step2 import (
    REQUIRED_MAIN,
    append_tracking_skus,
    headers,
    platform_sales_eligible_rows,
)


def build_workbook():
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "产品表"
    sheet.append([])
    sheet.append(REQUIRED_MAIN)
    return workbook, sheet, headers(sheet)


def main():
    workbook, sheet, columns = build_workbook()
    sheet.cell(3, columns["平台SKU"]).value = "EXISTING-MSKU"
    sheet.cell(3, columns["仓库SKU"]).value = "EXISTING-SKU"

    tracking = pd.DataFrame([{
        "平台SKU": "NEW-MSKU",
        "SKU": "NEW-SKU",
        "预计开售时间": datetime(2026, 10, 14),
    }])
    appended, _ = append_tracking_skus(
        workbook, sheet, columns, tracking, legacy_name=None
    )
    assert appended == 1
    assert platform_sales_eligible_rows(sheet, columns) == [3, 4]

    for row in (3, 4):
        sheet.cell(row, columns["店铺别名"]).value = "KM-US"
    assert platform_sales_eligible_rows(sheet, columns) == []

    sheet.cell(4, columns["店铺别名"]).value = None
    sheet.cell(4, columns["主体"]).value = "KM一部一组"
    assert platform_sales_eligible_rows(sheet, columns) == []
    workbook.close()
    print("Step2 legacy-condition regression test passed.")


if __name__ == "__main__":
    main()
