#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadRuntimeEnv, resolveRuntimeEnvPath, composeEnvArgs } = require('./env_runtime');

const ROOT = path.resolve(__dirname, '..');

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

function run() {
  const envMeta = loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true, required: false });
  const runtimeEnvPath = resolveRuntimeEnvPath();
  const sourceEnvPath = envMeta.source || runtimeEnvPath;
  if (!fs.existsSync(sourceEnvPath)) {
    throw new Error(
      `runtime env not found. set MOLTBOT_ENV_FILE or create ${runtimeEnvPath}`,
    );
  }

  const apply = process.argv.includes('--apply');
  const restart = process.argv.includes('--restart');

  const raw = fs.readFileSync(sourceEnvPath, 'utf8');
  const mainToken = genToken();
  const subToken = genToken();
  let backup = null;
  let wroteEnvPath = null;

  if (apply) {
    const { lines } = parseEnv(raw);
    upsertEnv(lines, 'OPENCLAW_GATEWAY_TOKEN', mainToken);
    upsertEnv(lines, 'OPENCLAW_GATEWAY_TOKEN_SUB1', subToken);

    ensureFileDir(runtimeEnvPath);
    // Backup with redacted secrets to prevent credential exposure.
    backup = `${runtimeEnvPath}.bak.${Date.now()}`;
    const redactedRaw = raw
      .replace(/^OPENCLAW_GATEWAY_TOKEN=.*/gm, 'OPENCLAW_GATEWAY_TOKEN=[REDACTED]')
      .replace(/^OPENCLAW_GATEWAY_TOKEN_SUB1=.*/gm, 'OPENCLAW_GATEWAY_TOKEN_SUB1=[REDACTED]');
    fs.writeFileSync(backup, redactedRaw, 'utf8');
    fs.writeFileSync(runtimeEnvPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
    wroteEnvPath = runtimeEnvPath;

    runCommand('node', ['scripts/openclaw_config_secrets.js', 'inject', 'all'], { cwd: ROOT });
    if (restart) {
      const args = [
        'compose',
        ...composeEnvArgs({ allowLegacyFallback: true, required: false }),
        '--profile',
        'sub',
        'up',
        '-d',
        'openclaw-main',
        'openclaw-sub1',
      ];
      runCommand('docker', args, { cwd: ROOT });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    envPath: runtimeEnvPath,
    sourceEnvPath,
    wroteEnvPath,
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
