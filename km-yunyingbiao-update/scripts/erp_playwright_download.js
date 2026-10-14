#!/usr/bin/env node

// ERP export downloader. The user performs DingTalk QR login; the script then
// applies the report filters, submits the export, polls the export record, and
// captures the download without storing credentials or browser state.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadPlaywright } = require('./playwright_runtime');
const { chromium } = loadPlaywright();

const ERP_URL = 'https://erp.issyzone.net:9999/system/index';
const PRODUCT_URL = 'https://erp.issyzone.net:9999/master/product/product';
const REPORTS = {
  tracking: {
    name: '新品成功率跟踪表（首单）',
    exportText: '导出',
    filePrefix: '新品',
    instructions: '请打开“产品模块 -> 新品成功率跟踪表（首单）”，选择平台SKU维度，品牌筛选 Kemimoto，并确认主体为三个 KM一部组。',
  },
  products: {
    name: '产品档案',
    exportText: '导出（包括产品名称）',
    filePrefix: '产品档案',
    instructions: '请打开“产品模块 -> 产品档案”，筛选品牌 Kemimoto，并确认导出选项为“导出（包括产品名称）”。',
  },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function chromePath() {
  return [
    process.env.PLAYWRIGHT_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean).find((p) => fs.existsSync(p));
}

function userActionRequiredEvent() {
  return {
    stage: 'user_action_required',
    action: 'dingtalk_qr_login',
    message: 'ERP 登录页面已打开，请在可见浏览器中完成钉钉扫码登录。',
  };
}

function ask(question) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => input.question(`${question}\n> `, (answer) => { input.close(); resolve(answer.trim()); }));
}

async function clickText(page, text) {
  const exact = page.getByText(text, { exact: true }).first();
  if (await exact.count() && await exact.isVisible().catch(() => false)) {
    await exact.click();
    return true;
  }
  const partial = page.getByText(text, { exact: false }).first();
  if (await partial.count() && await partial.isVisible().catch(() => false)) {
    await partial.click();
    return true;
  }
  return false;
}

async function clickTextAnyFrame(page, text) {
  for (const frame of page.frames()) {
    const exact = frame.getByText(text, { exact: true }).first();
    if (await exact.count() && await exact.isVisible().catch(() => false)) {
      await exact.click().catch(() => exact.evaluate((node) => node.click()));
      return true;
    }
    const partial = frame.getByText(text, { exact: false }).first();
    if (await partial.count() && await partial.isVisible().catch(() => false)) {
      await partial.click().catch(() => partial.evaluate((node) => node.click()));
      return true;
    }
    if (await partial.count()) {
      await partial.evaluate((node) => node.click());
      return true;
    }
  }
  return false;
}

async function firstVisible(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function findTrackingFrame(page) {
  for (const frame of page.frames()) {
    const body = await frame.locator('body').innerText().catch(() => '');
    if (body.includes('平台SKU维度') && body.includes('搜索') && body.includes('导出')) return frame;
  }
  return null;
}

async function waitForTrackingFrame(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await findTrackingFrame(page);
    if (frame) return frame;
    await page.waitForTimeout(1000);
  }
  return null;
}

