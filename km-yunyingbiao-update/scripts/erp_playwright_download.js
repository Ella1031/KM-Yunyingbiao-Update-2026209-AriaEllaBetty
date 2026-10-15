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
let filterControlSequence = 0;

const REQUIRED_KM_GROUPS = [
  { name: 'KM一部一组', aliases: ['KM一部一组'] },
  { name: 'KM一部二组', aliases: ['KM一部二组'] },
  { name: 'KM一部三组', aliases: ['KM一部三组'] },
];

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
    nestedExport: true,
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

async function isFrameSurfaceVisible(frame) {
  if (frame === frame.page().mainFrame()) return true;
  const frameElement = await frame.frameElement().catch(() => null);
  return Boolean(frameElement && await frameElement.isVisible().catch(() => false));
}

async function waitForReportSurface(context, config, timeoutMs = 60000, requireName = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const owner of context.pages()) {
      for (const frame of owner.frames()) {
        if (!await isFrameSurfaceVisible(frame)) continue;
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
    let candidate = null;
    const suggestionSelectors = [
      '[role="option"]',
      '.el-autocomplete-suggestion li',
      '.el-select-dropdown__item',
      '.el-menu-item',
    ];
    for (const selector of suggestionSelectors) {
      for (const name of config.menuNames) {
        const option = await firstVisible(search.frame.locator(selector).filter({ hasText: name }));
        if (!option) continue;
        const text = String(await option.innerText().catch(() => name)).trim();
        if (config.menuNames.includes(text)) {
          candidate = { owner: shellPage, frame: search.frame, locator: option, text };
          break;
        }
      }
      if (candidate) break;
    }
    if (!candidate) {
      for (const name of config.menuNames) {
        const exact = await firstVisible(search.frame.getByText(name, { exact: true }));
        if (exact) {
          candidate = { owner: shellPage, frame: search.frame, locator: exact, text: name };
          break;
        }
      }
    }
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

async function activateConfiguredReportTab(shellPage, config) {
  const mainFrame = shellPage.mainFrame();
  for (const name of config.menuNames) {
    const tabs = mainFrame.locator('.tabTitle a, [class*="tabTitle"] a, [class*="tabs"] a').filter({ hasText: name });
    const count = await tabs.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const tab = tabs.nth(i);
      if (!await tab.isVisible().catch(() => false)) continue;
      const text = String(await tab.innerText().catch(() => '')).replace(/[\s×xX✕✖]+/g, '');
      if (!text.includes(name.replace(/\s+/g, ''))) continue;
      await tab.click({ noWaitAfter: true }).catch(() => tab.evaluate((node) => node.click()));
      await shellPage.waitForTimeout(800);
      break;
    }
  }
  const surface = await waitForReportSurface(shellPage.context(), config, 10000, false);
  if (!surface) throw new Error(`${config.name} 顶部页签激活后未找到可见报表页面。`);
  return surface;
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

async function stableFilterControl(frame, locator) {
  const token = `codex-filter-${Date.now()}-${filterControlSequence += 1}`;
  await locator.evaluate((node, value) => node.setAttribute('data-codex-filter-control', value), token);
  return frame.locator(`[data-codex-filter-control="${token}"]`);
}

async function openFilterSelect(frame, { placeholders, values = [] }) {
  for (const placeholder of placeholders) {
    const input = await firstVisible(frame.locator(`input[placeholder*="${placeholder}"]`));
    if (input) {
      await input.click({ force: true });
      return stableFilterControl(frame, input);
    }
    const text = await firstVisible(frame.getByText(placeholder, { exact: true }));
    if (text) {
      const select = text.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select ") or contains(concat(" ", normalize-space(@class), " "), " el-cascader ")][1]');
      if (await select.count() && await select.isVisible().catch(() => false)) {
        const combobox = select.locator('input[role="combobox"]').first();
        if (await combobox.count()) {
          await combobox.click({ force: true });
          return stableFilterControl(frame, combobox);
        }
        await select.click({ force: true });
        return stableFilterControl(frame, select);
      }
    }
  }
  for (const value of values) {
    const input = await firstVisible(frame.locator(`input[value="${value}"]`));
    if (input) {
      await input.click({ force: true });
      return stableFilterControl(frame, input);
    }
    const text = await firstVisible(frame.getByText(value, { exact: true }));
    if (text) {
      const select = text.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select ") or contains(concat(" ", normalize-space(@class), " "), " el-cascader ")][1]');
      const combobox = select.locator('input[role="combobox"]').first();
      if (await combobox.count()) await combobox.click({ force: true });
      else if (await select.count()) await select.click({ force: true });
      else await text.click();
      return stableFilterControl(frame, await combobox.count() ? combobox : text);
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

const OPTION_SELECTOR = [
  'label.el-checkbox',
  '[role="option"]',
  '.el-select-dropdown__item',
  '.el-cascader-node',
  '.ant-select-item-option',
  '.vue-treeselect__option',
].join(', ');

const POPUP_SELECTOR = [
  '.el-popper:visible',
  '.el-select-dropdown:visible',
  '.el-cascader__dropdown:visible',
  '.ant-select-dropdown:visible',
  '.vue-treeselect__menu:visible',
  '[role="listbox"]:visible',
].join(', ');

async function selectionControlRoot(combobox) {
  if (!combobox || !await combobox.count()) return null;
  const root = combobox.locator([
    'xpath=ancestor::*[',
    'contains(concat(" ", normalize-space(@class), " "), " el-select ")',
    ' or contains(concat(" ", normalize-space(@class), " "), " el-cascader ")',
    ' or contains(concat(" ", normalize-space(@class), " "), " ant-select ")',
    ' or contains(concat(" ", normalize-space(@class), " "), " vue-treeselect ")',
    '][1]',
  ].join(''));
  if (await root.count()) return root.first();
  return combobox.locator('xpath=parent::*').first();
}

async function selectedControlTexts(combobox) {
  const root = await selectionControlRoot(combobox);
  if (!root || !await root.count()) return [];
  const texts = await root.locator([
    '.el-tag',
    '.el-select__tags-text',
    '.el-select__selected-item',
    '.ant-select-selection-item',
    '.vue-treeselect__multi-value-item',
    '[data-selected="true"]',
  ].join(', ')).evaluateAll((nodes) => nodes.map((node) => (
    node.getAttribute('title') || node.textContent || ''
  ))).catch(() => []);
  return texts
    .flatMap((text) => text.split(/[\r\n,，]/))
    .map((text) => text.replace(/[×x]\s*$/, '').replace(/\s+/g, ''))
    .filter(Boolean);
}

async function selectionStateDiagnostic(frame, combobox) {
  const root = await selectionControlRoot(combobox);
  const controlled = await controlledPopup(frame, combobox);
  const visiblePopups = frame.locator(POPUP_SELECTOR);
  const popupCount = await visiblePopups.count().catch(() => 0);
  const popups = [];
  for (let i = 0; i < Math.min(popupCount, 8); i += 1) {
    const popup = visiblePopups.nth(i);
    popups.push({
      text: (await popup.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 2000),
      html: (await popup.evaluate((node) => node.outerHTML).catch(() => '')).slice(0, 6000),
      options: await popup.locator(OPTION_SELECTOR).evaluateAll((nodes) => nodes.slice(0, 80).map((node) => ({
        text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
        class: node.className,
        ariaChecked: node.getAttribute('aria-checked'),
        ariaSelected: node.getAttribute('aria-selected'),
        checked: Boolean(node.querySelector('input[type="checkbox"]')?.checked),
      }))).catch(() => []),
    });
  }
  return {
    comboboxHtml: combobox && await combobox.count()
      ? (await combobox.evaluate((node) => node.outerHTML).catch(() => '')).slice(0, 3000)
      : '',
    controlHtml: root && await root.count()
      ? (await root.evaluate((node) => node.outerHTML).catch(() => '')).slice(0, 6000)
      : '',
    selectedTexts: await selectedControlTexts(combobox),
    controlledPopupHtml: controlled
      ? (await controlled.evaluate((node) => node.outerHTML).catch(() => '')).slice(0, 6000)
      : '',
    popups,
  };
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
  const genericOption = option.locator('xpath=ancestor-or-self::*[@role="option" or contains(concat(" ", normalize-space(@class), " "), " ant-select-item-option ") or contains(concat(" ", normalize-space(@class), " "), " el-cascader-node ")][1]');
  if (await genericOption.count()) return genericOption;
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
  const popups = frame.locator(POPUP_SELECTOR);
  const count = await popups.count();
  for (let i = 0; i < count; i += 1) {
    const popup = popups.nth(i);
    const text = await popup.innerText().catch(() => '');
    if (requiredTexts.every((required) => text.includes(required))) return popup;
  }
  return null;
}

function normalizeRequiredOptions(requiredOptions) {
  return requiredOptions.map((item) => {
    if (typeof item === 'string') return { name: item, aliases: [item] };
    if (Array.isArray(item)) return { name: item[0], aliases: item };
    return item;
  });
}

function normalizedOptionText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '');
}

function optionTextMatchesAlias(text, alias) {
  const candidate = normalizedOptionText(text);
  const expected = normalizedOptionText(alias);
  return candidate === expected
    || candidate.endsWith(`【${expected}】`)
    || candidate.endsWith(`[${expected}]`);
}

async function visiblePopupContainingOptions(frame, requiredOptions) {
  const options = normalizeRequiredOptions(requiredOptions);
  const popups = frame.locator(POPUP_SELECTOR);
  const count = await popups.count();
  for (let i = 0; i < count; i += 1) {
    const popup = popups.nth(i);
    const text = (await popup.innerText().catch(() => '')).replace(/\s+/g, '');
    if (options.every((option) => option.aliases.some((alias) => text.includes(alias.replace(/\s+/g, ''))))) {
      return popup;
    }
  }
  return null;
}

async function findVisibleOption(frame, aliases, combobox = null) {
  const popup = await controlledPopup(frame, combobox);
  async function exactOptionIn(container) {
    const candidates = container.locator(OPTION_SELECTOR);
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const text = await candidate.innerText().catch(() => '');
      const alias = aliases.find((item) => optionTextMatchesAlias(text, item));
      if (alias) return { option: await normalizeOption(candidate), alias };
    }
    return null;
  }
  if (popup) {
    const exact = await exactOptionIn(popup);
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const candidates = [
      frame.locator('.el-popper:visible').getByText(alias, { exact: true }),
      frame.locator('label.el-checkbox').filter({ hasText: alias }),
      frame.locator('.el-select-dropdown__item').filter({ hasText: alias }),
      frame.locator('.ant-select-item-option, .el-cascader-node, .vue-treeselect__option').filter({ hasText: alias }),
      frame.getByRole('option', { name: alias, exact: true }),
      frame.getByText(alias, { exact: true }),
    ];
    for (const candidate of candidates) {
      const option = await firstVisible(candidate);
      if (option) return { option: await normalizeOption(option), alias };
    }
  }
  if (popup) {
    const labels = popup.locator(OPTION_SELECTOR);
    const count = await labels.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = labels.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const text = await candidate.innerText().catch(() => '');
      const alias = aliases.find((item) => optionTextMatchesAlias(text, item));
      if (alias) return { option: await normalizeOption(candidate), alias };
    }
  }
  return null;
}

async function ensureComboboxOpen(combobox) {
  if (!combobox || !await combobox.count()) return;
  if (await combobox.getAttribute('role').catch(() => null) !== 'combobox') return;
  if (await combobox.getAttribute('aria-expanded').catch(() => null) !== 'true') {
    const filterValue = await combobox.inputValue().catch(() => '');
    await combobox.click({ force: true, noWaitAfter: true }).catch(() => {});
    await combobox.page().waitForTimeout(150);
    if (filterValue && (await combobox.inputValue().catch(() => '')) !== filterValue) {
      await combobox.fill(filterValue).catch(() => {});
      await combobox.page().waitForTimeout(250);
    }
    await combobox.press('ArrowDown');
    await combobox.page().waitForTimeout(300);
  }
}

async function comboboxHasSelection(combobox, aliases) {
  if (!combobox || !await combobox.count()) return false;
  const normalized = await selectedControlTexts(combobox);
  return aliases.some((alias) => normalized.some((text) => optionTextMatchesAlias(text, alias)));
}

async function frameHasCheckedOption(frame, aliases) {
  const expected = aliases.map((alias) => normalizedOptionText(alias));
  return frame.locator(OPTION_SELECTOR).evaluateAll((nodes, names) => nodes.some((node) => {
    const text = (node.textContent || '').normalize('NFKC').replace(/\s+/g, '');
    const classNames = String(node.className || '').split(/\s+/);
    const checked = Boolean(node.querySelector('input[type="checkbox"]')?.checked)
      || node.getAttribute('aria-checked') === 'true'
      || node.getAttribute('aria-selected') === 'true'
      || ['is-checked', 'is-selected', 'selected', 'checked', 'ant-select-item-option-selected']
        .some((name) => classNames.includes(name))
      || Boolean(node.querySelector('.el-checkbox__input.is-checked, [aria-checked="true"], [aria-selected="true"]'));
    const matches = names.some((name) => text === name
      || text.endsWith(`【${name}】`)
      || text.endsWith(`[${name}]`));
    return matches && checked;
  }), expected).catch(() => false);
}

async function findCheckboxOptionWithScroll(frame, aliases, combobox) {
  let found = await findVisibleOption(frame, aliases, combobox);
  if (found) return found;
  const popup = await controlledPopup(frame, combobox);
  if (!popup) return null;
  const candidates = [popup, ...Array.from({ length: Math.min(await popup.locator('*').count(), 160) }, (_, index) => popup.locator('*').nth(index))];
  for (const scroller of candidates) {
    const metrics = await scroller.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      overflowY: getComputedStyle(node).overflowY,
    })).catch(() => null);
    if (!metrics || metrics.clientHeight <= 0 || metrics.scrollHeight <= metrics.clientHeight + 5) continue;
    const step = Math.max(80, Math.floor(metrics.clientHeight * 0.65));
    for (let top = 0; top <= metrics.scrollHeight; top += step) {
      await scroller.evaluate((node, value) => { node.scrollTop = value; }, top);
      await frame.waitForTimeout(180);
      found = await findVisibleOption(frame, aliases, combobox);
      if (found) return found;
    }
  }
  return null;
}

