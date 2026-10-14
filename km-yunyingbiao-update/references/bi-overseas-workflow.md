# BI 海外在途预计上架刷新流程

## 1. 登录和访问边界

Open `https://dms.issyzone.net:38999/webroot/decision#/`.

- The user must personally enter the BI username and password.
- Never remember, store, infer, autofill, or reuse the credentials.
- After login, search only for `海外在途预计上架取数`.
- Do not open or inspect unrelated BI modules.

Playwright feasibility has been verified with the local Chrome executable: the BI URL returns the login page and can be opened in a headed browser. The supported automation boundary is user-assisted login followed by page probing/download. Do not automate credential entry or assume that a generic `导出` selector is stable until the current BI page has been probed.
Record `run_start` before opening BI. The BI processor must receive `--fresh-after run_start` and reject a BI workbook whose filesystem timestamp predates the current run.

## 2. 筛选和导出

Set 主体 to exactly:

- `KM一部一组`
- `KM一部二组`
- `KM一部三组`

Click the page-level `导出`, then choose `导出Excel`. This export contains every report worksheet. Confirm the download is complete before processing it.

Before matching any data, create a cleaned BI workbook that contains exactly one worksheet named `海外在途预计上架（横版）`. Physically remove all other worksheet XML and the shared-string table so data from removed worksheets is not retained in the cleaned package. Reject the export if the horizontal worksheet is missing or appears more than once.

## 3. BI 横版表处理边界

The exported BI worksheet is authoritative. Preserve its row order, values, date columns, styles, colors, merged cells, widths, heights, and structure.

The only permitted source-sheet change is inserting one new column F after 账号:

- `F2 = 平台SKU`
- For each data row from row 3, remove the E-column 账号 prefix from the start of A-column 合拼.
- Example: `二十二-USF1306-03201(2)` minus `二十二-US` -> `F1306-03201(2)`.
- Do not use unrestricted string replacement. Remove the account only when A starts with E.
- Shift the original 合计 and date columns one column to the right without changing their values or styles.
- Give the inserted cells the corresponding original BI row style. Do not borrow style IDs from the operations workbook.

Do not add flags, highlights, match results, comments, helper formulas, or other columns. Do not recolor any original BI cell.

When embedding the worksheet in the operations workbook, styles must be merged and remapped. Copying worksheet XML while retaining raw BI style IDs is forbidden because those IDs refer to a different `styles.xml` and can produce incorrect yellow/blue rows.

## 4. 动态处理日期范围

Calculate these boundaries on every run:

- `today`: current local date, unless an explicit test/as-of date was requested.
- lower month: first day of `today`'s month.
- upper month: first day of the month containing `today + 90 days`.
- arrival upper bound: `today + 90 days`.

An operations row is eligible only when:

`lower_month <= 新品期开售月 <= upper_month`

An arrival date is eligible only when:

`today <= arrival_date <= today + 90 days`

Ignore expired dates. Month boundaries are inclusive.

## 5. 平台 SKU 匹配和最早有效在途

Use exact trimmed `平台SKU` equality between `产品表` and the processed BI horizontal sheet.

For each eligible operations row:

1. Scan BI date columns from left to right.
2. Ignore blank, zero, negative, or invalid quantities.
3. If duplicate BI rows have the same SKU and date, sum their quantities for that date.
4. Select the earliest eligible date whose summed quantity is positive.

Unmatched SKUs and SKUs without a valid positive in-transit quantity remain unchanged.

## 6. Blank-only writes

Write only these `产品表` fields:

- `新品首批预计到货时间`
- `新品首批到货数量`

Treat them independently:

- If the time cell is blank, write the selected date; otherwise preserve it.
- If the quantity cell is blank, write the selected quantity; otherwise preserve it.
- Never clear an existing value and never overwrite a nonblank value.

Do not modify any other operations-table value, formula, format, sheet, comment, validation, object, or annotation. Matching itself must not create any visible marking.

## 7. Output and validation

Use `scripts/update_overseas_intransit.py`. Pass `--cleaned-bi-output` so the raw all-sheet export is never used directly for matching. The script must save both outputs to new paths and refuse to overwrite either input.

```powershell
python "$skillRoot\scripts\update_overseas_intransit.py" `
  --operations "C:\path\KM一部运营表.xlsx" `
  --bi "C:\path\海外在途预计上架取数-全量导出.xlsx" `
  --cleaned-bi-output "C:\path\海外在途预计上架取数-仅横版.xlsx" `
  --output "C:\path\KM一部运营表-海外在途更新.xlsx" `
  --fresh-after <run_start_unix_timestamp>
```

Before accepting the output, verify:

- the BI sheet exists once as `海外在途预计上架（横版）`;
- the inserted F column contains only the requested header and derived SKUs;
- every original BI cell is unchanged apart from the required one-column shift;
- original BI styles remain BI styles after embedding;
- existing operations X/Y values were preserved independently;
- only blank eligible X/Y cells were populated;
- all other operations sheets and package parts remain unchanged;
- no credentials, downloaded workbook, or generated business-data workbook is added to the Skill repository.

Run `scripts/verify_overseas_output.py` against the Step2 input, cleaned BI file, and Step3 output. It independently verifies the single-sheet cleanup, exact subjects, inserted platform-SKU column, blank-only writes, and unchanged unrelated package parts.
