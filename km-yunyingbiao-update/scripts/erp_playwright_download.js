#!/usr/bin/env node

// ERP export downloader. The user performs DingTalk QR login; the script then
// applies the report filters, submits the export, polls the export record, and
// captures the download without storing credentials or browser state.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
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
  platform: {
    name: '我的平台SKU',
    menuPath: ['运营', '我的平台SKU'],
    menuNames: ['我的平台SKU'],
    filterLabel: '主体',
    exportTexts: ['导出（运营）', '导出(运营)', '导出'],
    recordTerms: ['replenishmentInfo', '导出备货信息', '映射-备货信息-运营'],
    outputName: '映射-备货信息-运营.xlsx',
    pageTerms: ['主体', '搜索', '导出'],
  },
  sales: {
    name: '亚马逊销售面板',
    menuPath: ['销售', 'Amazon销售面板'],
    menuNames: ['Amazon销售面板', '亚马逊销售面板', 'MSKU销售面板'],
    filterLabel: '小组',
    exportTexts: ['导出'],
    recordTerms: ['Amazon销售面板', '亚马逊销售面板', 'MSKU销售面板', 'amazon_sales'],
    outputName: '亚马逊销售面板.xlsx',
    pageTerms: ['小组', '搜索', '导出'],
  },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function selectedReportKinds(kind) {
  if (kind === 'tracking-products') return ['tracking', 'products'];
  if (kind === 'platform-sales') return ['platform', 'sales'];
  if (kind === 'step2-all') return ['tracking', 'products', 'platform', 'sales'];
  if (REPORTS[kind]) return [kind];
  throw new Error('--kind 必须是 tracking、products、tracking-products、platform、sales、platform-sales 或 step2-all');
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
      await exact.click({ noWaitAfter: true }).catch(() => exact.evaluate((node) => node.click()));
      return true;
    }
    const partial = frame.getByText(text, { exact: false }).first();
    if (await partial.count() && await partial.isVisible().catch(() => false)) {
      await partial.click({ noWaitAfter: true }).catch(() => partial.evaluate((node) => node.click()));
      return true;
    }
    if (await partial.count()) {
      await partial.evaluate((node) => node.click());
      return true;
    }
  }
  return false;
}

async function visibleExactTextInContext(context, texts) {
  for (const owner of context.pages()) {
    for (const frame of owner.frames()) {
      for (const text of texts) {
        const match = await firstVisible(frame.getByText(text, { exact: true }));
        if (match) return { owner, frame, locator: match, text };
      }
    }
  }
  return null;
}

async function visibleNormalizedButtonInContext(context, texts, timeoutMs = 5000) {
  const expected = new Set(texts.map((text) => text.replace(/\s+/g, '')));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const owner of context.pages()) {
      for (const frame of owner.frames()) {
        const buttons = frame.locator('button, [role="button"], .el-button');
        const count = await buttons.count();
        for (let i = 0; i < count; i += 1) {
          const button = buttons.nth(i);
          if (!await button.isVisible().catch(() => false)) continue;
          const text = (await button.innerText().catch(() => '')).replace(/\s+/g, '');
          if (expected.has(text)) return { owner, frame, locator: button, text };
        }
      }
    }
    await shellPageDelay(context, 250);
  }
  return null;
}

async function findMenuSearch(shellPage) {
  for (const frame of shellPage.frames()) {
    const selectors = [
      'input[placeholder*="输入并选择一个菜单"]',
      'input[placeholder*="选择一个菜单"]',
      '[role="combobox"][placeholder*="菜单"]',
      '[contenteditable="true"][data-placeholder*="菜单"]',
    ];
    for (const selector of selectors) {
      const input = await firstVisible(frame.locator(selector));
      if (input) return { frame, input };
    }
  }
  return null;
}

async function waitForReportSurface(context, config, timeoutMs = 60000, requireName = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const owner of context.pages()) {
      for (const frame of owner.frames()) {
        const body = await frame.locator('body').innerText().catch(() => '');
        const named = config.menuNames.some((name) => body.includes(name));
        const actionable = config.pageTerms.some((term) => body.includes(term))
          || config.exportTexts.some((term) => body.includes(term));
        if ((!requireName || named) && actionable) return { owner, frame };
      }
    }
    await shellPageDelay(context, 500);
  }
  return null;
}

