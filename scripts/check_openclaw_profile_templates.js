#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'contracts', 'openclaw', 'profiles');

const PROFILE_EXEC_CONTRACTS = {
  dev: [{ host: 'gateway', security: 'full', ask: 'off' }],
  anki: [{ host: 'gateway', security: 'full', ask: 'off' }],
  research: [{ host: 'gateway', security: 'full', ask: 'off' }],
  daily: [
    { host: 'node', security: 'allowlist', ask: 'on-miss' },
    { host: 'gateway', security: 'allowlist', ask: 'always' },
  ],
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function validateTemplate(filePath) {
  const raw = readJson(filePath);
  const profile = String(raw.profile || '').trim().toLowerCase();
  if (!profile || !PROFILE_EXEC_CONTRACTS[profile]) {
    throw new Error(`${filePath}: invalid or missing profile`);
  }

  const requiredTopLevel = ['update', 'agents', 'commands', 'tools', 'gateway'];
  for (const key of requiredTopLevel) {
    if (!has(raw, key)) {
      throw new Error(`${filePath}: missing top-level key '${key}'`);
    }
  }

  const execCfg = raw.tools && raw.tools.exec && typeof raw.tools.exec === 'object'
    ? raw.tools.exec
    : null;
  if (!execCfg) {
    throw new Error(`${filePath}: tools.exec must be an object`);
  }

  const host = String(execCfg.host || '').trim().toLowerCase();
  const security = String(execCfg.security || '').trim().toLowerCase();
  const ask = String(execCfg.ask || '').trim().toLowerCase();

  const allowed = PROFILE_EXEC_CONTRACTS[profile];
  const ok = allowed.some((row) => row.host === host && row.security === security && row.ask === ask);
  if (!ok) {
    const expected = allowed.map((row) => `${row.host}/${row.security}/${row.ask}`).join(' or ');
    throw new Error(`${filePath}: exec contract mismatch (${host}/${security}/${ask}), expected ${expected}`);
  }

  if (!raw.gateway || String(raw.gateway.mode || '').trim().toLowerCase() !== 'local') {
    throw new Error(`${filePath}: gateway.mode must be 'local'`);
  }

  return { filePath, profile, exec: `${host}/${security}/${ask}` };
}

function main() {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    throw new Error(`templates dir not found: ${TEMPLATES_DIR}`);
  }
  const files = fs.readdirSync(TEMPLATES_DIR)
    .filter((name) => name.endsWith('.template.json'))
    .sort()
    .map((name) => path.join(TEMPLATES_DIR, name));

  if (files.length === 0) {
    throw new Error(`no template files found under ${TEMPLATES_DIR}`);
  }

  const rows = files.map(validateTemplate);
  console.log(JSON.stringify({ ok: true, checked: rows.length, profiles: rows }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}
