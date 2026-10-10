# 运营表完整更新规则

## Inputs

1. Base KM workbook containing `产品表` and `产品表-老三(含清货淘汰)`.
2. ERP `新品成功率跟踪表（首单）`, exported in **平台SKU** dimension.
3. ERP `产品档案`, exported with product names.
4. BI `海外在途预计上架取数`, containing `海外在途预计上架（横版）`.
5. ERP `我的平台SKU` / `映射-备货信息-运营.xlsx`.
6. ERP `亚马逊销售面板` export.

For ERP exports, reset retained page filters before choosing the three KM一部 groups. Wait until export records show `已完成` before downloading.

## Execution order

### Step 1: BI overseas in-transit

Run `update_overseas_intransit.py` first. It embeds/replaces `海外在途预计上架（横版）`, derives `平台SKU`, and fills blank `新品首批预计到货时间` and `新品首批到货数量` only for eligible launch months and arrivals within the script's 90-day window. Existing arrival values are preserved.

### ERP tracking and product archive

Filter tracking data to the three allowed groups. Match existing `产品表[平台SKU]` to tracking `平台SKU` and update:

| 产品表 | ERP新品成功率 |
| --- | --- |
| 新品期开售月 | 预计开售时间 |
| 新品期截止月 | 新品期截止月 |
| 最新新品成功率 | 预测销量完成比例 |

Match `产品表[仓库SKU]` to `ERP产品档案[产品SKU]` and update:

| 产品表 | ERP产品档案 |
| --- | --- |
| 产品名称 | 产品名称 |
| 三级品类 | 三级品类 |
| 产品销售状态 | 产品销售状态 |
| 品类等级 | 产品实际等级 |

The embedded `ERP产品档案` tab must include `品类等级`, `产品实际等级`, and `产品目标等级`.

### New SKU rule

Append a tracking SKU only when all are true:

- it exists in the filtered ERP tracking export;
- it is absent from both `产品表` and `产品表-老三(含清货淘汰)`;
- `预计开售时间` parses successfully and is on or after `2026-01-01`;
- the source `平台SKU` is nonblank.

Use tracking `SKU` as the appended `仓库SKU`. Copy the previous product-row style/formulas where applicable, then populate tracking and product-archive fields. Never append a duplicate source key.

### Step 2

Only rows with both `平台SKU` and `仓库SKU` and blank `店铺别名/主体/运营/备货状态` are eligible.

- Filter platform and sales exports to the three allowed groups.
- Exclude platform mappings whose `店铺别名` contains `老三`.
- For duplicate platform mappings prefer US, then CA, then other sites.
- Match platform source `平台SKU` and fill `店铺别名`, `主体`, `运营`, `备货状态`.
- Match sales source `(店铺, MSKU)` to `(店铺别名, 平台SKU)` and fill `ASIN`, `标签01` through `标签10`.
- Do not blank or overwrite an already populated row.

Embed/replace these source tabs instead of creating numbered duplicates:

- `ERP新品成功率`
- `ERP产品档案`
- `Step2平台SKU映射`
- `Step2亚马逊销售面板`

## Formatting and validation

- For every `产品表` row having `平台SKU` or `仓库SKU`, apply thin black borders to A:AQ.
- Do not apply this formatting to the legacy sheet.
- Scan formulas and text for `#REF!`, `#VALUE!`, `#N/A`, `#DIV/0!`, `#NAME?`, and `#NUM!`. Fail only when the update introduces new errors. Report pre-existing errors, especially those in the protected legacy sheet, without modifying them.
- Verify the legacy-sheet digest before and after the update.
- Confirm all expected source tabs exist and no input file was overwritten.