async function shellPageDelay(context, delayMs) {
  const page = context.pages()[0];
  if (page) await page.waitForTimeout(delayMs);
}

async function openReportFromMenuSearch(shellPage, config) {
  const context = shellPage.context();
  let search = await findMenuSearch(shellPage);
  if (!search) {
    await shellPage.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await shellPage.waitForTimeout(5000);
    search = await findMenuSearch(shellPage);
  }
  if (!search) throw new Error(`ERP 顶部未找到菜单搜索框，无法打开“${config.name}”。`);

  for (const query of config.menuNames) {
    await search.input.fill('').catch(() => {});
    await search.input.fill(query).catch(async () => {
      await search.input.click();
      await shellPage.keyboard.press('Control+A');
      await shellPage.keyboard.type(query);
    });
    await search.frame.waitForTimeout(800);
    const candidate = await visibleExactTextInContext(context, config.menuNames);
    if (!candidate) continue;
    await candidate.locator.click().catch(() => candidate.locator.evaluate((node) => node.click()));
    const surface = await waitForReportSurface(context, config, 30000);
    if (surface) {
      console.log(JSON.stringify({
        stage: 'report-opened',
        kind: config.name,
        selectedMenu: candidate.text,
        pageUrl: surface.owner.url(),
        frameUrl: surface.frame.url(),
      }, null, 2));
      return surface;
    }
  }

  const suggestions = [];
  for (const frame of shellPage.frames()) {
    suggestions.push(...await frame.locator('[role="option"], .el-autocomplete-suggestion li, .el-select-dropdown__item')
      .allTextContents().catch(() => []));
  }
  throw new Error(`菜单搜索未能打开“${config.name}”。候选项：${suggestions.slice(0, 60).join(' / ')}`);
}

async function openReportFromMenuPath(shellPage, config) {
  const context = shellPage.context();
  await shellPage.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await shellPage.waitForTimeout(4000);
  for (const item of config.menuPath) {
    if (!await clickTextAnyFrame(shellPage, item)) {
      throw new Error(`ERP 菜单路径未找到“${item}”（${config.menuPath.join(' -> ')}）。`);
    }
    await shellPage.waitForTimeout(1000);
  }
  const surface = await waitForReportSurface(context, config, 30000, false);
  if (!surface) throw new Error(`已点击菜单 ${config.menuPath.join(' -> ')}，但报表页面未加载。`);
  console.log(JSON.stringify({
    stage: 'report-opened',
    kind: config.name,
    menuPath: config.menuPath,
    pageUrl: surface.owner.url(),
    frameUrl: surface.frame.url(),
  }, null, 2));
  return surface;
}

