#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const { loadPlaywright } = require('./playwright_runtime');
const { chromium } = loadPlaywright();
const {
  clearOtherCheckedSubjectOptions,
  ensureCheckboxOption,
  isFreshProductRecord,
  recordTimestamp,
  selectSingleOption,
  userActionRequiredEvent,
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

  await browser.close();
assert.ok(recordTimestamp('2026-10-13 14:44:52') > 0);
assert.strictEqual(recordTimestamp('no timestamp'), null);
const exportedAt = new Date(2026, 9, 13, 14, 58, 4).getTime();
assert.strictEqual(
  isFreshProductRecord('product_export_excel_plus_for_name 2026-10-13 14:58:05 运算中', exportedAt),
  true,
);
assert.strictEqual(
  isFreshProductRecord('product_export_excel_plus_for_name 2026-10-13 14:44:52 已完成', exportedAt),
  false,
);

console.log('ERP selector self-test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