async function frameContaining(page, requiredTexts, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const body = await frame.locator('body').innerText().catch(() => '');
      if (requiredTexts.every((text) => body.includes(text))) return frame;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function selectNativeOptionByText(frame, exactText) {
  const selects = frame.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i += 1) {
    const select = selects.nth(i);
    const option = select.locator('option').filter({ hasText: exactText });
    const optionCount = await option.count();
    for (let j = 0; j < optionCount; j += 1) {
      const candidate = option.nth(j);
      if ((await candidate.innerText().catch(() => '')).trim() !== exactText) continue;
      const value = await candidate.getAttribute('value');
      await select.evaluate((node, selectedValue) => {
        for (const optionNode of node.options) {
          optionNode.selected = optionNode.value === selectedValue;
        }
        node.value = selectedValue;
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
      const selected = await select.locator('option:checked').allTextContents();
      if (!selected.some((text) => text.trim() === exactText)) {
        throw new Error(`品牌控件未能保持唯一选中：${exactText}`);
      }
      return true;
    }
  }
  return false;
}

async function selectXmOptionByText(frame, exactText) {
  const selects = frame.locator('select[xm-select]');
  const count = await selects.count();
  for (let i = 0; i < count; i += 1) {
    const select = selects.nth(i);
    const exactOption = select.locator('option').filter({ hasText: exactText });
    if (!await exactOption.count()) continue;
    const selectId = await select.getAttribute('id');
    const xmName = await select.getAttribute('xm-select');
    const apiSelection = await frame.evaluate(({ xmNameValue, exactTextValue }) => {
      const source = document.querySelector(`select[xm-select="${xmNameValue}"]`);
      const option = source && [...source.options].find((item) => item.textContent.trim() === exactTextValue);
      const api = window.formSelects || (window.layui && window.layui.formSelects);
      if (!source || !option || !api || typeof api.value !== 'function') {
        return { available: false, selected: [] };
      }
      api.value(xmNameValue, [option.value], true);
      const current = api.value(xmNameValue) || [];
      return {
        available: true,
        selected: current.map((item) => String(item.name || item.text || item.value || item.val || '').trim()),
      };
    }, { xmNameValue: xmName, exactTextValue: exactText });
    if (apiSelection.available) {
      await frame.waitForTimeout(300);
      if (apiSelection.selected.length !== 1 || apiSelection.selected[0] !== exactText) {
        throw new Error(`formSelects 品牌未能保持唯一选中：${apiSelection.selected.join(', ')}`);
      }
      return true;
    }

    const candidates = [
      frame.locator(`#${selectId} + .xm-select-parent`),
      frame.locator(`.xm-select-parent[xm-select="${xmName}"]`),
      select.locator('xpath=following-sibling::*[contains(concat(" ", normalize-space(@class), " "), " xm-select-parent ")][1]'),
      select.locator('xpath=parent::*//*[contains(concat(" ", normalize-space(@class), " "), " xm-select-parent ")][1]'),
    ];
    let parent = null;
    for (const candidate of candidates) {
      if (await candidate.count() && await candidate.first().isVisible().catch(() => false)) {
        parent = candidate.first();
        break;
      }
    }
    if (!parent) continue;

    const trigger = parent.locator('.xm-select').first();
    await trigger.click().catch(() => parent.click());
    await frame.waitForTimeout(300);
    const options = parent.locator('dd');
    const optionCount = await options.count();
    let target = null;
    for (let j = 0; j < optionCount; j += 1) {
      const option = options.nth(j);
      const text = (await option.innerText().catch(() => '')).trim();
      const classes = await option.getAttribute('class').catch(() => '');
      const selected = /xm-select-this|xm-selected|selected/.test(classes || '')
        || await option.locator('.xm-form-selected, .xm-form-checked').count() > 0;
      if (text === exactText) {
        target = option;
        if (!selected) await option.click();
      } else if (selected && text && text !== '全选') {
        await option.click();
      }
    }
    if (!target) continue;
    await frame.page().keyboard.press('Escape').catch(() => {});
    await frame.waitForTimeout(300);
    const selectedTexts = await select.locator('option:checked').allTextContents();
    if (selectedTexts.length !== 1 || selectedTexts[0].trim() !== exactText) {
      throw new Error(`xm-select 品牌未能保持唯一选中：${selectedTexts.join(', ')}`);
    }
    return true;
  }
  return false;
}

async function applyProductFilters(frame) {
  const done = [];
  if (await selectXmOptionByText(frame, 'Kemimoto')) {
    done.push('Kemimoto');
  } else if (await selectNativeOptionByText(frame, 'Kemimoto')) {
    done.push('Kemimoto');
  } else {
    const brandSelect = await openFilterSelect(frame, {
      placeholders: ['品牌', '公司品牌'],
      values: ['Kemimoto'],
    });
    if (brandSelect) {
      await brandSelect.fill('Kemimoto').catch(() => {});
      await ensureComboboxOpen(brandSelect);
      await frame.waitForTimeout(500);
      done.push(await selectSingleOption(frame, ['Kemimoto'], brandSelect));
    } else {
      const brand = await firstVisible(frame.getByText('Kemimoto', { exact: true }));
      if (!brand) {
        console.log(JSON.stringify({
          stage: 'product-brand-diagnostic',
          url: frame.url(),
          ...(await filterControlDiagnostic(frame)),
          bodyPreview: (await frame.locator('body').innerText().catch(() => '')).slice(0, 3000),
        }, null, 2));
        throw new Error('产品档案页面未找到品牌 Kemimoto 的可选控件。');
      }
      await brand.click().catch(() => brand.evaluate((node) => node.click()));
      done.push('Kemimoto');
    }
  }

  const search = await firstVisible(frame.getByText('搜索', { exact: true }))
    || await firstVisible(frame.getByText('查询', { exact: true }));
  if (search) {
    await search.click().catch(() => search.evaluate((node) => node.click()));
    await frame.waitForTimeout(2500);
    done.push((await search.innerText().catch(() => '搜索')).trim() || '搜索');
  }
  const body = await frame.locator('body').innerText().catch(() => '');
  const resultBrands = [...body.matchAll(/品牌:\s*([^\r\n]+)/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const uniqueBrands = [...new Set(resultBrands)];
  if (uniqueBrands.length && uniqueBrands.some((brand) => brand !== 'Kemimoto')) {
    throw new Error(`产品档案搜索结果品牌不纯：${uniqueBrands.join(', ')}`);
  }
  if (uniqueBrands.length) done.push('结果品牌=Kemimoto');
  return done;
}

async function clickProductExport(frame) {
  const exportMenu = await firstVisible(frame.getByText('导出功能', { exact: true }));
  if (exportMenu) {
    await exportMenu.click().catch(() => exportMenu.evaluate((node) => node.click()));
    await frame.waitForTimeout(500);
  }
  const exportOption = await firstVisible(frame.getByText('导出(包括产品名称)', { exact: true }))
    || await firstVisible(frame.getByText('导出（包括产品名称）', { exact: true }));
  if (!exportOption) {
    const body = await frame.locator('body').innerText().catch(() => '');
    const buttons = await frame.locator('button, [role="button"], a').allTextContents().catch(() => []);
    throw new Error(`产品档案页面未找到“导出（包括产品名称）”。可见操作：${buttons.slice(0, 80).join(' / ')}；页面：${body.slice(0, 1200)}`);
  }
  await exportOption.click().catch(() => exportOption.evaluate((node) => node.click()));
}

async function openExportRecords(shellPage) {
  const context = shellPage.context();
  const beforePages = new Set(context.pages());
  const beforeFrames = new Set(shellPage.frames().map((frame) => frame.url()));
  const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await clickTextAnyFrame(shellPage, '常用操作');
  await shellPage.waitForTimeout(300);
  if (!await clickTextAnyFrame(shellPage, '导出记录')) {
    throw new Error('未能打开“常用操作 -> 导出记录”。');
  }
  const popup = await popupPromise;
  const candidatePages = popup
    ? [popup, shellPage]
    : [...context.pages()].filter((page) => !beforePages.has(page)).concat(shellPage);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const owner of candidatePages) {
      for (const frame of owner.frames()) {
        const body = await frame.locator('body').innerText().catch(() => '');
        const isNewFrame = !beforeFrames.has(frame.url());
        const looksLikeRecords = body.includes('导出记录')
          && (body.includes('状态') || body.includes('已完成') || body.includes('运算中') || body.includes('下载'));
        if ((isNewFrame || looksLikeRecords) && frame !== shellPage.mainFrame() && body.trim()) {
          console.log(JSON.stringify({
            stage: 'export-records-opened',
            pageUrl: owner.url(),
            frameUrl: frame.url(),
            bodyPreview: body.slice(0, 1200),
          }, null, 2));
          return { owner, frame };
        }
      }
    }
    await shellPage.waitForTimeout(1000);
  }
  const diagnostics = [];
  for (const owner of context.pages()) {
    for (const frame of owner.frames()) {
      diagnostics.push({
        pageUrl: owner.url(),
        frameUrl: frame.url(),
        bodyPreview: (await frame.locator('body').innerText().catch(() => '')).slice(0, 500),
      });
    }
  }
  console.log(JSON.stringify({ stage: 'export-records-diagnostic', diagnostics }, null, 2));
  throw new Error('导出记录页面未加载。');
}

function recordTimestamp(text) {
  const match = text.match(/(20\d{2})[-\/]([01]?\d)[-\/]([0-3]?\d)\s+([0-2]?\d):([0-5]?\d)(?::([0-5]?\d))?/);
  if (!match) return null;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0),
  ).getTime();
}

