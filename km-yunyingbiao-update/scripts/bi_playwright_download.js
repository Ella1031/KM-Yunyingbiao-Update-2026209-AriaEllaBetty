#!/usr/bin/env node

// Browser-assisted BI export. Credentials and login state stay in the user's
// headed browser session; this script never accepts or stores credentials.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadPlaywright } = require('./playwright_runtime');
const { chromium } = loadPlaywright();

const BI_URL = 'https://dms.issyzone.net:38999/webroot/decision#/';
const REPORT_NAME = '海外在途预计上架取数';
const REQUIRED_SUBJECTS = ['KM一部一组', 'KM一部二组', 'KM一部三组'];
let activeBrowser = null;

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function chromePath() {
  return [
    process.env.PLAYWRIGHT_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
}

function userActionRequiredEvent() {
  return {
    stage: 'user_action_required',
    action: 'bi_credentials_login',
    message: 'BI 登录页面已打开，请在可见浏览器中亲自输入账号、密码并完成登录。',
  };
}

function ask(question) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => input.question(`${question}\n> `, (answer) => {
    input.close();
    resolve(answer.trim());
  }));
}

function allFrames(context) {
  return context.pages().flatMap((page) => page.frames());
}

async function firstVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function waitForAuthenticated(context) {
  const deadline = Date.now() + 300000;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    let passwordVisible = false;
    let portalVisible = false;
    for (const frame of allFrames(context)) {
      if (await firstVisible(frame.locator('input[type="password"]'))) passwordVisible = true;
      const body = await frame.locator('body').innerText().catch(() => '');
      if (body.includes(REPORT_NAME) || /目录|报表|搜索|决策平台/.test(body)) portalVisible = true;
    }
    stableChecks = !passwordVisible && portalVisible ? stableChecks + 1 : 0;
    if (stableChecks >= 2) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function clickExactText(context, text) {
  for (const frame of allFrames(context)) {
    const item = await firstVisible(frame.getByText(text, { exact: true }));
    if (!item) continue;
    await item.click().catch(() => item.evaluate((node) => node.click()));
    return true;
  }
  return false;
}

async function openReport(context) {
  if (await clickExactText(context, REPORT_NAME)) return;
  for (const frame of allFrames(context)) {
    let input = await firstVisible(frame.locator(
      'input[placeholder*="搜索"], input[placeholder*="查找"], input[type="search"], input.bi-input',
    ));
    if (!input) {
      const label = await firstVisible(frame.getByText('搜索', { exact: true }));
      if (label) input = await firstVisible(label.locator('xpath=following-sibling::input[1]'));
    }
    if (!input) continue;
    await input.fill(REPORT_NAME);
    await frame.waitForTimeout(1000);
    if (await clickExactText(context, REPORT_NAME)) return;
  }
  throw new Error(`未自动找到报表“${REPORT_NAME}”。`);
}

async function reportFrame(context) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const frame of allFrames(context)) {
      const body = await frame.locator('body').innerText().catch(() => '');
      if (body.includes('主体') && (/导出|查询|搜索/.test(body) || body.includes(REPORT_NAME))) return frame;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('报表已打开，但未找到包含“主体”的报表页面。');
}

async function subjectTrigger(frame) {
  const direct = await firstVisible(frame.locator(
    'input[placeholder*="主体"], input[title*="主体"], [aria-label*="主体"] input',
  ));
  if (direct) return direct;
  const label = await firstVisible(frame.getByText(/^主体\s*[:：]?$/, { exact: true }));
  if (!label) return null;
  const labelBox = await label.boundingBox();
  if (labelBox) {
    const editors = frame.locator('.bi-multi-select-editor:visible');
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < await editors.count(); index += 1) {
      const editor = editors.nth(index);
      const box = await editor.boundingBox();
      if (!box || box.x <= labelBox.x || Math.abs(box.y - labelBox.y) > 12) continue;
      const distance = box.x - labelBox.x;
      if (distance < nearestDistance) {
        nearest = editor;
        nearestDistance = distance;
      }
    }
    if (nearest) return nearest;
  }
  return await firstVisible(label.locator(
    'xpath=(following::input[not(@type="hidden")][1] | ancestor::*[self::div or self::td][1]//input[not(@type="hidden")])[1]',
  ));
}

async function visibleOption(context, text) {
  const overlaySelectors = [
    '[role="listbox"]:visible', '.el-select-dropdown:visible',
    '.ant-select-dropdown:visible', '.x-boundlist:visible',
    '.fr-dropdown:visible', '.bi-list-view:visible',
  ];
  for (const frame of allFrames(context)) {
    for (const selector of overlaySelectors) {
      const overlay = await firstVisible(frame.locator(selector));
      if (!overlay) continue;
      const option = await firstVisible(overlay.getByText(text, { exact: true }));
      if (option) return option;
    }
  }
  for (const frame of allFrames(context)) {
    const option = await firstVisible(frame.getByText(text, { exact: true }));
    if (option) return option;
  }
  return null;
}

