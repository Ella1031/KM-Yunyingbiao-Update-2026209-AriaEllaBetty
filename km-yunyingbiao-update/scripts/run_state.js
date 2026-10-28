'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;

function now() {
  return new Date().toISOString();
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fingerprint(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  const bigintStat = fs.statSync(resolved, { bigint: true });
  return {
    path: resolved,
    size: stat.size,
    mtime: stat.mtimeMs / 1000,
    mtimeNs: bigintStat.mtimeNs.toString(),
    sha256: sha256(resolved),
    integrity: 'pending-validator',
  };
}

function newState(stateFile) {
  const createdAt = now();
  return {
    version: STATE_VERSION,
    runId: path.basename(path.dirname(path.resolve(stateFile))),
    runDirectory: path.dirname(path.resolve(stateFile)),
    createdAt,
    updatedAt: createdAt,
    status: 'in_progress',
    freshness: {},
    inputs: {},
    sources: {},
    stages: {},
    delivery: {},
  };
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return newState(stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.version !== STATE_VERSION) throw new Error(`不支持的运行状态版本：${state.version}`);
  return state;
}

function saveState(stateFile, state) {
  const resolved = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  state.updatedAt = now();
  const temp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, resolved);
}

function sourceReusable(state, name) {
  const saved = state.sources && state.sources[name];
  if (!saved || saved.status !== 'validated' || !saved.path || !fs.existsSync(saved.path)) return false;
  const current = fingerprint(saved.path);
  return current.size === saved.size
    && String(current.mtimeNs) === String(saved.mtimeNs)
    && current.sha256 === saved.sha256;
}

function beginDomain(stateFile, domain, runStartSeconds) {
  const state = loadState(stateFile);
  if (!state.freshness[domain]) state.freshness[domain] = runStartSeconds;
  saveState(stateFile, state);
  return state.freshness[domain];
}

function recordSource(stateFile, domain, name, filePath, runStartSeconds, metadata = {}) {
  const state = loadState(stateFile);
  if (!state.freshness[domain]) state.freshness[domain] = runStartSeconds;
  state.sources[name] = {
    ...fingerprint(filePath),
    domain,
    status: 'downloaded',
    validatedAt: null,
    validation: null,
    metadata,
  };
  state.stages[`${domain}_download`] = {
    status: 'in_progress',
    updatedAt: now(),
    outputs: [],
    result: null,
    error: null,
  };
  saveState(stateFile, state);
}

function completeDownloadStage(stateFile, domain, names, metadata = {}) {
  const state = loadState(stateFile);
  const outputs = names.filter((name) => state.sources[name]).map((name) => state.sources[name]);
  state.stages[`${domain}_download`] = {
    status: 'complete',
    updatedAt: now(),
    outputs,
    result: metadata,
    error: null,
  };
  saveState(stateFile, state);
}

module.exports = {
  beginDomain,
  completeDownloadStage,
  loadState,
  recordSource,
  saveState,
  sourceReusable,
};
