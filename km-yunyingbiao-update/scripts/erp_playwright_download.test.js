#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPlaywright } = require('./playwright_runtime');
const { chromium } = loadPlaywright();
const {
  REPORTS,
  clearOtherCheckedSubjectOptions,
  downloadGenericReport,
  ensureCheckboxOption,
  isFreshExportRecord,
  isFreshProductRecord,
  openReportFromMenuSearch,
  recordTimestamp,
  selectedReportKinds,
  selectSingleOption,
  userActionRequiredEvent,
  verifyCheckboxOptions,
} = require('./erp_playwright_download');

function chromePath() {
  return [
    process.env.PLAYWRIGHT_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
}

async function main() {
  assert.deepStrictEqual(userActionRequiredEvent(), {
    stage: 'user_action_required',
    action: 'dingtalk_qr_login',
    message: 'ERP 登录页面已打开，请在可见浏览器中完成钉钉扫码登录。',
  });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
  const page = await browser.newPage();
  await page.setContent(`
    <input id="brand" role="combobox" aria-controls="brand-list" aria-expanded="true">
    <div id="unrelated" hidden><div role="option" onclick="this.dataset.selected='wrong'">Kemimoto</div></div>
    <div id="brand-list"><div role="option" onclick="this.dataset.selected='yes'">Kemimoto</div></div>
    <input id="subject" role="combobox" aria-expanded="true">
    <div id="subject-list" class="el-popper">
      <label class="el-checkbox"><input type="checkbox" checked><span>KM一部1组</span></label>
      <label class="el-checkbox"><input type="checkbox"><span>KM一部一组</span></label>
      <label class="el-checkbox"><input type="checkbox"><span>KM一部二组</span></label>
      <label class="el-checkbox"><input type="checkbox"><span>KM一部三组</span></label>
      <label class="el-checkbox"><input type="checkbox" checked><span>其他主体</span></label>
    </div>
  `);

  const brand = page.locator('#brand');
  await selectSingleOption(page.mainFrame(), ['Kemimoto'], brand);
  assert.strictEqual(await page.locator('#brand-list [role="option"]').getAttribute('data-selected'), 'yes');
  assert.strictEqual(await page.locator('#unrelated [role="option"]').getAttribute('data-selected'), null);

  const subject = page.locator('#subject');
  const required = ['KM一部一组', 'KM一部二组', 'KM一部三组'];
  await clearOtherCheckedSubjectOptions(page.mainFrame(), required, subject);
  for (const name of required) await ensureCheckboxOption(page.mainFrame(), [name], subject);
  await clearOtherCheckedSubjectOptions(page.mainFrame(), required, subject);

  const state = await page.locator('#subject-list label').evaluateAll((labels) => Object.fromEntries(labels.map((label) => [
    label.innerText.trim(),
    label.querySelector('input').checked,
  ])));
  assert.deepStrictEqual(state, {
    'KM一部1组': false,
    'KM一部一组': true,
    'KM一部二组': true,
    'KM一部三组': true,
    '其他主体': false,
  });

  await page.setContent(`
    <input id="element-subject" role="combobox" aria-controls="element-list" aria-expanded="true">
    <div id="element-list" class="el-popper">
      <label class="el-checkbox is-checked" data-name="already-selected" onclick="this.dataset.clicked='yes'">
        <span class="el-checkbox__input is-checked"><span class="el-checkbox__inner"></span><input class="el-checkbox__original" type="checkbox"></span>
        <span class="el-checkbox__label">KM一部一组</span>
      </label>
      <label class="el-checkbox" data-name="rerendered" onclick="const next=this.cloneNode(true); next.classList.add('is-checked'); next.querySelector('.el-checkbox__input').classList.add('is-checked'); this.replaceWith(next)">
        <span class="el-checkbox__input"><span class="el-checkbox__inner"></span><input class="el-checkbox__original" type="checkbox"></span>
        <span class="el-checkbox__label">KM一部二组</span>
      </label>
      <label class="el-checkbox" data-name="third" onclick="this.classList.add('is-checked'); this.querySelector('.el-checkbox__input').classList.add('is-checked')">
        <span class="el-checkbox__input"><span class="el-checkbox__inner"></span><input class="el-checkbox__original" type="checkbox"></span>
        <span class="el-checkbox__label">KM一部三组</span>
      </label>
    </div>
  `);
  const elementSubject = page.locator('#element-subject');
  for (const name of required) await ensureCheckboxOption(page.mainFrame(), [name], elementSubject);
  await verifyCheckboxOptions(page.mainFrame(), required, elementSubject);
  assert.strictEqual(await page.locator('[data-name="already-selected"]').getAttribute('data-clicked'), null);
  assert.ok((await page.locator('[data-name="rerendered"]').getAttribute('class')).includes('is-checked'));
  assert.ok((await page.locator('[data-name="third"]').getAttribute('class')).includes('is-checked'));

  await page.setContent(`
    <input placeholder="输入并选择一个菜单" oninput="document.querySelector('#menu-result').hidden=false">
    <div id="menu-result" hidden>
      <div role="option" onclick="document.querySelector('#platform-report').hidden=false; this.parentElement.hidden=true">我的平台SKU</div>
    </div>
    <section id="platform-report" hidden>
      <h1>我的平台SKU</h1>
      <button>导出备货信息(取数)</button>
    </section>
  `);
  const platformSurface = await openReportFromMenuSearch(page, REPORTS.platform);
  assert.strictEqual(platformSurface.owner, page);
  assert.ok((await platformSurface.frame.locator('body').innerText()).includes('导出备货信息(取数)'));

  await page.setContent(`
    <input placeholder="输入并选择一个菜单" oninput="document.querySelector('#sales-menu').hidden=false">
    <div id="sales-menu" hidden>
      <div role="option" onclick="document.querySelector('#sales-report').hidden=false; this.parentElement.hidden=true">亚马逊销售面板</div>
    </div>
    <section id="sales-report" hidden>
      <h1>亚马逊销售面板</h1>
      <button>重置</button>
      <input placeholder="小组" role="combobox" aria-controls="sales-groups" aria-expanded="true">
      <div id="sales-groups" class="el-popper">
        <label class="el-checkbox"><input type="checkbox"><span>KM一部一组</span></label>
        <label class="el-checkbox"><input type="checkbox"><span>KM一部二组</span></label>
        <label class="el-checkbox"><input type="checkbox"><span>KM一部三组</span></label>
      </div>
      <button>搜索</button>
      <a download="raw-sales.xlsx" href="data:application/octet-stream;base64,dGVzdCB3b3JrYm9vaw==">导出Excel</a>
      <span>导出</span>
    </section>
  `);
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-step2-download-test-'));
  const salesMenuPath = REPORTS.sales.menuPath;
  const salesExportTexts = REPORTS.sales.exportTexts;
  try {
    REPORTS.sales.menuPath = null;
    REPORTS.sales.exportTexts = ['导出Excel'];
    const salesPath = await downloadGenericReport(page.context(), page, downloadDir, 'sales');
    assert.strictEqual(path.basename(salesPath), '亚马逊销售面板.xlsx');
    assert.ok(fs.statSync(salesPath).size > 0);
  } finally {
    REPORTS.sales.menuPath = salesMenuPath;
    REPORTS.sales.exportTexts = salesExportTexts;
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }

  await browser.close();
assert.ok(recordTimestamp('2026-10-13 14:44:52') > 0);
assert.strictEqual(recordTimestamp('no timestamp'), null);
assert.deepStrictEqual(selectedReportKinds('tracking-products'), ['tracking', 'products']);
assert.deepStrictEqual(selectedReportKinds('platform-sales'), ['platform', 'sales']);
assert.deepStrictEqual(selectedReportKinds('step2-all'), ['tracking', 'products', 'platform', 'sales']);
assert.deepStrictEqual(selectedReportKinds('tracking'), ['tracking']);
assert.throws(() => selectedReportKinds('all'), /tracking-products/);
const exportedAt = new Date(2026, 9, 13, 14, 58, 4).getTime();
assert.strictEqual(
  isFreshProductRecord('product_export_excel_plus_for_name 2026-10-13 14:58:05 运算中', exportedAt),
  true,
);
assert.strictEqual(
  isFreshProductRecord('product_export_excel_plus_for_name 2026-10-13 14:44:52 已完成', exportedAt),
  false,
);
assert.strictEqual(
  isFreshExportRecord('replenishmentInfo 导出备货信息(取数) 2026-10-13 14:58:05 已完成', exportedAt, ['replenishmentInfo']),
  true,
);
assert.strictEqual(
  isFreshExportRecord('replenishmentInfo 导出备货信息(取数) 2026-10-13 14:44:52 已完成', exportedAt, ['replenishmentInfo']),
  false,
);
assert.strictEqual(
  isFreshExportRecord('other_report 2026-10-13 14:58:05 已完成', exportedAt, ['replenishmentInfo']),
  false,
);
assert.strictEqual(
  isFreshExportRecord('亚马逊销售面板 2026-10-13 14:58:05 运算中', exportedAt, ['亚马逊销售面板', 'amazon_sales']),
  true,
);

console.log('ERP selector self-test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