function isFreshProductRecord(text, exportedAt) {
  const timestamp = recordTimestamp(text);
  const named = text.includes('product_export_excel_plus_for_name')
    || text.includes('产品档案')
    || text.includes('包括产品名称');
  return named && timestamp != null && timestamp >= exportedAt - 120000;
}

async function waitForProductExportDownload(recordOwner, recordFrame, exportedAt) {
  const deadline = Date.now() + 1200000;
  let lastDiagnosticAt = 0;
  while (Date.now() < deadline) {
    const rows = recordFrame.locator('tr');
    const count = await rows.count();
    const candidates = [];
    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      const text = (await row.innerText().catch(() => '')).trim();
      if (!text) continue;
      const timestamp = recordTimestamp(text);
      if (!isFreshProductRecord(text, exportedAt)) continue;
      candidates.push({ row, text, timestamp });
    }
    candidates.sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0));
    for (const candidate of candidates.slice(0, 1)) {
      const { row, text } = candidate;
      if (text.includes('已完成')) {
        const download = row.getByText('下载', { exact: true }).first();
        if (await download.count()) {
          const downloadPromise = recordOwner.waitForEvent('download', { timeout: 180000 });
          await download.click().catch(() => download.evaluate((node) => node.click()));
          return await downloadPromise;
        }
      }
    }

    if (Date.now() - lastDiagnosticAt > 15000) {
      console.log(JSON.stringify({
        stage: 'export-records-poll',
        exportedAt: new Date(exportedAt).toISOString(),
        candidateRows: candidates.slice(0, 8).map((candidate) => candidate.text),
        rowPreview: await rows.allTextContents().then((items) => items.slice(0, 12)).catch(() => []),
      }, null, 2));
      lastDiagnosticAt = Date.now();
    }
    const recordUrl = recordFrame.url();
    if (!recordUrl || recordUrl === 'about:blank') {
      throw new Error('导出记录内页地址无效，无法刷新任务状态。');
    }
    await recordFrame.goto(recordUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await recordOwner.waitForTimeout(3000);
  }
  throw new Error('等待产品档案导出记录完成超过 20 分钟。');
}