async function findCheckboxOptionAnyVisibility(frame, aliases, combobox) {
  const popup = await controlledPopup(frame, combobox);
  const candidates = popup ? popup.locator(OPTION_SELECTOR) : frame.locator(OPTION_SELECTOR);
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    const text = await candidate.textContent().catch(() => '');
    const alias = aliases.find((item) => optionTextMatchesAlias(text, item));
    if (alias) return { option: candidate, alias };
  }
  return null;
}

async function ensureCheckboxOption(frame, aliases, combobox = null) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (combobox) {
      await combobox.fill('KM一').catch(() => {});
      await frame.waitForTimeout(250);
    }
    if (combobox) await ensureComboboxOpen(combobox);
    let found = await findCheckboxOptionWithScroll(frame, aliases, combobox);
    if (await comboboxHasSelection(combobox, aliases)) return aliases[0];
    if (!found) {
      found = await findCheckboxOptionAnyVisibility(frame, aliases, combobox);
      if (!found) {
        await frame.waitForTimeout(250);
        continue;
      }
    }
    if (await optionChecked(found.option)) return found.alias;
    const checkboxLabel = found.option.locator(
      'xpath=ancestor-or-self::label[contains(concat(" ", normalize-space(@class), " "), " el-checkbox ")][1]',
    ).first();
    const clickTargets = [checkboxLabel, found.option];
    let clicked = false;
    for (const target of clickTargets) {
      if (!await target.count()) continue;
      clicked = await target.click({ force: true, noWaitAfter: true, timeout: 1200 })
        .then(() => true)
        .catch(() => false);
      if (clicked) break;
    }
    if (!clicked) {
      await found.option.evaluate((node) => {
        const label = node.matches('label') ? node : node.closest('label') || node;
        const input = label.querySelector('input[type="checkbox"]');
        if (input && !input.checked) input.click();
        else label.click();
      });
    }

    await frame.waitForTimeout(350);
    const refreshedPopup = await controlledPopup(frame, combobox);
    const refreshedChecked = refreshedPopup
      ? await refreshedPopup.locator('label.el-checkbox').evaluateAll((labels, expected) => labels.some((label) => {
        const text = (label.innerText || '').replace(/\s+/g, '');
        const checked = Boolean(label.querySelector('input[type="checkbox"]')?.checked)
          || label.classList.contains('is-checked');
        return expected.includes(text) && checked;
      }), aliases.map((alias) => alias.replace(/\s+/g, ''))).catch(() => false)
      : false;
    const frameChecked = await frameHasCheckedOption(frame, aliases);
    if (refreshedChecked || frameChecked) return aliases[0];
    if (await optionChecked(found.option)) return found.alias;
    if (!(await comboboxHasSelection(combobox, aliases)) && !(await optionChecked(found.option))) {
      await found.option.evaluate((node) => {
        const label = node.matches('label') ? node : node.closest('label') || node;
        const input = label.querySelector('input[type="checkbox"]');
        if (input && !input.checked) {
          input.click();
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }).catch(() => {});
      await frame.waitForTimeout(350);
    }
    if (combobox) await ensureComboboxOpen(combobox);
    found = await findCheckboxOptionWithScroll(frame, aliases, combobox);
    if (await comboboxHasSelection(combobox, aliases)) return aliases[0];
    if (found && (await comboboxHasSelection(combobox, aliases) || await optionChecked(found.option))) return found.alias;
  }

  const popup = await controlledPopup(frame, combobox);
  const states = popup
    ? await popup.locator('label.el-checkbox').evaluateAll((labels) => labels.map((label) => ({
      text: (label.innerText || '').trim(),
      checked: Boolean(label.querySelector('input[type="checkbox"]')?.checked),
      class: label.className,
    }))).catch(() => [])
    : [];
  if (await frameHasCheckedOption(frame, aliases)) return aliases[0];
  console.log(JSON.stringify({
    stage: 'checkbox-selection-failed',
    expected: aliases,
    ariaExpanded: combobox && await combobox.count()
      ? await combobox.getAttribute('aria-expanded').catch(() => null)
      : null,
    states,
  }, null, 2));
  throw new Error(`主体选项未能勾选：${aliases[0]}`);
}

