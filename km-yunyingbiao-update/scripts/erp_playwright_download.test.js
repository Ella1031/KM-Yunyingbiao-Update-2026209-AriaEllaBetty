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
  clickConfiguredExport,
  committedSelectionCoverage,
  downloadGenericReport,
  ensureCheckboxOption,
  installClientExportTrace,
  isExcelResponseDiagnostic,
  isWorkbookBuffer,
  isFreshExportRecord,
  isFreshProductRecord,
  openFilterSelect,
  openReportFromMenuSearch,
  recordTimestamp,
  retryTracedBlobDownload,
  selectedReportKinds,
  selectSingleOption,
  saveResponseWorkbook,
  userActionRequiredEvent,
  verifyCheckboxOptions,
  verifyCommittedSelections,
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
    <div id="brand-list"><div role="option" onclick="this.dataset.selected='yes'; this.setAttribute('aria-selected', 'true')">Kemimoto</div></div>
    <input id="subject" role="combobox" aria-expanded="true">
    <div id="subject-list" class="el-popper">
      <label class="el-checkbox"><input type="checkbox" checked><span>KM一部1组</span></label>
      <label class="el-checkbox"><input type="checkbox"><span>KM一部一组</span></label>
      <label class="el-checkbox"><input type="checkbox"><span>KM一部二组</span></label>
      <label class="el-checkbox"><input type="checkbox"><span>KM一部三组</span></label>
      <label class="el-checkbox"><input type="checkbox" checked><span>KM一部4组</span></label>
      <label class="el-checkbox"><input type="checkbox" checked><span>其他主体</span></label>
    </div>
  `);

  const brand = page.locator('#brand');
  await selectSingleOption(page.mainFrame(), ['Kemimoto'], brand);
  assert.strictEqual(await page.locator('#brand-list [role="option"]').getAttribute('data-selected'), 'yes');
  assert.strictEqual(await page.locator('#unrelated [role="option"]').getAttribute('data-selected'), null);

  const subject = page.locator('#subject');
  const required = [
    { name: 'KM一部一组', aliases: ['KM一部一组'] },
    { name: 'KM一部二组', aliases: ['KM一部二组'] },
    { name: 'KM一部三组', aliases: ['KM一部三组'] },
  ];
  assert.deepStrictEqual(
    committedSelectionCoverage(
      ['DP000422【KM一部一组】', 'KM一部二组', 'KM一部三组'],
      required,
    ).missingNames,
    [],
  );
  assert.deepStrictEqual(
    committedSelectionCoverage(['KM一部二组', 'KM一部三组'], required).missingNames,
    ['KM一部一组'],
  );
  await clearOtherCheckedSubjectOptions(page.mainFrame(), required, subject);
  for (const option of required) await ensureCheckboxOption(page.mainFrame(), option.aliases, subject);
  await clearOtherCheckedSubjectOptions(page.mainFrame(), required, subject);
  await verifyCheckboxOptions(page.mainFrame(), required, subject);

  const state = await page.locator('#subject-list label').evaluateAll((labels) => Object.fromEntries(labels.map((label) => [
    label.innerText.trim(),
    label.querySelector('input').checked,
  ])));
  assert.deepStrictEqual(state, {
    'KM一部1组': false,
    'KM一部一组': true,
    'KM一部二组': true,
    'KM一部三组': true,
    'KM一部4组': false,
    '其他主体': false,
  });

  await page.setContent(`
    <div class="el-select">
      <span class="el-select__selected-item"></span>
      <input id="nested-brand" role="combobox" aria-controls="nested-brand-list" aria-expanded="true">
    </div>
    <div id="hidden-brand-list" hidden>
      <div role="option" onclick="this.dataset.selected='wrong'">Kemimoto</div>
    </div>
    <div id="nested-brand-list" role="listbox" class="el-select-dropdown">
      <div role="option" class="el-select-dropdown__item" aria-selected="false" onclick="
        this.setAttribute('aria-selected', 'true');
        this.classList.add('is-selected');
        document.querySelector('.el-select__selected-item').textContent='Kemimoto';
      ">
        <span>Kemimoto</span><label>Kemimoto</label>
      </div>
      <div role="option" class="el-select-dropdown__item">Kemimoto Pro</div>
      <div role="option" class="el-select-dropdown__item">全选</div>
    </div>
  `);
  const nestedBrand = page.locator('#nested-brand');
  await selectSingleOption(page.mainFrame(), ['Kemimoto'], nestedBrand);
  assert.strictEqual(
    await page.locator('#nested-brand-list [role="option"]').first().getAttribute('aria-selected'),
    'true',
  );
  assert.strictEqual(await page.locator('#hidden-brand-list [role="option"]').getAttribute('data-selected'), null);
  assert.strictEqual(await page.locator('.el-select__selected-item').innerText(), 'Kemimoto');

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
  const canonicalRequired = required.map((option) => option.name);
  for (const name of canonicalRequired) await ensureCheckboxOption(page.mainFrame(), [name], elementSubject);
  await verifyCheckboxOptions(page.mainFrame(), canonicalRequired, elementSubject);
  assert.strictEqual(await page.locator('[data-name="already-selected"]').getAttribute('data-clicked'), null);
  assert.ok((await page.locator('[data-name="rerendered"]').getAttribute('class')).includes('is-checked'));
  assert.ok((await page.locator('[data-name="third"]').getAttribute('class')).includes('is-checked'));

  await page.setContent(`
    <div class="el-select">
      <div class="el-select__tags"></div>
      <input id="tag-subject" role="combobox" aria-controls="tag-list" aria-expanded="true">
    </div>
    <div id="tag-list" class="el-popper">
      <label class="el-checkbox" onclick="
        const tag=document.createElement('span');
        tag.className='el-tag';
        tag.textContent='KM一部一组';
        document.querySelector('.el-select__tags').appendChild(tag);
        this.remove();
      ">
        <span class="el-checkbox__input"><input type="checkbox"></span>
        <span class="el-checkbox__label">KM一部一组</span>
      </label>
    </div>
  `);
  const tagSubject = page.locator('#tag-subject');
  assert.strictEqual(
    await ensureCheckboxOption(page.mainFrame(), ['KM一部一组'], tagSubject),
    'KM一部一组',
  );
  await verifyCheckboxOptions(page.mainFrame(), ['KM一部一组'], tagSubject);

  await page.setContent(`
    <div class="ant-select ant-select-multiple">
      <div class="ant-select-selection-overflow"></div>
      <input id="ant-subject" role="combobox" aria-controls="ant-list" aria-expanded="true">
    </div>
    <div id="ant-list" class="ant-select-dropdown">
      ${canonicalRequired.map((name) => `
        <div role="option" class="ant-select-item ant-select-item-option" aria-selected="false" onclick="
          this.setAttribute('aria-selected', 'true');
          this.classList.add('ant-select-item-option-selected');
          const tag=document.createElement('span');
          tag.className='ant-select-selection-item';
          tag.title='${name}';
          tag.textContent='${name}';
          document.querySelector('.ant-select-selection-overflow').appendChild(tag);
        ">${name}</div>
      `).join('')}
    </div>
  `);
  const antSubject = page.locator('#ant-subject');
  for (const name of canonicalRequired) await ensureCheckboxOption(page.mainFrame(), [name], antSubject);
  await verifyCheckboxOptions(page.mainFrame(), canonicalRequired, antSubject);
  assert.deepStrictEqual(
    await page.locator('.ant-select-selection-item').allTextContents(),
    canonicalRequired,
  );

  await page.setContent(`
    <div class="el-select select-v2-multiple">
      <div class="el-select__selection"></div>
      <input id="coded-subject" class="el-select__input" role="combobox" aria-controls="coded-list" aria-expanded="true">
    </div>
    <ul id="coded-list" role="listbox" class="el-select-dropdown">
      ${[
    ['DP000422', 'KM一部一组'],
    ['DP000423', 'KM一部二组'],
    ['DP000425', 'KM一部三组'],
    ['DP999999', '其他组'],
  ].map(([code, name]) => `
        <li role="option" aria-selected="false" class="el-select-dropdown__item" onclick="
          const checked=this.getAttribute('aria-selected')!=='true';
          this.setAttribute('aria-selected', String(checked));
          this.classList.toggle('is-selected', checked);
          this.querySelector('label').classList.toggle('is-checked', checked);
          this.querySelector('input').checked=checked;
          if (checked) {
            const tag=document.createElement('span');
            tag.className='el-tag';
            tag.dataset.name='${name}';
            tag.textContent='${code}【${name}】';
            document.querySelector('.el-select__selection').appendChild(tag);
          }
        ">
          <label class="el-checkbox"><input type="checkbox"><span>${code}【${name}】</span></label>
        </li>
      `).join('')}
    </ul>
  `);
  const codedSubject = page.locator('#coded-subject');
  for (const name of canonicalRequired) await ensureCheckboxOption(page.mainFrame(), [name], codedSubject);
  await clearOtherCheckedSubjectOptions(page.mainFrame(), canonicalRequired, codedSubject);
  await verifyCheckboxOptions(page.mainFrame(), canonicalRequired, codedSubject);
  assert.deepStrictEqual(
    await page.locator('#coded-list [role="option"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-selected'))),
    ['true', 'true', 'true', 'false'],
  );

  await page.setContent('<input id="value-filter" value="KM一部" role="combobox" aria-expanded="true">');
  const stableValueFilter = await openFilterSelect(page.mainFrame(), {
    placeholders: ['主体'],
    values: ['KM一部'],
  });
  await stableValueFilter.fill('KM一部一组');
  assert.strictEqual(await stableValueFilter.count(), 1);
  assert.strictEqual(await stableValueFilter.inputValue(), 'KM一部一组');
  await assert.rejects(
    verifyCheckboxOptions(page.mainFrame(), ['KM一部一组'], stableValueFilter),
    /主体最终校验未通过/,
  );

  await page.setContent(`
    <input placeholder="输入并选择一个菜单" oninput="document.querySelector('#menu-result').hidden=false">
    <div id="menu-result" hidden>
      <div role="option" onclick="document.querySelector('#platform-report').hidden=false; this.parentElement.hidden=true">我的平台SKU</div>
    </div>
    <section id="platform-report" hidden>
      <h1>我的平台SKU</h1>
      <div class="el-form-item__content">
        <button data-name="filter-export">导出</button>
      </div>
      <div class="el-dropdown">
        <button data-name="toolbar-export" aria-haspopup="menu" onclick="document.querySelector('#platform-export-menu').hidden=false">导出</button>
      </div>
      <ul id="platform-export-menu" hidden>
        <li class="el-dropdown-menu__item" role="menuitem">导出(运营)</li>
      </ul>
    </section>
  `);
  const platformSurface = await openReportFromMenuSearch(page, REPORTS.platform);
  assert.strictEqual(platformSurface.owner, page);
  assert.strictEqual(
    await clickConfiguredExport(platformSurface, REPORTS.platform),
    '导出 -> 导出(运营)',
  );
  assert.strictEqual(await page.locator('[data-name="filter-export"]').getAttribute('aria-expanded'), null);
  assert.strictEqual(await page.locator('#platform-export-menu').isVisible(), true);

  await page.setContent(`
    <input placeholder="输入并选择一个菜单" oninput="document.querySelector('#sales-menu').hidden=false">
    <div id="sales-menu" hidden>
      <div role="option" onclick="document.querySelector('#sales-report').hidden=false; this.parentElement.hidden=true">亚马逊销售面板</div>
    </div>
    <section id="sales-report" hidden>
      <h1>亚马逊销售面板</h1>
      <button>重置</button>
      <div class="el-select">
        <div class="el-select__tags">
          ${canonicalRequired.map((name) => `<span class="el-tag">${name}</span>`).join('')}
        </div>
        <input placeholder="小组" role="combobox" aria-controls="sales-groups" aria-expanded="true">
      </div>
      <div id="sales-groups" class="el-popper">
        ${canonicalRequired.map((name) => `
          <label class="el-checkbox is-checked" onclick="
            event.preventDefault();
            const input=this.querySelector('input');
            input.checked=!input.checked;
            this.classList.toggle('is-checked', input.checked);
            const existing=document.querySelector('[data-sales-group=\"${name}\"]');
            if (existing) existing.remove();
            if (input.checked) {
              const tag=document.createElement('span');
              tag.className='el-tag';
              tag.dataset.salesGroup='${name}';
              tag.textContent='${name}';
              document.querySelector('.el-select__tags').appendChild(tag);
            }
          "><input type="checkbox" checked><span>${name}</span></label>
        `).join('')}
      </div>
      <input type="button" value="搜索">
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

  await page.setContent(`
    <div class="el-select">
      <div class="el-select__tags">
        <span class="el-tag">KM一部二组</span>
        <span class="el-tag">KM一部三组</span>
      </div>
      <input id="incomplete-groups" role="combobox" aria-expanded="false">
    </div>
  `);
  await assert.rejects(
    verifyCommittedSelections(page.locator('#incomplete-groups'), required),
    /缺少：KM一部一组/,
  );

  assert.strictEqual(isExcelResponseDiagnostic({
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    contentDisposition: '',
  }), true);
  assert.strictEqual(isExcelResponseDiagnostic({
    contentType: 'application/octet-stream',
    contentDisposition: 'attachment; filename="mapping.xlsx"',
    url: 'https://erp.example/export',
  }), true);
  assert.strictEqual(isExcelResponseDiagnostic({
    contentType: 'application/octet-stream',
    contentDisposition: '',
    url: 'https://erp.example/api/replenishment/export',
  }), true);
  assert.strictEqual(isExcelResponseDiagnostic({
    contentType: 'application/json',
    contentDisposition: '',
    url: 'https://erp.example/api/export',
  }), false);
  assert.strictEqual(isWorkbookBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
  assert.strictEqual(isWorkbookBuffer(Buffer.from('{"ok":true}')), false);
  const responseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-response-save-test-'));
  try {
    const responsePath = saveResponseWorkbook(
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      responseDir,
      Date.now(),
      'platform',
      '映射-备货信息-运营.xlsx',
    );
    assert.strictEqual(path.basename(responsePath), '映射-备货信息-运营.xlsx');
    assert.strictEqual(fs.statSync(responsePath).size, 5);
  } finally {
    fs.rmSync(responseDir, { recursive: true, force: true });
  }

  await page.setContent('<main>client blob retry</main>');
  await installClientExportTrace(page.mainFrame());
  await page.evaluate(() => {
    URL.createObjectURL(new Blob(['workbook bytes'], { type: 'application/octet-stream' }));
  });
  const blobRetry = await retryTracedBlobDownload(page.mainFrame(), page, '映射-备货信息-运营.xlsx');
  assert.ok(blobRetry.download);
  assert.strictEqual(blobRetry.download.suggestedFilename(), '映射-备货信息-运营.xlsx');
  assert.ok(blobRetry.trace.blobCount >= 1);

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