async function openFilterSelect(frame, { placeholders, values = [] }) {
  for (const placeholder of placeholders) {
    const input = await firstVisible(frame.locator(`input[placeholder*="${placeholder}"]`));
    if (input) {
      await input.click();
      return input;
    }
    const text = await firstVisible(frame.getByText(placeholder, { exact: true }));
    if (text) {
      const select = text.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select ") or contains(concat(" ", normalize-space(@class), " "), " el-cascader ")][1]');
      if (await select.count() && await select.isVisible().catch(() => false)) {
        const combobox = select.locator('input[role="combobox"]').first();
        if (await combobox.count()) {
          await combobox.click();
          return combobox;
        }
        await select.click({ force: true });
        return select;
      }
    }
  }
  for (const value of values) {
    const input = await firstVisible(frame.locator(`input[value="${value}"]`));
    if (input) {
      await input.click();
      return input;
    }
    const text = await firstVisible(frame.getByText(value, { exact: true }));
    if (text) {
      const select = text.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select ") or contains(concat(" ", normalize-space(@class), " "), " el-cascader ")][1]');
      const combobox = select.locator('input[role="combobox"]').first();
      if (await combobox.count()) await combobox.click();
      else if (await select.count()) await select.click({ force: true });
      else await text.click();
      return await combobox.count() ? combobox : text;
    }
  }
  return null;
}

