const fs = require('fs');
const os = require('os');
const path = require('path');

function candidateModuleFiles() {
  const candidates = [];
  for (const value of [process.env.PLAYWRIGHT_NODE_MODULES, process.env.CODEX_NODE_MODULES]) {
    if (value) candidates.push(path.join(value, 'playwright', 'index.js'));
  }

  const cacheRoot = path.join(os.homedir(), '.cache', 'codex-runtimes');
  if (fs.existsSync(cacheRoot)) {
    for (const runtime of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!runtime.isDirectory()) continue;
      candidates.push(path.join(
        cacheRoot,
        runtime.name,
        'dependencies',
        'node',
        'node_modules',
        'playwright',
        'index.js',
      ));
    }
  }
  return candidates;
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (firstError) {
    for (const moduleFile of candidateModuleFiles()) {
      if (!fs.existsSync(moduleFile)) continue;
      try {
        return require(moduleFile);
      } catch (error) {
        firstError.message += `; fallback ${moduleFile}: ${error.message}`;
      }
    }
    throw new Error(
      `无法加载 Playwright。请设置 PLAYWRIGHT_NODE_MODULES，或在当前 Codex 本地运行时执行。原始错误：${firstError.message}`,
    );
  }
}

module.exports = { candidateModuleFiles, loadPlaywright };
