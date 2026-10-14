#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const { loadPlaywright } = require('./playwright_runtime');
const { chromium } = loadPlaywright();
const {
  REQUIRED_SUBJECTS,
  selectSubjects,
  waitForSubjectTree,
  waitForAuthenticated,
  userActionRequiredEvent,
} = require('./bi_playwright_download');

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
    action: 'bi_credentials_login',
    message: 'BI 登录页面已打开，请在可见浏览器中亲自输入账号、密码并完成登录。',
  });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<input type="password"><div>登录</div>');
  setTimeout(() => page.setContent('<div>决策平台</div><div>报表</div>'), 200);
  assert.strictEqual(await waitForAuthenticated(context), true);

  await page.setContent(`
    <select id="subjects" multiple>
      <option>其他主体</option>
      ${REQUIRED_SUBJECTS.map((subject) => `<option>${subject}</option>`).join('')}
    </select>
  `);
  const result = await selectSubjects(context, page.mainFrame());
  assert.strictEqual(result.method, 'native-select');
  assert.deepStrictEqual(
    await page.locator('#subjects option:checked').allTextContents(),
    REQUIRED_SUBJECTS,
  );

  await page.setContent('<ul class="ztree"><li>BV</li></ul><div id="host"></div>');
  setTimeout(() => page.locator('#host').evaluate((host, subjects) => {
    host.innerHTML = `<ul class="ztree"><li><span>KM</span><ul>${subjects
      .map((subject) => `<li><span>${subject}</span></li>`).join('')}</ul></li></ul>`;
  }, REQUIRED_SUBJECTS), 200);
  const tree = await waitForSubjectTree(page.mainFrame(), 2000);
  assert.ok(tree);
  assert.strictEqual(await tree.getByText('KM', { exact: true }).count(), 1);
  assert.deepStrictEqual(
    await tree.locator('li li span').allTextContents(),
    REQUIRED_SUBJECTS,
  );

  await browser.close();
  console.log('BI selector self-test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
