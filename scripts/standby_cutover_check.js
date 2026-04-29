#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTAINERS = Object.freeze([
  'moltbot-dev-bak',
  'moltbot-anki-bak',
  'moltbot-research-bak',
  'moltbot-daily-bak',
]);

function parseJsonLine(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function inspectContainer(container) {
  const res = spawnSync('docker', [
    'ps',
    '-a',
    '--filter',
    `name=^/${container}$`,
    '--format',
    '{{json .}}',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return {
      container,
      status: 'unknown',
      dockerOk: false,
    };
  }
  const line = String(res.stdout || '').split(/\r?\n/).map((v) => v.trim()).find(Boolean);
  if (!line) {
    return {
      container,
      status: 'missing',
      dockerOk: true,
    };
  }
  const parsed = parseJsonLine(line);
  return {
    container,
    status: String((parsed && parsed.Status) || 'unknown'),
    dockerOk: true,
    raw: parsed || line,
  };
}

const containers = CONTAINERS.map(inspectContainer);
const dockerOk = containers.some((row) => row.dockerOk);

console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  dockerOk,
  containers,
}, null, 2));
