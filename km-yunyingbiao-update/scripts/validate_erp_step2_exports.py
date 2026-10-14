#!/usr/bin/env python3
"""Validate the four fresh ERP exports before updating the operations workbook."""

import argparse
import json
import re
from pathlib import Path

import pandas as pd


ALLOWED_GROUPS = {"KM一部一组", "KM一部二组", "KM一部三组"}


def clean(value):
    if pd.isna(value):
        return ""
    return str(value).strip()


def normalized(value):
    return clean(value).replace(" ", "").replace("\n", "")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fresh_file(path, fresh_after):
    require(path.is_file(), f"文件不存在：{path}")
    mtime = path.stat().st_mtime
    require(mtime >= fresh_after, f"文件早于本次运行开始时间：{path}")
    return mtime


def read_table(path, required_columns, sheet_name=None, header_candidates=range(0, 6)):
    workbook = pd.ExcelFile(path)
    sheets = [sheet_name] if sheet_name else workbook.sheet_names
    require(all(sheet in workbook.sheet_names for sheet in sheets), f"{path.name} 缺少工作表：{sheet_name}")
    required = {normalized(name) for name in required_columns}
    for sheet in sheets:
        for header in header_candidates:
            preview = pd.read_excel(path, sheet_name=sheet, header=header, nrows=0)
            columns = {normalized(column): column for column in preview.columns}
            if required.issubset(columns):
                frame = pd.read_excel(path, sheet_name=sheet, header=header, dtype=str).fillna("")
                return frame.rename(columns={columns[name]: name for name in required}), sheet, header
    raise ValueError(f"{path.name} 未找到必需字段：{', '.join(required_columns)}")


def values(frame, column):
    return {clean(value) for value in frame[column] if clean(value)}


def target_group_mask(series):
    pattern = "|".join(re.escape(group) for group in ALLOWED_GROUPS)
    return series.astype(str).str.contains(pattern, regex=True, na=False)


def represented_groups(series):
    raw = values(pd.DataFrame({"group": series}), "group")
    return {group for group in ALLOWED_GROUPS if any(group in value for value in raw)}


def validate_tracking(path):
    required = ["平台SKU", "SKU", "预计开售时间", "新品期截止月", "预测销量完成比例", "公司品牌", "主体", "小组"]
    frame, sheet, header = read_table(path, required)
    brands = values(frame, "公司品牌")
    subjects = values(frame, "主体")
    groups = values(frame, "小组")
    represented = represented_groups(frame["小组"])
    require(brands == {"Kemimoto"}, f"新品成功率品牌不纯：{sorted(brands)}")
    require(subjects == ALLOWED_GROUPS, f"新品成功率主体必须精确为三个 KM 组：{sorted(subjects)}")
    require(represented == ALLOWED_GROUPS, f"新品成功率小组未覆盖三个 KM 组：{sorted(groups)}")
    nonblank_groups = frame["小组"].map(clean) != ""
    require(target_group_mask(frame.loc[nonblank_groups, "小组"]).all(), f"新品成功率包含目标范围外的小组：{sorted(groups)}")
    return {"sheet": sheet, "headerRow": header + 1, "rows": len(frame), "brands": sorted(brands), "subjects": sorted(subjects), "groups": sorted(groups)}


def validate_products(path):
    required = ["产品SKU", "产品名称", "三级品类", "品类等级", "产品销售状态", "产品实际等级", "产品目标等级"]
    frame, sheet, header = read_table(path, required)
    columns = {normalized(column): column for column in frame.columns}
    brand_column = columns.get("公司品牌") or columns.get("品牌")
    brands = values(frame, brand_column) if brand_column else set()
    if brands:
        require(brands == {"Kemimoto"}, f"产品档案品牌不纯：{sorted(brands)}")
    return {"sheet": sheet, "headerRow": header + 1, "rows": len(frame), "brands": sorted(brands)}


def validate_platform(path):
    required = ["主体", "平台SKU", "系统SKU", "店铺别名", "运营", "备货状态", "小组"]
    frame, sheet, header = read_table(path, required, sheet_name="平台SKU映射&备货")
    groups = values(frame, "小组")
    allowed_rows = frame[target_group_mask(frame["小组"])]
    require(len(allowed_rows) > 0, "平台 SKU 映射没有三个目标小组的数据。")
    return {"sheet": sheet, "headerRow": header + 1, "rows": len(frame), "targetGroupRows": len(allowed_rows), "groups": sorted(groups)}


def validate_sales(path):
    required = ["店铺", "MSKU", "ASIN", "小组"] + [f"标签{i:02d}" for i in range(1, 11)]
    frame, sheet, header = read_table(path, required, sheet_name="MSKU销售面板")
    groups = values(frame, "小组")
    allowed_rows = frame[target_group_mask(frame["小组"])]
    require(len(allowed_rows) > 0, "亚马逊销售面板没有三个目标小组的数据。")
    return {"sheet": sheet, "headerRow": header + 1, "rows": len(frame), "targetGroupRows": len(allowed_rows), "groups": sorted(groups)}


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--tracking", required=True, type=Path)
    result.add_argument("--products", required=True, type=Path)
    result.add_argument("--platform", type=Path)
    result.add_argument("--sales", type=Path)
    result.add_argument("--fresh-after", required=True, type=float)
    return result


def main():
    args = parser().parse_args()
    if bool(args.platform) != bool(args.sales):
        raise ValueError("--platform 和 --sales 必须同时提供或同时省略")
    validators = {
        "tracking": (args.tracking, validate_tracking),
        "products": (args.products, validate_products),
    }
    if args.platform:
        validators.update({
            "platform": (args.platform, validate_platform),
            "sales": (args.sales, validate_sales),
        })
    summary = {"freshAfter": args.fresh_after, "exports": {}}
    for name, (path, validator) in validators.items():
        mtime = fresh_file(path, args.fresh_after)
        summary["exports"][name] = {
            "path": str(path.resolve()),
            "mtime": mtime,
            **validator(path),
        }
    summary["status"] = "ok"
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
