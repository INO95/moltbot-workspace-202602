#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, composeEnvArgs, loadRuntimeEnv } = require('./env_runtime');

const PROFILE_TO_CONTAINER = {
  main: 'moltbot-main',
  sub1: 'moltbot-sub1',
};

const PROFILE_TO_SERVICE = {
  main: 'openclaw-main',
  sub1: 'openclaw-sub1',
};

const CONTAINER_CONFIG_PATH = '/home/node/.openclaw/openclaw.json';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: !res.error && res.status === 0,
    code: res.status == null ? 1 : res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function mustRun(cmd, args, opts = {}) {
  const out = run(cmd, args, opts);
  if (out.ok) return out;
  const details = out.stderr || out.stdout || out.error || 'unknown error';
  throw new Error(`${cmd} ${args.join(' ')} failed: ${details}`);
}

function ensureStringArray(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ensureContainerRunning(profile) {
  const container = PROFILE_TO_CONTAINER[profile];
  const service = PROFILE_TO_SERVICE[profile];
  const isRunning = run('docker', ['inspect', '-f', '{{.State.Running}}', container]);
  if (isRunning.ok && isRunning.stdout === 'true') return { container, service, started: false };

  const args = [
    'compose',
    ...composeEnvArgs({ allowLegacyFallback: true, required: false }),
    '--profile',
    'sub',
    'up',
    '-d',
    service,
  ];
  mustRun('docker', args, { cwd: ROOT });
  return { container, service, started: true };
}

function templatePath(profile) {
  return path.join(ROOT, 'configs', profile, 'openclaw.json');
}

function seedConfigIfMissing(profile, container) {
  const exists = run('docker', ['exec', container, 'test', '-f', CONTAINER_CONFIG_PATH]);
  if (exists.ok) return { seeded: false, reason: 'already_present' };

  const template = templatePath(profile);
  if (!fs.existsSync(template)) {
    return { seeded: false, reason: `missing_template:${template}` };
  }
  mustRun('docker', ['cp', template, `${container}:${CONTAINER_CONFIG_PATH}`]);
  return { seeded: true, reason: 'copied_from_host_template', template };
}

function parseJsonFromStdout(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch (_) {
      // continue
    }
  }
  return null;
}

function patchConfigInContainer(container, payload) {
  const script = `
const fs = require('fs');
const cfgPath = ${JSON.stringify(CONTAINER_CONFIG_PATH)};
const payload = JSON.parse(process.argv[1] || '{}');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (_) {
  cfg = {};
}

cfg.gateway = cfg.gateway || {};
cfg.gateway.mode = 'local';
cfg.gateway.bind = 'loopback';
cfg.gateway.auth = cfg.gateway.auth || {};
if (payload.action === 'inject') {
  if (payload.gatewayToken) cfg.gateway.auth.token = payload.gatewayToken;
} else if (cfg.gateway && cfg.gateway.auth) {
  delete cfg.gateway.auth.token;
}

cfg.channels = cfg.channels || {};
cfg.channels.telegram = cfg.channels.telegram || {};
cfg.channels.telegram.groupPolicy = 'allowlist';

if (payload.action === 'inject') {
  if (payload.profile === 'main') {
    const enabled = Boolean(payload.botToken);
    cfg.channels.telegram.enabled = enabled;
    if (enabled) cfg.channels.telegram.botToken = payload.botToken;
    else delete cfg.channels.telegram.botToken;

    if (Array.isArray(payload.allowFrom) && payload.allowFrom.length) {
      cfg.channels.telegram.allowFrom = payload.allowFrom;
    } else {
      delete cfg.channels.telegram.allowFrom;
    }
  } else {
    const enabled = Boolean(payload.subEnabled);
    cfg.channels.telegram.enabled = enabled;
    if (enabled) {
      if (payload.botToken) cfg.channels.telegram.botToken = payload.botToken;
      else delete cfg.channels.telegram.botToken;
      if (Array.isArray(payload.allowFrom) && payload.allowFrom.length) cfg.channels.telegram.allowFrom = payload.allowFrom;
      else delete cfg.channels.telegram.allowFrom;
    } else {
      delete cfg.channels.telegram.botToken;
      delete cfg.channels.telegram.allowFrom;
      cfg.channels.telegram.name = 'MoltbotBackup';
    }
  }
} else {
  delete cfg.channels.telegram.botToken;
  delete cfg.channels.telegram.allowFrom;
}

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({
  ok: true,
  profile: payload.profile,
  action: payload.action,
  cfgPath,
  gatewayTokenSet: Boolean(cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token),
  telegramEnabled: cfg && cfg.channels && cfg.channels.telegram ? cfg.channels.telegram.enabled === true : false
}));
`;

  const out = mustRun(
    'docker',
    ['exec', '-i', container, 'node', '-e', script, JSON.stringify(payload)],
  );
  const parsed = parseJsonFromStdout(out.stdout);
  return parsed || { ok: true, raw: out.stdout };
}

function payloadFor(profile, action) {
  const gatewayEnvKey = profile === 'main' ? 'OPENCLAW_GATEWAY_TOKEN' : 'OPENCLAW_GATEWAY_TOKEN_SUB1';
  const gatewayToken = String(process.env[gatewayEnvKey] || '').trim();
  if (action === 'redact') {
    return { profile, action, gatewayToken: '' };
  }

  if (profile === 'main') {
    return {
      profile,
      action,
      gatewayToken,
      botToken: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
      allowFrom: ensureStringArray(process.env.TELEGRAM_USER_ID),
    };
  }

  const subEnabled = String(process.env.OPENCLAW_SUB1_TELEGRAM_ENABLED || 'false').toLowerCase() === 'true';
  return {
    profile,
    action,
    gatewayToken,
    subEnabled,
    botToken: String(process.env.TELEGRAM_BOT_TOKEN_SUB1 || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    allowFrom: ensureStringArray(process.env.TELEGRAM_USER_ID_SUB1 || process.env.TELEGRAM_USER_ID),
  };
}

function usage() {
  console.error('Usage: node scripts/openclaw_config_secrets.js <inject|redact> <main|sub1|all>');
}

function runMain() {
  loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true, required: false });
  const action = String(process.argv[2] || '').trim();
  const profileArg = String(process.argv[3] || '').trim();
  if (!action || !profileArg || !['inject', 'redact'].includes(action)) {
    usage();
    process.exit(1);
  }

  const profiles = profileArg === 'all' ? ['main', 'sub1'] : [profileArg];
  const results = [];

  for (const profile of profiles) {
    if (!PROFILE_TO_CONTAINER[profile]) {
      throw new Error(`unsupported profile: ${profile}`);
    }

    const { container, started } = ensureContainerRunning(profile);
    const seed = seedConfigIfMissing(profile, container);
    const patched = patchConfigInContainer(container, payloadFor(profile, action));
    results.push({
      profile,
      action,
      container,
      containerStarted: started,
      seed,
      patched,
    });
  }

  console.log(JSON.stringify({ ok: true, action, profiles: results }, null, 2));
}

try {
  runMain();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
