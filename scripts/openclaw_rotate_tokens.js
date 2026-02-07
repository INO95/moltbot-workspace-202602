#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseEnv(text) {
  const map = new Map();
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return { map, lines };
}

function upsertEnv(lines, key, value) {
  const idx = lines.findIndex((line) => line.startsWith(`${key}=`));
  const next = `${key}=${value}`;
  if (idx >= 0) lines[idx] = next;
  else lines.push(next);
}

function mask(v) {
  const s = String(v || '');
  if (s.length < 10) return '***';
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function run() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`.env not found: ${ENV_PATH}`);
  }
  const apply = process.argv.includes('--apply');
  const restart = process.argv.includes('--restart');

  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const mainToken = genToken();
  const subToken = genToken();
  let backup = null;

  if (apply) {
    const { lines } = parseEnv(raw);
    upsertEnv(lines, 'OPENCLAW_GATEWAY_TOKEN', mainToken);
    upsertEnv(lines, 'OPENCLAW_GATEWAY_TOKEN_SUB1', subToken);

    backup = `${ENV_PATH}.bak.${Date.now()}`;
    fs.writeFileSync(backup, raw, 'utf8');
    fs.writeFileSync(ENV_PATH, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');

    execSync('node scripts/openclaw_config_secrets.js inject all', { cwd: ROOT, stdio: 'ignore' });
    if (restart) {
      execSync('docker compose --profile sub up -d openclaw-main openclaw-sub1', { cwd: ROOT, stdio: 'ignore' });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    envPath: ENV_PATH,
    backup,
    rotated: {
      OPENCLAW_GATEWAY_TOKEN: mask(mainToken),
      OPENCLAW_GATEWAY_TOKEN_SUB1: mask(subToken),
    },
    mode: apply ? 'apply' : 'dry-run',
    restarted: Boolean(apply && restart),
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