async function waitForSubjectTree(frame, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const trees = frame.locator('ul.ztree:visible');
    const count = await trees.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const tree = trees.nth(index);
      if (await firstVisible(tree.getByText('KM', { exact: true }))) return tree;
    }
    await frame.waitForTimeout(250);
  }
  return null;
}

async function waitForTreeText(tree, text, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const item = await firstVisible(tree.getByText(text, { exact: true }));
    if (item) return item;
    await tree.page().waitForTimeout(250);
  }
  return null;
}

async function selectSubjects(context, frame) {
  const native = frame.locator('select');
  for (let index = 0; index < await native.count(); index += 1) {
    const select = native.nth(index);
    if (!await select.isVisible().catch(() => false)) continue;
    const labels = (await select.locator('option').allTextContents()).map((item) => item.trim());
    if (REQUIRED_SUBJECTS.every((subject) => labels.includes(subject))) {
      await select.selectOption(REQUIRED_SUBJECTS.map((label) => ({ label })));
      return { method: 'native-select', selected: REQUIRED_SUBJECTS };
    }
  }

  const trigger = await subjectTrigger(frame);
  if (!trigger) throw new Error('未找到“主体”筛选控件。');
  await trigger.click().catch(() => trigger.evaluate((node) => node.click()));

  let tree = await waitForSubjectTree(frame);
  if (tree) {
    const clear = await firstVisible(frame.getByText('清空', { exact: true }));
    if (clear) {
      await clear.click({ force: true });
      tree = await waitForSubjectTree(frame, 1200);
      if (!tree) {
        await trigger.click({ force: true }).catch(() => trigger.evaluate((node) => node.click()));
        tree = await waitForSubjectTree(frame);
      }
      if (!tree) throw new Error('清空后主体树未重新加载。');
    }
    const kmText = await firstVisible(tree.getByText('KM', { exact: true }));
    if (!kmText) throw new Error('主体树中未找到“KM”。');
    const km = kmText.locator('xpath=ancestor::li[1]');
    const switchControl = km.locator(':scope > [treenode_switch]').first();
    if ((await switchControl.getAttribute('class') || '').includes('_close')) {
      await switchControl.click({ force: true });
    }
    for (const subject of REQUIRED_SUBJECTS) {
      const subjectText = await waitForTreeText(tree, subject);
      if (!subjectText) throw new Error(`主体树中未找到“${subject}”。`);
      const item = subjectText.locator('xpath=ancestor::li[1]');
      const checkbox = item.locator(':scope > [treenode_check]').first();
      if (!(await checkbox.getAttribute('class') || '').includes('checkbox_true')) {
        await checkbox.click({ force: true });
      }
    }
    const confirm = await firstVisible(frame.getByText('确定', { exact: true }));
    if (!confirm) throw new Error('主体树未找到“确定”按钮。');
    await confirm.click({ force: true });
    await frame.waitForTimeout(3000);
  } else {
    for (const subject of REQUIRED_SUBJECTS) {
      const option = await visibleOption(context, subject);
      if (!option) throw new Error(`主体下拉框中未找到“${subject}”。`);
      await option.click().catch(() => option.evaluate((node) => node.click()));
    }
    await frame.page().keyboard.press('Escape').catch(() => {});
  }

  const selectedText = [
    await trigger.inputValue().catch(() => ''),
    await trigger.innerText().catch(() => ''),
    await trigger.locator('xpath=ancestor::*[self::div or self::td][1]').innerText().catch(() => ''),
  ].join(' ');
  const missing = REQUIRED_SUBJECTS.filter((subject) => !selectedText.includes(subject));
  if (missing.length) throw new Error(`无法确认主体筛选已选中：${missing.join('、')}`);
  const selectedSubjects = selectedText
    .replace(/^.*?KM:/, '')
    .split(/[,，;]/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('KM一部'));
  const unexpected = selectedSubjects.filter((subject) => !REQUIRED_SUBJECTS.includes(subject));
  if (unexpected.length) throw new Error(`主体筛选包含额外值：${unexpected.join('、')}`);
  return { method: 'dropdown', selected: REQUIRED_SUBJECTS };
}

async function applySearch(frame) {
  for (const text of ['查询', '搜索']) {
    const button = await firstVisible(frame.getByText(text, { exact: true }));
    if (!button) continue;
    await button.click().catch(() => button.evaluate((node) => node.click()));
    await frame.waitForTimeout(1500);
    return text;
  }
  return null;
}

async function loginConflictMessage(context) {
  for (const frame of allFrames(context)) {
    const notice = await firstVisible(frame.locator('.bi-message-depend:visible'));
    if (!notice) continue;
    const text = (await notice.innerText().catch(() => '')).trim();
    if (text.includes('您的账号已在其他平台登录')) return text;
  }
  return '';
}