async function verifyCheckboxOptions(frame, requiredOptions, combobox = null) {
  const options = normalizeRequiredOptions(requiredOptions);
  const missing = [];
  for (const option of options) {
    const found = await findCheckboxOptionWithScroll(frame, option.aliases, combobox);
    const selectedTag = await comboboxHasSelection(combobox, option.aliases);
    const checkedInFrame = await frameHasCheckedOption(frame, option.aliases);
    if (!selectedTag && !checkedInFrame && (!found || !await optionChecked(found.option))) missing.push(option.name);
  }
  if (missing.length) {
    console.log(JSON.stringify({
      stage: 'checkbox-final-verification-failed',
      requiredNames: options.map((option) => option.name),
      missing,
      ...(await selectionStateDiagnostic(frame, combobox)),
    }, null, 2));
    throw new Error(`主体最终校验未通过，未选中：${missing.join(', ')}`);
  }
}

async function clearOtherCheckedSubjectOptions(frame, allowedNames, combobox) {
  const optionsToKeep = normalizeRequiredOptions(allowedNames);
  const popup = await controlledPopup(frame, combobox)
    || await visiblePopupContainingOptions(frame, optionsToKeep);
  if (!popup) throw new Error('未找到同时包含三个指定主体的当前可见下拉，已停止以避免误选。');
  const options = popup.locator('label.el-checkbox');
  const allowed = optionsToKeep.flatMap((option) => option.aliases);
  const count = await options.count();
  for (let i = 0; i < count; i += 1) {
    const option = options.nth(i);
    if (!await option.isVisible().catch(() => false)) continue;
    const name = await option.innerText().catch(() => '');
    if (!normalizedOptionText(name)
      || normalizedOptionText(name) === '全选'
      || allowed.some((alias) => optionTextMatchesAlias(name, alias))) continue;
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

    const subjectSelect = await openFilterSelect(frame, { placeholders: ['主体'], values: ['KM一', 'KM一部'] });
    if (!subjectSelect) {
      console.log(JSON.stringify({ stage: 'subject-control-diagnostic', ...(await filterControlDiagnostic(frame)) }, null, 2));
      throw new Error('未找到主体筛选下拉。');
    }
    await subjectSelect.fill('KM一').catch(() => {});
    await ensureComboboxOpen(subjectSelect);
    await frame.waitForTimeout(300);
    const requiredSubjects = REQUIRED_KM_GROUPS;
    await clearOtherCheckedSubjectOptions(frame, requiredSubjects, subjectSelect);
    for (const subject of requiredSubjects) {
      await ensureCheckboxOption(frame, subject.aliases, subjectSelect);
      done.push(subject.name);
    }
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

function safeDiagnosticUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(rawUrl).split('?')[0];
  }
}