async function filterControlDiagnostic(frame) {
  const inputs = await frame.locator('input').evaluateAll((nodes) => nodes.slice(0, 80).map((node) => ({
    placeholder: node.getAttribute('placeholder'),
    value: node.value,
    class: node.className,
  }))).catch(() => []);
  const selects = await frame.locator('.el-select, .el-cascader').evaluateAll((nodes) => nodes.slice(0, 80).map((node) => ({
    text: (node.innerText || '').trim().slice(0, 120),
    class: node.className,
  }))).catch(() => []);
  return { inputs, selects };
}

async function optionChecked(option) {
  const checkbox = option.locator('input[type="checkbox"]').first();
  if (await checkbox.count()) return checkbox.isChecked().catch(() => false);
  const aria = await option.getAttribute('aria-checked').catch(() => null);
  const selected = await option.getAttribute('aria-selected').catch(() => null);
  const classes = await option.getAttribute('class').catch(() => '');
  return aria === 'true' || selected === 'true' || /is-checked|selected/.test(classes || '');
}

async function normalizeOption(option) {
  const checkboxLabel = option.locator('xpath=ancestor-or-self::label[contains(concat(" ", normalize-space(@class), " "), " el-checkbox ")][1]');
  if (await checkboxLabel.count()) return checkboxLabel;
  const roleOption = option.locator('xpath=ancestor-or-self::*[@role="option"][1]');
  if (await roleOption.count()) return roleOption;
  const dropdownItem = option.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " el-select-dropdown__item ")][1]');
  if (await dropdownItem.count()) return dropdownItem;
  return option;
}

async function controlledPopup(frame, combobox) {
  if (!combobox) return null;
  const id = await combobox.getAttribute('aria-controls').catch(() => null);
  if (!id) return null;
  const popup = frame.locator(`[id="${id}"]`).first();
  return await popup.count() ? popup : null;
}

async function visiblePopupContaining(frame, requiredTexts) {
  const popups = frame.locator('.el-popper:visible, .el-select-dropdown:visible');
  const count = await popups.count();
  for (let i = 0; i < count; i += 1) {
    const popup = popups.nth(i);
    const text = await popup.innerText().catch(() => '');
    if (requiredTexts.every((required) => text.includes(required))) return popup;
  }
  return null;
}

async function findVisibleOption(frame, aliases, combobox = null) {
  const popup = await controlledPopup(frame, combobox);
  for (const alias of aliases) {
    if (popup) {
      const controlled = popup.getByText(alias, { exact: true }).first();
      if (await controlled.count()) return { option: await normalizeOption(controlled), alias };
    }
    const candidates = [
      frame.locator('.el-popper:visible').getByText(alias, { exact: true }),
      frame.locator('label.el-checkbox').filter({ hasText: alias }),
      frame.locator('.el-select-dropdown__item').filter({ hasText: alias }),
      frame.getByRole('option', { name: alias, exact: true }),
      frame.getByText(alias, { exact: true }),
    ];
    for (const candidate of candidates) {
      const option = await firstVisible(candidate);
      if (option) return { option: await normalizeOption(option), alias };
    }
  }
  return null;
}