async function exportOption(context) {
  const label = /^(导出\s*)?Excel(\s*文件)?$/i;
  for (const frame of allFrames(context)) {
    const option = await firstVisible(frame.getByText(label));
    if (option) return option;
  }
  return null;
}

async function exportWorkbook(context, frame) {
  const conflict = await loginConflictMessage(context);
  if (conflict) throw new Error('当前 BI 会话已被其他登录挤下线，请在本次自动化浏览器中重新登录。');

  const owner = frame.page();
  let control = await firstVisible(frame.locator('.bi-design-global-export:visible'));
  if (!control) control = await firstVisible(frame.getByText('导出', { exact: true }));
  if (!control) throw new Error('未找到页面左上角的全量“导出”控件。');
  await control.click({ force: true }).catch(() => control.evaluate((node) => node.click()));
  await frame.waitForTimeout(500);
  const option = await exportOption(context);
  if (!option) throw new Error('点击全量“导出”后未找到“导出Excel”选项。');
  const downloadPromise = owner.waitForEvent('download', { timeout: 120000 });
  await option.click({ force: true }).catch(() => option.evaluate((node) => node.click()));
  return await downloadPromise;
}

async function diagnostics(context) {
  const details = [];
  for (const frame of allFrames(context)) {
    details.push({
      url: frame.url(),
      inputs: await frame.locator('input').evaluateAll((items) => items.slice(0, 30).map((item) => ({
        placeholder: item.getAttribute('placeholder'), title: item.getAttribute('title'),
        type: item.getAttribute('type'), value: item.value,
      }))).catch(() => []),
      buttons: await frame.locator('button, [role="button"], a').allTextContents().then((items) => items.slice(0, 80)).catch(() => []),
      bodyPreview: (await frame.locator('body').innerText().catch(() => '')).slice(0, 1800),
    });
  }
  console.log(JSON.stringify({ stage: 'diagnostic', details }, null, 2));
}

async function runAuthenticatedContext(context, outputDir, runStartedAt) {
  await openReport(context);
  const frame = await reportFrame(context);
  const subjectResult = await selectSubjects(context, frame);
  const searchAction = await applySearch(frame);
  console.log(JSON.stringify({
    stage: 'filters', report: REPORT_NAME, subjects: subjectResult,
    searchAction, frameUrl: frame.url(),
  }, null, 2));

  const download = await exportWorkbook(context, frame);
  const suggested = download.suggestedFilename();
  const extension = path.extname(suggested) || '.xlsx';
  let target = path.join(outputDir, suggested);
  if (fs.existsSync(target)) target = path.join(outputDir, `${path.basename(suggested, extension)}-${Date.now()}${extension}`);
  await download.saveAs(target);
  if (fs.statSync(target).mtimeMs < runStartedAt - 2000) throw new Error(`BI 下载文件时间早于本次运行：${target}`);
  console.log(JSON.stringify({ stage: 'downloaded', path: target, suggestedFilename: suggested, runStartedAt }, null, 2));
  return target;
}

async function main() {
  const outputDir = path.resolve(arg('download-dir', path.join(process.cwd(), 'downloads')));
  fs.mkdirSync(outputDir, { recursive: true });
  const executablePath = chromePath();
  if (!executablePath) throw new Error('未找到 Chrome/Edge。请设置 PLAYWRIGHT_CHROME_PATH。');

  activeBrowser = await chromium.launch({
    headless: false,
    executablePath,
  });
  const context = await activeBrowser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const runStartedAt = Date.now();
  await page.goto(arg('url', BI_URL), { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(JSON.stringify({ stage: 'opened', url: page.url(), title: await page.title(), runStartedAt }, null, 2));
  console.log(JSON.stringify(userActionRequiredEvent(), null, 2));
  console.log('请在浏览器中亲自输入 BI 账号、密码并完成登录，脚本会自动识别登录成功。');
  if (!await waitForAuthenticated(context)) throw new Error('等待 BI 登录超过 5 分钟。');
  console.log(JSON.stringify({ stage: 'authenticated', url: page.url() }, null, 2));

  await runAuthenticatedContext(context, outputDir, runStartedAt);
  await activeBrowser.close();
  activeBrowser = null;
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`BI 自动化失败: ${error.message}`);
    if (activeBrowser) {
      const contexts = activeBrowser.contexts();
      if (contexts.length) await diagnostics(contexts[0]).catch(() => {});
      if (hasFlag('hold-on-error')) await ask('浏览器将保持打开以便检查；确认结束后按 Enter 关闭');
      await activeBrowser.close().catch(() => {});
    }
    process.exitCode = 1;
  });
}

module.exports = {
  BI_URL,
  REQUIRED_SUBJECTS,
  chromePath,
  openReport,
  reportFrame,
  runAuthenticatedContext,
  selectSubjects,
  subjectTrigger,
  exportWorkbook,
  loginConflictMessage,
  waitForSubjectTree,
  waitForTreeText,
  waitForAuthenticated,
  userActionRequiredEvent,
};