function responseDiagnostic(response) {
  const request = response.request();
  const headers = response.headers();
  return {
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status(),
    url: safeDiagnosticUrl(response.url()),
    contentType: headers['content-type'] || '',
    contentDisposition: headers['content-disposition'] || '',
    contentLength: headers['content-length'] || '',
  };
}

function requestDiagnostic(request) {
  return {
    method: request.method(),
    resourceType: request.resourceType(),
    url: safeDiagnosticUrl(request.url()),
    postDataSize: Buffer.byteLength(request.postData() || ''),
  };
}

function isExcelResponseDiagnostic(diagnostic) {
  const contentType = diagnostic.contentType.toLowerCase();
  const disposition = diagnostic.contentDisposition.toLowerCase();
  const exportLikeUrl = /(?:export|download|excel|file|replenish)/i.test(diagnostic.url || '');
  return (
    contentType.includes('spreadsheetml')
    || contentType.includes('ms-excel')
    || disposition.includes('.xlsx')
    || disposition.includes('.xls')
    || (contentType.includes('octet-stream') && exportLikeUrl)
  );
}

function isWorkbookBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const zip = buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  const ole = buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
  return zip || ole;
}

function saveResponseWorkbook(buffer, outputDir, exportedAt, kind, outputName) {
  if (!isWorkbookBuffer(buffer)) throw new Error('导出响应不是有效的 XLSX/XLS 工作簿。');
  const target = path.join(outputDir, outputName);
  if (fs.existsSync(target)) {
    throw new Error(`下载目录已存在 ${outputName}，请使用新的运行目录，避免混入旧导出。`);
  }
  fs.writeFileSync(target, buffer);
  const saved = fs.statSync(target);
  if (saved.mtimeMs < exportedAt - 2000) throw new Error(`下载文件时间早于本次导出：${target}`);
  console.log(JSON.stringify({
    stage: 'downloaded',
    kind,
    path: target,
    suggestedFilename: outputName,
    source: 'excel-response-body',
  }, null, 2));
  return target;
}

