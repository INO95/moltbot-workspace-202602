#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadRuntimeEnv, resolveRuntimeEnvPath, composeEnvArgs } = require('./env_runtime');

const ROOT = path.resolve(__dirname, '..');
const TOKEN_GROUPS = [
  {
    primary: 'OPENCLAW_GATEWAY_TOKEN_DEV',
    legacy: ['OPENCLAW_GATEWAY_TOKEN'],
  },
  {
    primary: 'OPENCLAW_GATEWAY_TOKEN_ANKI',
    legacy: ['OPENCLAW_GATEWAY_TOKEN_SUB1'],
  },
  {
    primary: 'OPENCLAW_GATEWAY_TOKEN_RESEARCH',
    legacy: [],
  },
  {
    primary: 'OPENCLAW_GATEWAY_TOKEN_DAILY',
    legacy: [],
  },
  {
    primary: 'OPENCLAW_GATEWAY_TOKEN_DEV_BAK',
    legacy: ['OPENCLAW_GATEWAY_TOKEN_MAIN_BAK'],
  },
  {
    primary: 'OPENCLAW_GATEWAY_TOKEN_ANKI_BAK',
    legacy: ['OPENCLAW_GATEWAY_TOKEN_SUB1_BAK'],
  },
  {
    primary: 'OPENCLAW_GATEWAY_TOKEN_RESEARCH_BAK',
    legacy: [],
  },
  {
    primary: 'OPENCLAW_GATEWAY_TOKEN_DAILY_BAK',
    legacy: [],
  },
];
const ALL_GATEWAY_KEYS = [...new Set(TOKEN_GROUPS.flatMap((group) => [group.primary, ...group.legacy]))];

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseEnv(text) {
  const lines = text.split('\n');
  return { lines };
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

function runCommand(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  const ok = !res.error && res.status === 0;
  if (ok) return { ok: true, stdout: String(res.stdout || '').trim(), stderr: '' };
  const errText = String(res.stderr || res.stdout || (res.error ? res.error.message : 'unknown error')).trim();
  throw new Error(`${cmd} ${args.join(' ')} failed: ${errText}`);
}

function ensureFileDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function redactRaw(raw) {
  let out = String(raw || '');
  for (const key of ALL_GATEWAY_KEYS) {
    const re = new RegExp(`^${key}=.*$`, 'gm');
    out = out.replace(re, `${key}=[REDACTED]`);
  }
  return out;
}

function run() {
  const envMeta = loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true, required: false });
  const runtimeEnvPath = resolveRuntimeEnvPath();
  const sourceEnvPath = envMeta.source || runtimeEnvPath;
  if (!fs.existsSync(sourceEnvPath)) {
    throw new Error(`runtime env not found. set MOLTBOT_ENV_FILE or create ${runtimeEnvPath}`);
  }

  const apply = process.argv.includes('--apply');
  const restart = process.argv.includes('--restart');

  const raw = fs.readFileSync(sourceEnvPath, 'utf8');
  const rotatedByPrimary = Object.fromEntries(TOKEN_GROUPS.map((group) => [group.primary, genToken()]));

  let backup = null;
  let wroteEnvPath = null;

  if (apply) {
    const { lines } = parseEnv(raw);
    for (const group of TOKEN_GROUPS) {
      const token = rotatedByPrimary[group.primary];
      upsertEnv(lines, group.primary, token);
      for (const legacyKey of group.legacy) {
        upsertEnv(lines, legacyKey, token);
      }
    }

    ensureFileDir(runtimeEnvPath);
    backup = `${runtimeEnvPath}.bak.${Date.now()}`;
    fs.writeFileSync(backup, redactRaw(raw), 'utf8');
    fs.writeFileSync(runtimeEnvPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
    wroteEnvPath = runtimeEnvPath;

    runCommand('node', ['scripts/openclaw_config_secrets.js', 'inject', 'all_live'], { cwd: ROOT });

    if (restart) {
      const args = [
        'compose',
        ...composeEnvArgs({ allowLegacyFallback: true, required: false }),
        '--profile',
        'live',
        'up',
        '-d',
        'openclaw-dev',
        'openclaw-anki',
        'openclaw-research',
        'openclaw-daily',
      ];
      runCommand('docker', args, { cwd: ROOT });
    }
  }

  const masked = Object.fromEntries(Object.entries(rotatedByPrimary).map(([key, value]) => [key, mask(value)]));

  console.log(JSON.stringify({
    ok: true,
    envPath: runtimeEnvPath,
    sourceEnvPath,
    wroteEnvPath,
    backup,
    rotated: masked,
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
