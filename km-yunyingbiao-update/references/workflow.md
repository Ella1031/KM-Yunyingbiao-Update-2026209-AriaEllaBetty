# Step2 ERP运营表刷新流程

This reference documents the ERP portion of the original two-step workflow. BI overseas-in-transit is Step1 and is documented in `bi-overseas-workflow.md`. Authentication and downloads remain Step1 BI followed by Step2 ERP. For a complete workbook build, however, process ERP first and apply the fresh BI export last because ERP populates `新品期开售月` and can append SKUs required by the BI matcher. Use `scripts/build_full_refresh.py` to enforce that dependency-safe order. A legacy `产品表-老三(含清货淘汰)` sheet is protected when present; a clean template may omit it.

## 1. ERP登录与人工 handoff

Open `https://erp.issyzone.net:9999/system/index`. If a DingTalk QR login is shown, stop before login and ask the user to scan. Never use saved credentials or attempt to bypass the scan. The Playwright runner checks the login state every two seconds and resumes automatically when the ERP shell is available; do not require the user to press Enter after scanning.
Every refresh run must use a new user-authenticated session and newly generated exports. Do not reuse an older export when the user requested the latest data.
Record `run_start` before opening ERP. The ERP processor must receive `--fresh-after run_start` and reject any tracking, product, platform, or sales export whose filesystem timestamp is older than that value.

For a complete Step2 run, use `--kind step2-all` so 新品成功率、产品档案、平台 SKU 映射 and 亚马逊销售面板 are exported in one browser context after one DingTalk scan. Use `tracking`, `products`, `tracking-products`, `platform`, or `sales` only for a deliberately isolated report test or refresh.

Pass `--workbook <current operations workbook>` during a complete run. The runner preserves the original Step2 eligibility rule and only automates its source acquisition. After applying the established tracking append rule in memory, it checks for rows where `平台SKU` and `仓库SKU` are both present while `店铺别名`, `主体`, `运营`, and `备货状态` are all blank. If none exist, it skips both platform/sales exports. If any exist, both sources must be freshly downloaded in the current ERP session. Do not replace this condition with a count of tracking rows or introduce a new business rule.

## 2. Export新品成功率跟踪表

1. Open 产品模块 -> 新品成功率跟踪表（首单）.
2. Select `平台SKU维度` and click `展开` when the extended filters are collapsed.
3. In the 主体 multiselect, ensure exactly these three options are checked: `KM一部一组`, `KM一部二组`, and `KM一部三组`. These names must match exactly; do not substitute the distinct `KM一部1组`, `KM一部2组`, or `KM一部3组` options. Select brand `Kemimoto`, then click `搜索`. After expanding the filters, the page can show two linked 品牌 controls. Select `Kemimoto` once in the controlled popup opened by the active combobox and verify that control is selected; the page synchronizes the other brand control automatically. Do not click both controls or treat the duplicate page text as two required selections.
4. Verify all three主体 selections are checked before exporting; clicking matching text without checking its checkbox state is insufficient.
5. Start Playwright's download listener, then click `导出` and capture the direct browser download. Do not navigate to 常用操作 or 导出记录 for this report.
6. Save the file in the run's staging directory and confirm its modified time is later than the export click.
7. Run `scripts/add_tracking_source_sheet.py` against a new output path. The executor adds/replaces the complete downloaded export as the logical `新品成功率` source worksheet and performs the `产品表` matching, overwrite, append, and yellow-fill rules in sections 4 and 7. Adding the source sheet alone is not a completed Step1 result.

Before matching, keep only these主体 values: `KM一部一组`, `KM一部二组`, `KM一部三组`.

## 3. Export产品档案

1. Open 产品模块 -> 产品档案.
2. Filter brand `Kemimoto`.
3. Use 导出功能 -> `导出(包括产品名称)`. The live page currently uses half-width parentheses; accept the full-width variant only as a compatibility alias.
4. Open 常用操作 -> 导出记录.
5. Locate the newest row whose 报表类型 is `product_export_excel_plus_for_name` and whose 创建时间 belongs to this run. Reload the export-record inner page while polling so the row status and current count are fetched again.
6. Wait for that same row to show `已完成`, then click its 下载. Never fall back to an older completed row.
7. Confirm the downloaded file belongs to the current run and was saved to the requested project staging directory.