function createExportResponseMonitor(context, owners, startedAt) {
  const diagnostics = { requests: [], responses: [], consoleErrors: [], pageErrors: [] };
  let resolveWorkbook;
  const workbookPromise = new Promise((resolve) => { resolveWorkbook = resolve; });
  let workbookResolved = false;
  let exportRequestLogged = false;
  const listeners = [];

  const requestListener = (request) => {
    if (Date.now() < startedAt) return;
    const diagnostic = requestDiagnostic(request);
    if (!['xhr', 'fetch', 'document'].includes(diagnostic.resourceType)) return;
    diagnostics.requests.push(diagnostic);
    if (diagnostics.requests.length > 100) diagnostics.requests.shift();
    if (!exportRequestLogged && diagnostic.url.includes('/exportExcelByOperationType')) {
      exportRequestLogged = true;
      console.log(JSON.stringify({ stage: 'platform-export-request-started', ...diagnostic }, null, 2));
    }
  };
  const responseListener = async (response) => {
    if (Date.now() < startedAt) return;
    const diagnostic = responseDiagnostic(response);
    if (!['xhr', 'fetch', 'document'].includes(diagnostic.resourceType)) return;
    diagnostics.responses.push(diagnostic);
    if (diagnostics.responses.length > 100) diagnostics.responses.shift();
    const isPlatformExportResponse = diagnostic.url.includes('/exportExcelByOperationType');
    if ((!isExcelResponseDiagnostic(diagnostic) && !isPlatformExportResponse) || workbookResolved) return;
    const body = await response.body().catch(() => null);
    if (!isWorkbookBuffer(body) || workbookResolved) return;
    workbookResolved = true;
    resolveWorkbook({ body, diagnostic });
  };
  context.on('request', requestListener);
  context.on('response', responseListener);
  listeners.push({ owner: context, event: 'request', listener: requestListener });
  listeners.push({ owner: context, event: 'response', listener: responseListener });

  const attachPage = (owner) => {
    const consoleListener = (message) => {
      if (Date.now() < startedAt || !['error', 'warning'].includes(message.type())) return;
      diagnostics.consoleErrors.push({ type: message.type(), text: message.text().slice(0, 1000) });
      if (diagnostics.consoleErrors.length > 30) diagnostics.consoleErrors.shift();
    };
    const pageErrorListener = (error) => {
      if (Date.now() < startedAt) return;
      diagnostics.pageErrors.push(String(error.message || error).slice(0, 1000));
      if (diagnostics.pageErrors.length > 30) diagnostics.pageErrors.shift();
    };
    owner.on('console', consoleListener);
    owner.on('pageerror', pageErrorListener);
    listeners.push({ owner, event: 'console', listener: consoleListener });
    listeners.push({ owner, event: 'pageerror', listener: pageErrorListener });
  };
  for (const owner of owners) attachPage(owner);
  const pageListener = (owner) => attachPage(owner);
  context.on('page', pageListener);
  listeners.push({ owner: context, event: 'page', listener: pageListener });

  return {
    diagnostics,
    workbookPromise,
    stop() {
      for (const { owner, event, listener } of listeners) owner.off(event, listener);
      if (!workbookResolved) resolveWorkbook(null);
    },
  };
}

async function installClientExportTrace(frame) {
  await frame.evaluate(() => {
    if (window.__codexExportTraceInstalled) return;
    window.__codexExportTraceInstalled = true;
    window.__codexExportTrace = [];
    window.__codexExportBlobs = [];
    const trace = (event) => window.__codexExportTrace.push({ at: Date.now(), ...event });
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      if (value instanceof Blob) {
        window.__codexExportBlobs.push(value);
        trace({ type: 'create-object-url', mime: value.type || '', size: value.size });
      }
      return originalCreateObjectURL(value);
    };
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function tracedAnchorClick() {
      trace({
        type: 'anchor-click',
        download: this.download || '',
        href: String(this.href || '').split('?')[0].slice(0, 300),
      });
      return originalAnchorClick.call(this);
    };
    const originalOpen = window.open;
    window.open = function tracedWindowOpen(url, ...args) {
      trace({ type: 'window-open', url: String(url || '').split('?')[0].slice(0, 300) });
      return originalOpen.call(this, url, ...args);
    };
  }).catch(() => {});
}