async function ensureComboboxOpen(combobox) {
  if (await combobox.getAttribute('role').catch(() => null) !== 'combobox') return;
  if (await combobox.getAttribute('aria-expanded').catch(() => null) !== 'true') {
    await combobox.press('ArrowDown');
    await combobox.page().waitForTimeout(300);
  }
}

async function ensureCheckboxOption(frame, aliases, combobox = null) {
  const found = await findVisibleOption(frame, aliases, combobox);
  if (!found) throw new Error(`主体下拉中未找到选项：${aliases.join(' / ')}`);
  if (!await optionChecked(found.option)) {
    await found.option.click({ timeout: 1500 }).catch(() => found.option.evaluate((node) => node.click()));
    await frame.waitForTimeout(250);
  }
  if (!await optionChecked(found.option)) throw new Error(`主体选项未能勾选：${found.alias}`);
  return found.alias;
}

async function clearOtherCheckedSubjectOptions(frame, allowedNames, combobox) {
  const popup = await controlledPopup(frame, combobox) || await visiblePopupContaining(frame, allowedNames);
  if (!popup) throw new Error('未找到同时包含三个指定中文主体名的当前可见下拉，已停止以避免误选。');
  const options = popup.locator('label.el-checkbox');
  const count = await options.count();
  for (let i = 0; i < count; i += 1) {
    const option = options.nth(i);
    if (!await option.isVisible().catch(() => false)) continue;
    const name = (await option.innerText().catch(() => '')).trim();
    if (!name || name === '全选' || allowedNames.includes(name)) continue;
    if (await optionChecked(option)) {
      await option.click({ timeout: 1500 }).catch(() => option.evaluate((node) => node.click()));
      await frame.waitForTimeout(150);
    }
  }
}

async function selectSingleOption(frame, aliases, combobox = null) {
  let found = await findVisibleOption(frame, aliases, combobox);
  if (!found && combobox) {
    await ensureComboboxOpen(combobox);
    found = await findVisibleOption(frame, aliases, combobox);
  }
  if (!found) {
    const options = await frame.locator('[role="option"], .el-select-dropdown__item, label.el-checkbox').allTextContents().catch(() => []);
    console.log(JSON.stringify({ stage: 'option-diagnostic', expected: aliases, options: options.slice(0, 100) }, null, 2));
    throw new Error(`下拉中未找到选项：${aliases.join(' / ')}`);
  }
  await found.option.click({ timeout: 1500 }).catch(() => found.option.evaluate((node) => node.click()));
  await frame.waitForTimeout(250);
  return found.alias;
}

