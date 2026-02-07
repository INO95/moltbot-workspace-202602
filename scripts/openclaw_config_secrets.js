#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(ENV_PATH);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function ensureStringArray(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function profileConfigPath(profile) {
  return path.join(ROOT, 'configs', profile, 'openclaw.json');
}

function applyInject(profile) {
  const cfgPath = profileConfigPath(profile);
  const cfg = readJson(cfgPath);

  cfg.gateway = cfg.gateway || {};
  cfg.gateway.mode = 'local';
  cfg.gateway.auth = cfg.gateway.auth || {};

  const gatewayEnvKey = profile === 'main' ? 'OPENCLAW_GATEWAY_TOKEN' : 'OPENCLAW_GATEWAY_TOKEN_SUB1';
  const gatewayToken = String(process.env[gatewayEnvKey] || '').trim();
  if (gatewayToken) cfg.gateway.auth.token = gatewayToken;

  cfg.channels = cfg.channels || {};
  cfg.channels.telegram = cfg.channels.telegram || {};

  if (profile === 'main') {
    const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const allowFrom = ensureStringArray(process.env.TELEGRAM_USER_ID);
    cfg.channels.telegram.enabled = Boolean(botToken);
    if (botToken) cfg.channels.telegram.botToken = botToken;
    if (allowFrom.length) cfg.channels.telegram.allowFrom = allowFrom;
  } else {
    const subEnabled = String(process.env.OPENCLAW_SUB1_TELEGRAM_ENABLED || 'false').toLowerCase() === 'true';
    cfg.channels.telegram.enabled = subEnabled;
    if (subEnabled) {
      const botToken = String(process.env.TELEGRAM_BOT_TOKEN_SUB1 || process.env.TELEGRAM_BOT_TOKEN || '').trim();
      const allowFrom = ensureStringArray(process.env.TELEGRAM_USER_ID_SUB1 || process.env.TELEGRAM_USER_ID);
      if (botToken) cfg.channels.telegram.botToken = botToken;
      if (allowFrom.length) cfg.channels.telegram.allowFrom = allowFrom;
    } else {
      delete cfg.channels.telegram.botToken;
      delete cfg.channels.telegram.allowFrom;
      cfg.channels.telegram.name = 'MoltbotBackup';
    }
  }

  writeJson(cfgPath, cfg);
  return { profile, action: 'inject', config: cfgPath };
}

function applyRedact(profile) {
  const cfgPath = profileConfigPath(profile);
  const cfg = readJson(cfgPath);

  if (cfg.gateway && cfg.gateway.auth) {
    delete cfg.gateway.auth.token;
  }
  cfg.channels = cfg.channels || {};
  cfg.channels.telegram = cfg.channels.telegram || {};
  delete cfg.channels.telegram.botToken;
  delete cfg.channels.telegram.allowFrom;

  writeJson(cfgPath, cfg);
  return { profile, action: 'redact', config: cfgPath };
}

function usage() {
  console.error('Usage: node scripts/openclaw_config_secrets.js <inject|redact> <main|sub1|all>');
}

function run() {
  const action = String(process.argv[2] || '').trim();
  const profileArg = String(process.argv[3] || '').trim();
  if (!action || !profileArg) {
    usage();
    process.exit(1);
  }

  const profiles = profileArg === 'all' ? ['main', 'sub1'] : [profileArg];
  const out = [];
  for (const p of profiles) {
    if (!['main', 'sub1'].includes(p)) {
      throw new Error(`unsupported profile: ${p}`);
    }
    if (action === 'inject') out.push(applyInject(p));
    else if (action === 'redact') out.push(applyRedact(p));
    else {
      usage();
      process.exit(1);
    }
  }
  console.log(JSON.stringify({ ok: true, action, profiles: out }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