async function clientExportTrace(frame) {
  return frame.evaluate(() => ({
    events: Array.isArray(window.__codexExportTrace) ? window.__codexExportTrace.slice(-50) : [],
    blobCount: Array.isArray(window.__codexExportBlobs) ? window.__codexExportBlobs.length : 0,
  })).catch(() => ({ events: [], blobCount: 0 }));
}

async function retryTracedBlobDownload(frame, owner, outputName) {
  const trace = await clientExportTrace(frame);
  if (!trace.blobCount) return { download: null, trace };
  const downloadPromise = owner.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  await frame.evaluate((name) => {
    const blob = window.__codexExportBlobs?.[window.__codexExportBlobs.length - 1];
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  }, outputName);
  return { download: await downloadPromise, trace: await clientExportTrace(frame) };
}

async function collectExportFeedback(frame) {
  const selectors = [
    '.el-message',
    '.el-notification',
    '[role="alert"]',
    '.ant-message-notice',
    '.ant-notification-notice',
    '.toast',
  ];
  const feedback = [];
  for (const selector of selectors) {
    const items = frame.locator(selector);
    const count = Math.min(await items.count().catch(() => 0), 20);
    for (let i = 0; i < count; i += 1) {
      const item = items.nth(i);
      if (!await item.isVisible().catch(() => false)) continue;
      const text = (await item.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (text && !feedback.includes(text)) feedback.push(text);
    }
  }
  return feedback.slice(0, 20);
}

async function visibleNormalizedAction(frames, texts) {
  const expected = new Set(texts.map((text) => text.replace(/\s+/g, '')));
  for (const frame of frames) {
    const actions = frame.locator(
      'button, a, input[type="button"], input[type="submit"], [role="button"], [role="menuitem"], .el-dropdown-menu__item, .el-button',
    );
    const count = await actions.count();
    for (let i = 0; i < count; i += 1) {
      const action = actions.nth(i);
      if (!await action.isVisible().catch(() => false)) continue;
      const text = String((
        await action.innerText().catch(() => '')
        || await action.getAttribute('value').catch(() => '')
        || await action.getAttribute('aria-label').catch(() => '')
        || ''
      )).replace(/\s+/g, '');
      if (expected.has(text)) return { frame, locator: action, text };
    }
    for (const expectedText of texts) {
      const textMatches = frame.getByText(expectedText, { exact: true });
      const matchCount = await textMatches.count().catch(() => 0);
      for (let i = 0; i < matchCount; i += 1) {
        const match = textMatches.nth(i);
        if (!await match.isVisible().catch(() => false)) continue;
        const text = String(await match.innerText().catch(() => expectedText)).replace(/\s+/g, '');
        if (expected.has(text)) {
          const clickable = match.locator(
            'xpath=ancestor-or-self::*[self::button or self::a or @role="button" or @role="menuitem" or contains(concat(" ", normalize-space(@class), " "), " el-button ") or contains(@class, "dropdown")][1]',
          ).first();
          return { frame, locator: await clickable.count() ? clickable : match, text };
        }
      }
    }
  }
  return null;
}

async function findNestedExportTrigger(frames) {
  let best = null;
  for (const frame of frames) {
    const toolbarButtons = frame.locator([
      '.table-btn button[aria-haspopup="menu"]',
      '.table-btn [role="button"][aria-haspopup="menu"]',
    ].join(', '));
    const toolbarCount = await toolbarButtons.count().catch(() => 0);
    for (let i = 0; i < toolbarCount; i += 1) {
      const button = toolbarButtons.nth(i);
      if (!await button.isVisible().catch(() => false)) continue;
      const text = String(await button.innerText().catch(() => '')).replace(/\s+/g, '');
      if (text === '导出') return { frame, locator: button, text, score: 1000 + i };
    }

    const preferred = frame.locator([
      'button[aria-haspopup="menu"]',
      '[role="button"][aria-haspopup="menu"]',
      '.el-dropdown button',
    ].join(', ')).filter({ hasText: '导出' });
    const preferredCount = await preferred.count().catch(() => 0);
    for (let i = 0; i < preferredCount; i += 1) {
      const button = preferred.nth(i);
      if (!await button.isVisible().catch(() => false)) continue;
      const text = String(await button.innerText().catch(() => '')).replace(/\s+/g, '');
      if (text === '导出') return { frame, locator: button, text, score: 950 + i };
    }

    const labels = frame.getByText('导出', { exact: true });
    const labelCount = await labels.count().catch(() => 0);
    for (let i = 0; i < labelCount; i += 1) {
      const label = labels.nth(i);
      if (!await label.isVisible().catch(() => false)) continue;
      const button = label.locator(
        'xpath=ancestor-or-self::*[self::button or @role="button" or @aria-haspopup="menu"][1]',
      ).first();
      if (!await button.count().catch(() => 0)) continue;
      const popup = await button.getAttribute('aria-haspopup').catch(() => null);
      const dropdown = await button.evaluate((node) => Boolean(node.closest('.table-btn, .el-dropdown, [class*="dropdown"]'))).catch(() => false);
      if (popup === 'menu' || dropdown) return { frame, locator: button, text: '导出', score: 900 + i };
    }

    const buttons = frame.locator('button, [role="button"]');
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      const text = String(await button.innerText().catch(() => '')).replace(/\s+/g, '');
      if (text !== '导出') continue;
      const score = await button.evaluate((node, index) => {
        const ancestor = node.closest('[class*="dropdown"], [aria-haspopup="menu"], [aria-haspopup="listbox"]');
        const hasArrow = Boolean(node.querySelector('i, svg, [class*="arrow"], [class*="caret"]'));
        const popup = node.getAttribute('aria-haspopup');
        return (ancestor ? 100 : 0) + (hasArrow ? 50 : 0) + (popup ? 25 : 0) + index;
      }, i).catch(() => i);
      if (!best || score >= best.score) best = { frame, locator: button, text, score };
    }
  }
  return best;
}