Use the newest download timestamp and export-record creation time together. Do not assume the visible filename is unique. Move or copy the verified files to a runtime staging directory outside the Skill source tree; never commit business exports to the Skill repository.

## 4. Export平台 SKU 映射

Run this export only when the original Step2 condition reports one or more rows requiring platform-SKU mapping.

1. Open `运营 -> 我的平台SKU`.
2. Click `重置`.
3. In `主体`, select exactly `KM一部一组`, `KM一部二组`, and `KM一部三组`, then verify all three checkbox states.
4. Click `搜索`.
5. Click `导出 -> 导出（运营）`. If the current ERP page shows a confirmation dialog, click its `确认` or `确定` button. The page submits `exportExcelByOperationType`; keep the same report and authenticated browser session open for up to ten minutes while the server builds the direct response. Capture the resulting direct download as `映射-备货信息-运营.xlsx`. Do not switch to `常用操作 -> 导出记录` for this report.
6. Verify the exported `主体` column. Retain the untouched ERP response as `映射-备货信息-运营-原始导出.xlsx`, then create the runtime source `映射-备货信息-运营.xlsx` by keeping every column and every row whose `主体` resolves to one of the three exact allowed names. ERP may decorate the value as `KM一部一组【KM一部一组】`; extract only the exact canonical name and reject numeric aliases or longer names. Embed only this strict three-subject source in `Step2平台SKU映射`; do not embed the full-company export.

## 5. Export亚马逊销售面板

Run this export together with the platform mapping export when the original Step2 condition requires mapping.

1. Open `销售 -> Amazon销售面板`.
2. In `小组`, select exactly the same three KM groups and verify all three checkbox states. The control may decorate each option with a system code, for example `DP000422【KM一部一组】`; accept that display only when the name inside `【】` exactly equals one of the three required names. Do not accept numeric aliases such as `1组`, `2组`, or `3组`.
3. Click `搜索 -> 导出`.
4. Open `常用操作 -> 导出记录`, reload the inner records page while waiting, and select only the current-run Amazon sales-panel row.
5. Wait until `生成状态` is `已完成`, then click that row's `下载` and save it as `亚马逊销售面板.xlsx`. The export normally takes about five minutes; do not use an older completed row.

## 6. 新品成功率表 matching

Use `平台SKU` as the unique key in both the source and operation table.

Deduplicate the source before matching and keep the first nonblank occurrence of each `平台SKU`. A repeated source key must not append another row or cause the same destination row to be overwritten more than once by competing source records.

### Existing operation rows

- Never delete or modify an existing operation row merely because a source row is old, blank, or ineligible.
- For an existing key, update only the requested新品成功率追踪 fields when the established workflow calls for it:
  - `新品期开售月` <- `预计开售时间`
  - `新品期截止月` <- `新品期截止月`
  - `最新新品成功率` <- `预测销量完成比例`
- Treat these three fields as a full refresh for every matched row. A blank source field clears the corresponding destination field. Unmatched operation rows remain unchanged.

### New operation rows

Add a source row only when all conditions hold:

- the source `平台SKU` is not already in the operation table;
- the source key is not a duplicate already selected from the source;
- `预计开售时间` is parseable;
- the parsed date is `2026-01-01` or later.

Do not add blank, unparseable, 2024, or 2025 dates. Append eligible rows contiguously immediately after the last row containing actual data. Ignore trailing rows that contain only formatting, borders, or row height when locating the append position; reuse those preformatted blank rows before extending the worksheet. Populate the source `平台SKU` and `仓库SKU` fields according to the established operation-table layout. Mark only the new `平台SKU` cell yellow.

## 7. 产品档案 matching

Use:

- source key: `产品SKU`
- operation key: `仓库SKU`

For a successful match, update only these operation-table fields:

- `产品名称` <- source `产品名称`
- `三级品类` <- source `三级品类`
- `产品销售状态` <- source `产品销售状态`
- `品类等级` <- source `产品实际等级`

Do not change other operation columns. Preserve unmatched operation rows. Add the complete downloaded 产品档案 export as a source subtable/tab.

For a product-archive-only run, first omit `--output` to validate freshness and match counts, then execute:

```powershell
python "$skillRoot\scripts\add_product_archive_sheet.py" `
  --operations "C:\path\KM一部运营表-Step1完整更新.xlsx" `
  --products "C:\path\产品档案-导出(包括产品名称).xlsx" `
  --output "C:\path\KM一部运营表-产品档案更新.xlsx" `
  --fresh-after <run_start_unix_timestamp>
```

## 8. Source tabs and repeated runs

- Add complete source tabs for every downloaded ERP export. Preserve every exported row, column, value, and original order in `ERP新品成功率`, `ERP产品档案`, and `Step2亚马逊销售面板`. For `Step2平台SKU映射`, preserve every row, column, value, and original order after the mandatory exact `主体` scope restriction.
- Filtering, field selection, and deduplication apply only to separate in-memory matching copies. Never use a processed matching frame as the source tab.
- For新品成功率 matching, validate exact `主体` values and deduplicate the matching copy by `平台SKU`. Do not discard a valid row merely because its `小组` field is blank.
- Treat `平台SKU` as the sole uniqueness key when appending. The same `仓库SKU` may legitimately have more than one distinct platform SKU.
- On a repeated run, replace the prior generated tab with the same logical name rather than creating `产品档案1`, `产品档案2`, or equivalent duplicates.
- Keep the original downloaded files in the runtime staging directory for traceability; do not place business exports under version control.

## 9. Validation before saving

Report at least:

- source export filenames and timestamps;
- source row count after主体 filtering;
- duplicate source key count;
- eligible new SKU count;
- existing operation rows matched and updated;
- new rows appended;
- unmatched operation SKU count;
- product archive matches and conflicts;
- blank rows created in the append area;
- whether only new `平台SKU` cells were yellow;
- whether appended formulas were translated to the new row rather than copied with stale row references;
- formula-error scan for `#REF!`, `#VALUE!`, `#N/A`, `#DIV/0!`, `#NAME?`, and `#NUM!`.

Save a new workbook such as `KM一部运营表-YYYYMMDD-ERP自动更新.xlsx`. Never overwrite the original base workbook.

For an ERP新品成功率-only run, execute:

```powershell
python "$skillRoot\scripts\add_tracking_source_sheet.py" `
  --operations "C:\path\KM一部运营表.xlsx" `
  --tracking "C:\path\新品首单成功与否跟踪.xlsx" `
  --output "C:\path\KM一部运营表-Step2新品成功率更新.xlsx" `
  --fresh-after <run_start_unix_timestamp>
```

Run once without `--output` first to validate freshness, exact filters, required columns, duplicate counts, match counts, and eligible append counts.

## Automation boundary

This workflow can be automated after the user completes QR login. Run `scripts/erp_playwright_download.js --kind step2-all --workbook <current-operations-workbook> --download-dir <new-empty-directory>` once. The script uses the fixed menu paths for `我的平台SKU` and `Amazon销售面板` only when the original Step2 condition requires those sources. It waits for the current `我的平台SKU` direct-download request and follows only a current-run export-record row for `Amazon销售面板`. It saves those reports as `映射-备货信息-运营.xlsx` and `亚马逊销售面板.xlsx`.

Before running the workbook processor, execute `scripts/validate_erp_step2_exports.py` with all four export paths and the recorded `run_start`. The validator rejects stale files, wrong tracking brand or subjects, missing source sheets, and missing required fields. The platform export must contain no主体 outside the three exact KM names. The sales export may contain decorated group labels, but its matching copy is restricted to the three exact KM group names.

Fully unattended execution is not appropriate because DingTalk scanning is a user-authentication step and Chrome may require a user-visible download permission confirmation.