async function openConfiguredReport(shellPage, config) {
  if (config.menuPath) return openReportFromMenuPath(shellPage, config);
  return openReportFromMenuSearch(shellPage, config);
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
  await exportOption.click({ noWaitAfter: true }).catch(() => exportOption.evaluate((node) => node.click()));
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

function isFreshExportRecord(text, exportedAt, terms) {
  const timestamp = recordTimestamp(text);
  const named = terms.some((term) => text.includes(term));
  return named && timestamp != null && timestamp >= exportedAt - 120000;
}

function isFreshProductRecord(text, exportedAt) {
  return isFreshExportRecord(text, exportedAt, ['product_export_excel_plus_for_name', '产品档案', '包括产品名称']);
}

async function waitForExportRecordDownload(recordOwner, recordFrame, exportedAt, { label, recordTerms }) {
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
      if (!isFreshExportRecord(text, exportedAt, recordTerms)) continue;
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
  throw new Error(`等待${label}导出记录完成超过 20 分钟。`);
}

async function waitForProductExportDownload(recordOwner, recordFrame, exportedAt) {
  return waitForExportRecordDownload(recordOwner, recordFrame, exportedAt, {
    label: '产品档案',
    recordTerms: ['product_export_excel_plus_for_name', '产品档案', '包括产品名称'],
  });
}

async function openFilterSelect(frame, { placeholders, values = [] }) {
  for (const placeholder of placeholders) {
    const input = await firstVisible(frame.locator(`input[placeholder*="${placeholder}"]`));
    if (input) {
      await input.click({ force: true });
      return input;
    }
    const text = await firstVisible(frame.getByText(placeholder, { exact: true }));
    if (text) {
      const select = text.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select ") or contains(concat(" ", normalize-space(@class), " "), " el-cascader ")][1]');
      if (await select.count() && await select.isVisible().catch(() => false)) {
        const combobox = select.locator('input[role="combobox"]').first();
        if (await combobox.count()) {
          await combobox.click({ force: true });
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
      await input.click({ force: true });
      return input;
    }
    const text = await firstVisible(frame.getByText(value, { exact: true }));
    if (text) {
      const select = text.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select ") or contains(concat(" ", normalize-space(@class), " "), " el-cascader ")][1]');
      const combobox = select.locator('input[role="combobox"]').first();
      if (await combobox.count()) await combobox.click({ force: true });
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
  if (await checkbox.count() && await checkbox.isChecked().catch(() => false)) return true;
  return option.evaluate((node) => {
    const nodes = [node, ...node.querySelectorAll('*')];
    return nodes.some((candidate) => {
      const ariaChecked = candidate.getAttribute && candidate.getAttribute('aria-checked');
      const ariaSelected = candidate.getAttribute && candidate.getAttribute('aria-selected');
      const classes = candidate.classList ? [...candidate.classList] : [];
      return ariaChecked === 'true'
        || ariaSelected === 'true'
        || classes.some((name) => ['is-checked', 'is-selected', 'selected', 'checked'].includes(name));
    });
  }).catch(() => false);
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
  let found = await findVisibleOption(frame, aliases, combobox);
  if (!found) throw new Error(`主体下拉中未找到选项：${aliases.join(' / ')}`);
  if (!await optionChecked(found.option)) {
    const preferredTarget = found.option.locator('.el-checkbox__input, .el-checkbox__label').first();
    const clickTarget = await preferredTarget.count() ? preferredTarget : found.option;
    await clickTarget.click({ timeout: 1500 }).catch(() => found.option.evaluate((node) => node.click()));

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await frame.waitForTimeout(100);
      found = await findVisibleOption(frame, aliases, combobox);
      if (found && await optionChecked(found.option)) break;
    }
  }
  if (!found || !await optionChecked(found.option)) throw new Error(`主体选项未能勾选：${aliases[0]}`);
  return found.alias;
}

async function verifyCheckboxOptions(frame, requiredNames, combobox = null) {
  const missing = [];
  for (const name of requiredNames) {
    const found = await findVisibleOption(frame, [name], combobox);
    if (!found || !await optionChecked(found.option)) missing.push(name);
  }
  if (missing.length) throw new Error(`主体最终校验未通过，未选中：${missing.join(', ')}`);
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
    await dimension.click({ noWaitAfter: true });
    done.push('平台SKU维度');

    const expand = await firstVisible(frame.getByText('展开', { exact: true }));
    if (expand) {
      await expand.click({ noWaitAfter: true });
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
    await verifyCheckboxOptions(frame, requiredSubjects, subjectSelect);
    await page.keyboard.press('Escape').catch(() => {});

    const search = await firstVisible(frame.getByText('搜索', { exact: true }));
    if (!search) throw new Error('筛选完成，但未找到“搜索”按钮。');
    await search.click({ noWaitAfter: true });
    await page.waitForTimeout(2500);
    done.push('搜索');
  } else if (kind === 'products') {
    if (await clickTextAnyFrame(page, 'Kemimoto')) done.push('Kemimoto');
  }
  return done;
}

async function saveDownload(download, outputDir, exportedAt, kind, outputName = null) {
  const filename = download.suggestedFilename();
  let target = path.join(outputDir, outputName || filename);
  if (outputName && fs.existsSync(target)) {
    throw new Error(`下载目录已存在 ${outputName}，请使用新的运行目录，避免混入旧导出。`);
  }
  if (!outputName && fs.existsSync(target)) {
    const extension = path.extname(filename);
    target = path.join(outputDir, `${path.basename(filename, extension)}-${Date.now()}${extension}`);
  }
  await download.saveAs(target);
  const saved = fs.statSync(target);
  if (saved.mtimeMs < exportedAt - 2000) throw new Error(`下载文件时间早于本次导出：${target}`);
  console.log(JSON.stringify({ stage: 'downloaded', kind, path: target, suggestedFilename: filename }, null, 2));
  return target;
}

async function clickConfiguredExport(context, config) {
  const specificTexts = config.exportTexts.filter((text) => text !== '导出');
  let action = await visibleExactTextInContext(context, specificTexts);
  if (action) {
    await action.locator.click({ noWaitAfter: true }).catch(() => action.locator.evaluate((node) => node.click()));
    return action.text;
  }

  const trigger = await visibleExactTextInContext(context, ['导出']);
  if (!trigger) throw new Error(`${config.name} 页面未找到导出操作。`);
  await trigger.locator.click({ noWaitAfter: true }).catch(() => trigger.locator.evaluate((node) => node.click()));
  await trigger.owner.waitForTimeout(600);
  action = await visibleExactTextInContext(context, specificTexts);
  if (action) {
    await action.locator.click({ noWaitAfter: true }).catch(() => action.locator.evaluate((node) => node.click()));
    return `${trigger.text} -> ${action.text}`;
  }
  return trigger.text;
}

async function applyGenericGroupFilter(surface, config) {
  const frame = surface.frame;
  const reset = await firstVisible(frame.getByText('重置', { exact: true }));
  if (reset) {
    await reset.click({ noWaitAfter: true }).catch(() => reset.evaluate((node) => node.click()));
    await frame.waitForTimeout(500);
  }

  const groupSelect = await openFilterSelect(frame, {
    placeholders: [config.filterLabel],
    values: ['KM一部'],
  });
  if (!groupSelect) {
    console.log(JSON.stringify({
      stage: 'group-control-diagnostic',
      kind: config.name,
      label: config.filterLabel,
      ...(await filterControlDiagnostic(frame)),
    }, null, 2));
    throw new Error(`${config.name} 未找到“${config.filterLabel}”筛选框。`);
  }
  await groupSelect.fill('KM一部').catch(() => {});
  await ensureComboboxOpen(groupSelect);
  await frame.waitForTimeout(300);
  const requiredGroups = ['KM一部一组', 'KM一部二组', 'KM一部三组'];
  await clearOtherCheckedSubjectOptions(frame, requiredGroups, groupSelect);
  for (const group of requiredGroups) await ensureCheckboxOption(frame, [group], groupSelect);
  await clearOtherCheckedSubjectOptions(frame, requiredGroups, groupSelect);
  await verifyCheckboxOptions(frame, requiredGroups, groupSelect);
  await surface.owner.keyboard.press('Escape').catch(() => {});

  const search = await firstVisible(frame.getByText('搜索', { exact: true }));
  if (!search) throw new Error(`${config.name} 筛选完成，但未找到“搜索”按钮。`);
  await search.click({ noWaitAfter: true }).catch(() => search.evaluate((node) => node.click()));
  await frame.waitForTimeout(2500);
  console.log(JSON.stringify({
    stage: 'filters',
    kind: config.name,
    reset: Boolean(reset),
    field: config.filterLabel,
    groups: requiredGroups,
  }, null, 2));
}

async function downloadGenericReport(context, shellPage, outputDir, kind) {
  const config = REPORTS[kind];
  const surface = await openConfiguredReport(shellPage, config);
  await applyGenericGroupFilter(surface, config);
  const exportedAt = Date.now();
  const downloadOwners = [...new Set([surface.owner, ...context.pages()])];
  const directPromises = downloadOwners.map((owner) => owner.waitForEvent('download', { timeout: 12000 }).catch(() => null));
  const action = await clickConfiguredExport(context, config);
  let download = await Promise.race([
    ...directPromises,
    surface.owner.waitForTimeout(3000).then(() => null),
  ]);
  if (kind === 'platform' && !download) {
    const confirm = await visibleNormalizedButtonInContext(context, ['确认', '确定'], 8000);
    if (confirm) {
      await confirm.locator.click({ noWaitAfter: true }).catch(() => confirm.locator.evaluate((node) => node.click()));
    } else {
      console.log(JSON.stringify({ stage: 'export-confirm-not-shown', kind, action }, null, 2));
    }
  }
  download = download || (await Promise.all(directPromises)).find(Boolean) || null;
  if (!download) {
    const records = await openExportRecords(shellPage);
    download = await waitForExportRecordDownload(records.owner, records.frame, exportedAt, {
      label: config.name,
      recordTerms: config.recordTerms,
    });
  }
  console.log(JSON.stringify({ stage: 'export-submitted', kind, action }, null, 2));
  return saveDownload(download, outputDir, exportedAt, kind, config.outputName);
}

async function downloadTracking(context, outputDir) {
  const kind = 'tracking';
  const config = REPORTS[kind];
  const page = await context.newPage();
  await page.goto('https://erp.issyzone.net:9999/ipdv/#/production-research/new-product/first-order-tracking', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  const automated = await openReportAndApplyKnownFilters(page, config, kind);
  console.log(JSON.stringify({ stage: 'filters', automated }, null, 2));
  const reportFrame = await waitForTrackingFrame(page, 10000);
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
  await exportButton.click({ noWaitAfter: true });
  const download = await downloadPromise;
  const target = await saveDownload(download, outputDir, exportedAt, kind);
  await page.close();
  return target;
}

async function downloadProducts(context, shellPage, outputDir) {
  const kind = 'products';
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
    const records = await openExportRecords(shellPage);
    download = await waitForProductExportDownload(records.owner, records.frame, exportedAt);
  }
  const target = await saveDownload(download, outputDir, exportedAt, kind);
  await productPage.close();
  return target;
}

function trackingRequiresPlatformSales(workbook, tracking, freshAfter) {
  const bundledPython = process.env.USERPROFILE
    ? path.join(
      process.env.USERPROFILE,
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'python',
      'python.exe',
    )
    : null;
  const python = process.env.PYTHON_EXECUTABLE
    || (bundledPython && fs.existsSync(bundledPython) ? bundledPython : 'python');
  const script = path.join(__dirname, 'check_platform_sales_required.py');
  const result = spawnSync(python, [
    script,
    '--workbook', workbook,
    '--tracking', tracking,
    '--fresh-after', String(freshAfter),
  ], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`无法执行旧 Step2 平台 SKU 映射判断：${result.error?.message || result.stderr || result.stdout}`);
  }
  const summary = JSON.parse(result.stdout);
  return {
    required: Boolean(summary.required),
    eligibleRows: Number(summary.eligibleRowsAfterTrackingAppend || 0),
    summary,
  };
}

async function main() {
  const requestedKind = arg('kind', 'tracking');
  const kinds = selectedReportKinds(requestedKind);
  const outputDir = path.resolve(arg('download-dir', path.join(process.cwd(), 'downloads')));
  const workbook = arg('workbook', null);
  const freshAfter = Date.now() / 1000;
  if (requestedKind === 'step2-all' && !workbook) {
    throw new Error('--kind step2-all 必须提供 --workbook，才能沿用旧 Step2 条件判断是否下载平台映射和销售面板。');
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const executablePath = chromePath();
  if (!executablePath) throw new Error('未找到 Chrome/Edge，请设置 PLAYWRIGHT_CHROME_PATH。');

  const browser = await chromium.launch({ headless: false, executablePath });
  const context = await browser.newContext({ acceptDownloads: true });
  const shellPage = await context.newPage();
  await shellPage.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(JSON.stringify({ stage: 'opened', url: shellPage.url(), title: await shellPage.title(), kinds }, null, 2));
  console.log(JSON.stringify(userActionRequiredEvent(), null, 2));
  console.log('请在浏览器中完成钉钉扫码登录，脚本会自动识别登录成功。');
  if (!await waitForAuthenticated(shellPage)) throw new Error('等待钉钉登录超过 5 分钟，未继续执行。');
  console.log(JSON.stringify({ stage: 'authenticated', url: shellPage.url() }, null, 2));

  let trackingPath = null;
  let platformSalesDecision = null;
  for (const kind of kinds) {
    if (kind === 'tracking') trackingPath = await downloadTracking(context, outputDir);
    if (kind === 'products') await downloadProducts(context, shellPage, outputDir);
    if (kind === 'platform' || kind === 'sales') {
      if (workbook && trackingPath && platformSalesDecision == null) {
        platformSalesDecision = trackingRequiresPlatformSales(path.resolve(workbook), trackingPath, freshAfter);
        console.log(JSON.stringify({ stage: 'platform-sales-decision', ...platformSalesDecision }, null, 2));
      }
      if (platformSalesDecision && !platformSalesDecision.required) {
        console.log(JSON.stringify({
          stage: 'skipped',
          kind,
          reason: 'legacy-step2-has-no-row-requiring-platform-mapping',
        }, null, 2));
        continue;
      }
      await downloadGenericReport(context, shellPage, outputDir, kind);
    }
  }
  await browser.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERP 自动化失败: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
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
  trackingRequiresPlatformSales,
  userActionRequiredEvent,
  verifyCheckboxOptions,
};