async function clickConfiguredExport(surface, config) {
  const ownerFrames = [surface.frame];
  const specificTexts = config.exportTexts.filter((text) => text !== '导出');
  let action = config.nestedExport ? null : await visibleNormalizedAction(ownerFrames, specificTexts);
  if (!config.nestedExport && action) {
    await action.locator.click({ noWaitAfter: true }).catch(() => action.locator.evaluate((node) => node.click()));
    return action.text;
  }

  const trigger = config.nestedExport
    ? await findNestedExportTrigger(ownerFrames)
    : await visibleNormalizedAction(ownerFrames, ['导出']);
  if (!trigger) throw new Error(`${config.name} 页面未找到导出操作。`);
  await trigger.locator.hover().catch(() => {});
  await trigger.locator.click({ noWaitAfter: true }).catch(() => trigger.locator.evaluate((node) => node.click()));
  console.log(JSON.stringify({ stage: 'export-trigger-clicked', kind: config.name, action: trigger.text }, null, 2));
  await surface.owner.waitForTimeout(1200);
  action = await visibleNormalizedAction(ownerFrames, specificTexts);
  if (!action && config.nestedExport) {
    const innerArrow = trigger.locator.locator('i:visible, svg:visible, [class*="arrow"]:visible, [class*="caret"]:visible').last();
    if (await innerArrow.count()) {
      await innerArrow.hover().catch(() => {});
      await innerArrow.click({ force: true, noWaitAfter: true }).catch(() => innerArrow.evaluate((node) => node.click()));
      await surface.owner.waitForTimeout(1200);
      action = await visibleNormalizedAction(ownerFrames, specificTexts);
    }
  }
  if (!action && config.nestedExport) {
    const dropdownRoot = trigger.locator.locator(
      'xpath=ancestor::*[contains(@class, "el-dropdown") or contains(@class, "button-group") or contains(@class, "dropdown")][1]',
    ).first();
    if (await dropdownRoot.count()) {
      const caretButtons = dropdownRoot.locator(
        'button:visible, [role="button"]:visible, .el-dropdown__caret-button:visible, [class*="caret"]:visible',
      );
      const caretCount = await caretButtons.count().catch(() => 0);
      if (caretCount > 1) {
        const caret = caretButtons.nth(caretCount - 1);
        await caret.hover().catch(() => {});
        await caret.click({ force: true, noWaitAfter: true }).catch(() => caret.evaluate((node) => node.click()));
        await surface.owner.waitForTimeout(1200);
        action = await visibleNormalizedAction(ownerFrames, specificTexts);
      }
      if (!action) {
        const arrow = dropdownRoot.locator('i:visible, svg:visible, [class*="arrow"]:visible, [class*="caret"]:visible').last();
        if (await arrow.count()) {
          await arrow.click({ force: true, noWaitAfter: true }).catch(() => arrow.evaluate((node) => node.click()));
          await surface.owner.waitForTimeout(1200);
          action = await visibleNormalizedAction(ownerFrames, specificTexts);
        }
      }
    }
  }
  if (!action && config.nestedExport) {
    const box = await trigger.locator.boundingBox().catch(() => null);
    if (box && box.width > 12) {
      await trigger.locator.click({
        force: true,
        noWaitAfter: true,
        position: { x: Math.max(2, box.width - 8), y: Math.max(2, box.height / 2) },
      }).catch(() => {});
      await surface.owner.waitForTimeout(1200);
      action = await visibleNormalizedAction(ownerFrames, specificTexts);
    }
  }
  if (!action && config.nestedExport) {
    await trigger.locator.hover().catch(() => {});
    await trigger.locator.dispatchEvent('mouseenter').catch(() => {});
    await trigger.locator.press('ArrowDown').catch(() => {});
    await surface.owner.waitForTimeout(1200);
    action = await visibleNormalizedAction(ownerFrames, specificTexts);
  }
  if (action) {
    await action.locator.click({ noWaitAfter: true }).catch(() => action.locator.evaluate((node) => node.click()));
    console.log(JSON.stringify({ stage: 'export-option-clicked', kind: config.name, action: action.text }, null, 2));
    return `${trigger.text} -> ${action.text}`;
  }
  if (specificTexts.length) {
    const visibleActions = [];
    for (const frame of ownerFrames) {
      visibleActions.push(...await frame.locator(
        'button:visible, a:visible, [role="menuitem"]:visible, .el-dropdown-menu__item:visible',
      ).allTextContents().catch(() => []));
    }
    console.log(JSON.stringify({
      stage: 'export-menu-diagnostic',
      kind: config.name,
      expected: specificTexts,
      triggerHtml: await trigger.locator.evaluate((node) => node.outerHTML).catch(() => ''),
      triggerParentHtml: await trigger.locator.evaluate((node) => node.parentElement?.outerHTML || '').catch(() => ''),
      visibleActions: visibleActions.map((text) => text.trim()).filter(Boolean).slice(0, 100),
    }, null, 2));
    throw new Error(`${config.name} 点击“导出”后未找到指定的二级导出项。`);
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
    values: ['KM一', 'KM一部'],
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
  await groupSelect.fill('KM一').catch(() => {});
  await ensureComboboxOpen(groupSelect);
  await frame.waitForTimeout(300);
  const requiredGroups = REQUIRED_KM_GROUPS;
  await clearOtherCheckedSubjectOptions(frame, requiredGroups, groupSelect);
  for (const group of requiredGroups) await ensureCheckboxOption(frame, group.aliases, groupSelect);
  await clearOtherCheckedSubjectOptions(frame, requiredGroups, groupSelect);
  await verifyCheckboxOptions(frame, requiredGroups, groupSelect);
  await surface.owner.keyboard.press('Escape').catch(() => {});

  const searchFrames = [frame, ...surface.owner.frames().filter((item) => item !== frame)];
  const search = await visibleNormalizedAction(searchFrames, ['搜索', '查询']);
  if (!search) throw new Error(`${config.name} 筛选完成，但未找到“搜索/查询”按钮。`);
  await search.locator.click({ noWaitAfter: true }).catch(() => search.locator.evaluate((node) => node.click()));
  await frame.waitForTimeout(2500);
  console.log(JSON.stringify({
    stage: 'filters',
    kind: config.name,
    reset: Boolean(reset),
    field: config.filterLabel,
    groups: requiredGroups.map((group) => group.name),
  }, null, 2));
}

async function downloadGenericReport(context, shellPage, outputDir, kind) {
  const config = REPORTS[kind];
  let surface = await openConfiguredReport(shellPage, config);
  await applyGenericGroupFilter(surface, config);
  surface = await activateConfiguredReportTab(shellPage, config);
  const exportedAt = Date.now();
  const downloadOwners = [...new Set([surface.owner, ...context.pages()])];
  const responseMonitor = createExportResponseMonitor(context, downloadOwners, exportedAt);
  if (kind === 'platform') await installClientExportTrace(surface.frame);
  const directDownloadPromise = Promise.race(downloadOwners.map((owner) => (
    owner.waitForEvent('download', { timeout: 0 }).catch(() => new Promise(() => {}))
  )));
  const action = await clickConfiguredExport(surface, config);
  console.log(JSON.stringify({ stage: 'export-action-clicked', kind, action }, null, 2));
  let download = await Promise.race([
    directDownloadPromise,
    surface.owner.waitForTimeout(3000).then(() => null),
  ]);
  if (kind === 'platform' && !download) {
    const confirm = await visibleNormalizedAction([surface.frame], ['确认', '确定']);
    if (confirm) {
      const dialog = confirm.locator.locator(
        'xpath=ancestor::*[@role="dialog" or contains(@class, "el-message-box") or contains(@class, "el-dialog")][1]',
      ).first();
      console.log(JSON.stringify({
        stage: 'export-confirm-diagnostic',
        kind,
        enabled: await confirm.locator.isEnabled().catch(() => null),
        buttonHtml: (await confirm.locator.evaluate((node) => node.outerHTML).catch(() => '')).slice(0, 1000),
        dialogText: (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 1000),
      }, null, 2));
      await confirm.locator.click({ noWaitAfter: true }).catch(() => confirm.locator.evaluate((node) => node.click()));
      await surface.owner.waitForTimeout(750);
      const confirmStillVisible = await confirm.locator.isVisible().catch(() => false);
      if (confirmStillVisible) {
        await confirm.locator.click({ force: true, noWaitAfter: true }).catch(() => {});
        await surface.owner.waitForTimeout(750);
      }
      console.log(JSON.stringify({ stage: 'export-confirm-clicked', kind, action: confirm.text }, null, 2));
      console.log(JSON.stringify({
        stage: 'export-confirm-result',
        kind,
        dismissed: !await confirm.locator.isVisible().catch(() => false),
        feedback: await collectExportFeedback(surface.frame),
      }, null, 2));
      const result = await Promise.race([
        directDownloadPromise,
        responseMonitor.workbookPromise,
        surface.owner.waitForTimeout(600000).then(() => null),
      ]);
      if (result && result.body) {
        responseMonitor.stop();
        console.log(JSON.stringify({ stage: 'export-response-workbook', kind, ...result.diagnostic }, null, 2));
        return saveResponseWorkbook(result.body, outputDir, exportedAt, kind, config.outputName);
      }
      download = result;
      if (!download) {
        const retried = await retryTracedBlobDownload(surface.frame, surface.owner, config.outputName);
        download = retried.download;
        console.log(JSON.stringify({ stage: 'client-export-trace', kind, retried: Boolean(download), ...retried.trace }, null, 2));
      }
    } else {
      console.log(JSON.stringify({ stage: 'export-confirm-not-shown', kind, action }, null, 2));
      const result = await Promise.race([
        directDownloadPromise,
        responseMonitor.workbookPromise,
        surface.owner.waitForTimeout(600000).then(() => null),
      ]);
      if (result && result.body) {
        responseMonitor.stop();
        console.log(JSON.stringify({ stage: 'export-response-workbook', kind, ...result.diagnostic }, null, 2));
        return saveResponseWorkbook(result.body, outputDir, exportedAt, kind, config.outputName);
      }
      download = result;
    }
  }
  if (download) responseMonitor.stop();
  if (!download && kind === 'platform') {
    const feedback = await collectExportFeedback(surface.frame);
    console.log(JSON.stringify({
      stage: 'platform-export-diagnostic',
      feedback,
      clientTrace: await clientExportTrace(surface.frame),
      ...responseMonitor.diagnostics,
    }, null, 2));
    responseMonitor.stop();
    throw new Error('我的平台SKU已确认导出，但未收到下载事件或有效 Excel 响应。请查看 platform-export-diagnostic。');
  }
  if (!download) {
    responseMonitor.stop();
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
  clickConfiguredExport,
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
  trackingRequiresPlatformSales,
  userActionRequiredEvent,
  verifyCheckboxOptions,
};
