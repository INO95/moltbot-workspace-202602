#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const FORBIDDEN = [
  'configs/main/openclaw.json',
  'configs/sub1/openclaw.json',
];

const ALLOWLIST = new Set([
  'scripts/check_container_isolation_refs.js',
  'scripts/openclaw_backup_sync.sh',
  'scripts/openclaw_backup_verify.sh',
]);

function walk(dirPath, out = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(fullPath);
  }
  return out;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function isTextCandidate(filePath) {
  return /\.(?:js|cjs|mjs|ts|sh|md|json|ya?ml|txt)$/i.test(filePath);
}

function run() {
  if (!fs.existsSync(SCRIPTS_DIR)) {
    throw new Error(`scripts directory not found: ${SCRIPTS_DIR}`);
  }
  const files = walk(SCRIPTS_DIR).filter(isTextCandidate);
  const violations = [];

  for (const file of files) {
    const rel = relative(file);
    if (ALLOWLIST.has(rel)) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) {
        violations.push({ file: rel, needle });
      }
    }
  }

  if (violations.length > 0) {
    console.error('container isolation guard failed: forbidden host config references found');
    for (const row of violations) {
      console.error(`- ${row.file}: ${row.needle}`);
    }
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, checkedFiles: files.length }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