async function waitForAuthenticated(page, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await page.locator('body').innerText().catch(() => '');
    const loginPage = /cas\/login|手机扫码登录|DINGTALK/.test(`${page.url()}\n${body}`);
    if (!loginPage && page.url().includes('erp.issyzone.net')) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

async function openReportAndApplyKnownFilters(page, config, kind) {
  const done = [];
  await page.waitForTimeout(4000);
  if (kind === 'tracking' && await findTrackingFrame(page)) done.push(config.name);
  if (!done.includes(config.name)) {
    for (const menu of ['产品模块', '产品']) {
      if (await clickTextAnyFrame(page, menu)) { done.push(menu); break; }
    }
    await page.waitForTimeout(1200);
    for (const report of [config.name, '新品成功率跟踪表', '新品成功率']) {
      if (await clickTextAnyFrame(page, report)) { done.push(config.name); break; }
    }
    await page.waitForTimeout(1200);
    for (const frame of page.frames()) {
      const reportButtons = frame.getByRole('button', { name: config.name }).last();
      if (await reportButtons.count()) {
        await reportButtons.click().catch(() => reportButtons.evaluate((node) => node.click()));
        break;
      }
    }
  }
  await page.waitForTimeout(3000);
  if (kind === 'tracking') {
    const frame = await waitForTrackingFrame(page);
    if (!frame) throw new Error('新品成功率跟踪表已打开，但未检测到平台SKU维度、搜索和导出控件。');

    const dimension = await firstVisible(frame.getByText('平台SKU维度', { exact: true }));
    if (!dimension) throw new Error('未找到“平台SKU维度”。');
    await dimension.click();
    done.push('平台SKU维度');

    const expand = await firstVisible(frame.getByText('展开', { exact: true }));
    if (expand) {
      await expand.click();
      await frame.waitForTimeout(500);
    }
    done.push('展开');

    const brandSelect = await openFilterSelect(frame, { placeholders: ['品牌'] });
    if (!brandSelect) {
      console.log(JSON.stringify({ stage: 'brand-control-diagnostic', ...(await filterControlDiagnostic(frame)) }, null, 2));
      throw new Error('未找到品牌筛选下拉。');
    }
    await brandSelect.fill('Kemimoto').catch(() => {});
    await ensureComboboxOpen(brandSelect);
    await frame.waitForTimeout(1000);
    done.push(await selectSingleOption(frame, ['Kemimoto'], brandSelect));

    const subjectSelect = await openFilterSelect(frame, { placeholders: ['主体'], values: ['KM一部'] });
    if (!subjectSelect) {
      console.log(JSON.stringify({ stage: 'subject-control-diagnostic', ...(await filterControlDiagnostic(frame)) }, null, 2));
      throw new Error('未找到主体筛选下拉。');
    }
    await subjectSelect.fill('KM一部').catch(() => {});
    await ensureComboboxOpen(subjectSelect);
    await frame.waitForTimeout(300);
    const requiredSubjects = ['KM一部一组', 'KM一部二组', 'KM一部三组'];
    await clearOtherCheckedSubjectOptions(frame, requiredSubjects, subjectSelect);
    for (const subject of requiredSubjects) done.push(await ensureCheckboxOption(frame, [subject], subjectSelect));
    await clearOtherCheckedSubjectOptions(frame, requiredSubjects, subjectSelect);
    await page.keyboard.press('Escape').catch(() => {});

    const search = await firstVisible(frame.getByText('搜索', { exact: true }));
    if (!search) throw new Error('筛选完成，但未找到“搜索”按钮。');
    await search.click();
    await page.waitForTimeout(2500);
    done.push('搜索');
  } else if (kind === 'products') {
    if (await clickTextAnyFrame(page, 'Kemimoto')) done.push('Kemimoto');
  }
  return done;
}

async function main() {
  const kind = arg('kind', 'tracking');
  const config = REPORTS[kind];
  if (!config) throw new Error('--kind 必须是 tracking 或 products');
  const outputDir = path.resolve(arg('download-dir', path.join(process.cwd(), 'downloads')));
  fs.mkdirSync(outputDir, { recursive: true });
  const executablePath = chromePath();
  if (!executablePath) throw new Error('未找到 Chrome/Edge，请设置 PLAYWRIGHT_CHROME_PATH。');

  const browser = await chromium.launch({ headless: false, executablePath });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(JSON.stringify({ stage: 'opened', url: page.url(), title: await page.title() }, null, 2));
  console.log(JSON.stringify(userActionRequiredEvent(), null, 2));
  console.log('请在浏览器中完成钉钉扫码登录，脚本会自动识别登录成功。');
  if (!await waitForAuthenticated(page)) throw new Error('等待钉钉登录超过 5 分钟，未继续执行。');
  console.log(JSON.stringify({ stage: 'authenticated', url: page.url() }, null, 2));

  if (kind === 'products') {
    const productPage = await context.newPage();
    await productPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const productFrame = await frameContaining(productPage, ['产品档案'], 30000) || productPage.mainFrame();
    const automated = ['产品档案', ...(await applyProductFilters(productFrame))];
    console.log(JSON.stringify({ stage: 'filters', automated, productUrl: productFrame.url() }, null, 2));

    const exportedAt = Date.now();
    const directDownloadPromise = productPage.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await clickProductExport(productFrame);
    let download = await directDownloadPromise;
    if (!download) {
      const records = await openExportRecords(page);
      download = await waitForProductExportDownload(records.owner, records.frame, exportedAt);
    }

    const filename = download.suggestedFilename();
    let target = path.join(outputDir, filename);
    if (fs.existsSync(target)) {
      const extension = path.extname(filename);
      target = path.join(outputDir, `${path.basename(filename, extension)}-${Date.now()}${extension}`);
    }
    await download.saveAs(target);
    const saved = fs.statSync(target);
    if (saved.mtimeMs < exportedAt - 2000) throw new Error(`下载文件时间早于本次导出：${target}`);
    console.log(JSON.stringify({ stage: 'downloaded', kind, path: target, suggestedFilename: filename }, null, 2));
    await browser.close();
    return;
  }

  if (kind === 'tracking') {
    await page.goto('https://erp.issyzone.net:9999/ipdv/#/production-research/new-product/first-order-tracking', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  }

  const automated = await openReportAndApplyKnownFilters(page, config, kind);
  console.log(JSON.stringify({ stage: 'filters', automated }, null, 2));
  if (kind !== 'tracking' && !automated.includes(config.name)) {
    const body = await page.locator('body').innerText().catch(() => '');
    console.log(JSON.stringify({ stage: 'diagnostic', frameUrls: page.frames().map((frame) => frame.url()), bodyPreview: body.slice(0, 1200) }, null, 2));
    console.log(config.instructions);
    await ask('自动打开报表失败。请手动打开并完成筛选后按 Enter');
  }
  const reportFrame = kind === 'tracking' ? await waitForTrackingFrame(page, 10000) : page;
  if (!reportFrame) throw new Error('搜索后报表页面不可用，无法导出。');
  const exportButton = reportFrame.getByText(config.exportText, { exact: true }).first();
  if (!(await exportButton.count()) || !(await exportButton.isVisible().catch(() => false))) {
    const buttons = await page.locator('button, [role="button"], a').allTextContents().catch(() => []);
    const body = await page.locator('body').innerText().catch(() => '');
    const reportNodes = await page.locator(`text=${config.name}`).evaluateAll((nodes) => nodes.slice(0, 8).map((node) => ({ tag: node.tagName, text: node.textContent, outer: node.outerHTML.slice(0, 800), parent: node.parentElement && node.parentElement.outerHTML.slice(0, 800) }))).catch(() => []);
    console.log(JSON.stringify({ stage: 'export-diagnostic', buttons: buttons.slice(0, 80), reportNodes, bodyPreview: body.slice(0, 2000) }, null, 2));
    throw new Error(`未找到“${config.exportText}”按钮。请确认当前页面和导出选项后重试。`);
  }
  const exportedAt = Date.now();
  const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
  await exportButton.click();
  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  let target = path.join(outputDir, filename);
  if (fs.existsSync(target)) {
    const extension = path.extname(filename);
    target = path.join(outputDir, `${path.basename(filename, extension)}-${Date.now()}${extension}`);
  }
  await download.saveAs(target);
  const saved = fs.statSync(target);
  if (saved.mtimeMs < exportedAt - 2000) throw new Error(`下载文件时间早于本次导出：${target}`);
  console.log(JSON.stringify({ stage: 'downloaded', kind, path: target, suggestedFilename: filename }, null, 2));
  await browser.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERP 自动化失败: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  clearOtherCheckedSubjectOptions,
  ensureCheckboxOption,
  isFreshProductRecord,
  recordTimestamp,
  selectSingleOption,
  userActionRequiredEvent,
};
