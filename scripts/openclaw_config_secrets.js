#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, composeEnvArgs, loadRuntimeEnv } = require('./env_runtime');

const CONTAINER_CONFIG_PATH = '/home/node/.openclaw/openclaw.json';

const PROFILE_META = {
  dev: {
    container: 'moltbot-dev',
    service: 'openclaw-dev',
    composeProfile: 'live',
    templateProfile: 'dev',
    gatewayEnv: 'OPENCLAW_GATEWAY_TOKEN_DEV',
    gatewayFallbackEnv: 'OPENCLAW_GATEWAY_TOKEN',
    botEnv: 'TELEGRAM_BOT_TOKEN_DEV',
    botFallbackEnv: 'TELEGRAM_BOT_TOKEN',
    userEnv: 'TELEGRAM_USER_ID_DEV',
    userFallbackEnv: 'TELEGRAM_USER_ID',
    enableEnv: 'OPENCLAW_DEV_TELEGRAM_ENABLED',
    enableFallbackEnv: 'OPENCLAW_MAIN_TELEGRAM_ENABLED',
    defaultTelegramEnabled: true,
    telegramName: 'MoltbotDev',
  },
  anki: {
    container: 'moltbot-anki',
    service: 'openclaw-anki',
    composeProfile: 'live',
    templateProfile: 'anki',
    gatewayEnv: 'OPENCLAW_GATEWAY_TOKEN_ANKI',
    gatewayFallbackEnv: 'OPENCLAW_GATEWAY_TOKEN_SUB1',
    botEnv: 'TELEGRAM_BOT_TOKEN_ANKI',
    botFallbackEnv: 'TELEGRAM_BOT_TOKEN_SUB1',
    userEnv: 'TELEGRAM_USER_ID_ANKI',
    userFallbackEnv: 'TELEGRAM_USER_ID_SUB1',
    enableEnv: 'OPENCLAW_ANKI_TELEGRAM_ENABLED',
    enableFallbackEnv: 'OPENCLAW_SUB1_TELEGRAM_ENABLED',
    defaultTelegramEnabled: false,
    telegramName: 'MoltbotAnki',
  },
  research: {
    container: 'moltbot-research',
    service: 'openclaw-research',
    composeProfile: 'live',
    templateProfile: 'research',
    gatewayEnv: 'OPENCLAW_GATEWAY_TOKEN_RESEARCH',
    gatewayFallbackEnv: 'OPENCLAW_GATEWAY_TOKEN',
    botEnv: 'TELEGRAM_BOT_TOKEN_TREND',
    botFallbackEnv: 'TELEGRAM_BOT_TOKEN_RESEARCH',
    userEnv: 'TELEGRAM_USER_ID_TREND',
    userFallbackEnv: 'TELEGRAM_USER_ID_RESEARCH',
    enableEnv: 'OPENCLAW_RESEARCH_TELEGRAM_ENABLED',
    defaultTelegramEnabled: false,
    telegramName: 'MoltbotResearch',
  },
  daily: {
    container: 'moltbot-daily',
    service: 'openclaw-daily',
    composeProfile: 'live',
    templateProfile: 'daily',
    gatewayEnv: 'OPENCLAW_GATEWAY_TOKEN_DAILY',
    gatewayFallbackEnv: 'OPENCLAW_GATEWAY_TOKEN',
    botEnv: 'TELEGRAM_BOT_TOKEN_DAILY',
    userEnv: 'TELEGRAM_USER_ID_DAILY',
    userFallbackEnv: 'TELEGRAM_USER_ID',
    enableEnv: 'OPENCLAW_DAILY_TELEGRAM_ENABLED',
    defaultTelegramEnabled: false,
    telegramName: 'MoltbotDaily',
  },
  dev_bak: {
    container: 'moltbot-dev-bak',
    service: 'openclaw-dev-bak',
    composeProfile: 'backup',
    templateProfile: 'dev',
    gatewayEnv: 'OPENCLAW_GATEWAY_TOKEN_DEV_BAK',
    gatewayFallbackEnv: 'OPENCLAW_GATEWAY_TOKEN_MAIN_BAK',
    gatewayFallbackEnv2: 'OPENCLAW_GATEWAY_TOKEN_DEV',
    botEnv: 'TELEGRAM_BOT_TOKEN_DEV_BAK',
    botFallbackEnv: 'TELEGRAM_BOT_TOKEN_MAIN_BAK',
    userEnv: 'TELEGRAM_USER_ID_DEV_BAK',
    userFallbackEnv: 'TELEGRAM_USER_ID_MAIN_BAK',
    enableEnv: 'OPENCLAW_DEV_BAK_TELEGRAM_ENABLED',
    enableFallbackEnv: 'OPENCLAW_MAIN_BAK_TELEGRAM_ENABLED',
    defaultTelegramEnabled: false,
    telegramName: 'MoltbotDevBackup',
  },
  anki_bak: {
    container: 'moltbot-anki-bak',
    service: 'openclaw-anki-bak',
    composeProfile: 'backup',
    templateProfile: 'anki',
    gatewayEnv: 'OPENCLAW_GATEWAY_TOKEN_ANKI_BAK',
    gatewayFallbackEnv: 'OPENCLAW_GATEWAY_TOKEN_SUB1_BAK',
    gatewayFallbackEnv2: 'OPENCLAW_GATEWAY_TOKEN_ANKI',
    botEnv: 'TELEGRAM_BOT_TOKEN_ANKI_BAK',
    botFallbackEnv: 'TELEGRAM_BOT_TOKEN_SUB1_BAK',
    userEnv: 'TELEGRAM_USER_ID_ANKI_BAK',
    userFallbackEnv: 'TELEGRAM_USER_ID_SUB1_BAK',
    enableEnv: 'OPENCLAW_ANKI_BAK_TELEGRAM_ENABLED',
    enableFallbackEnv: 'OPENCLAW_SUB1_BAK_TELEGRAM_ENABLED',
    defaultTelegramEnabled: false,
    telegramName: 'MoltbotAnkiBackup',
  },
  research_bak: {
    container: 'moltbot-research-bak',
    service: 'openclaw-research-bak',
    composeProfile: 'backup',
    templateProfile: 'research',
    gatewayEnv: 'OPENCLAW_GATEWAY_TOKEN_RESEARCH_BAK',
    gatewayFallbackEnv: 'OPENCLAW_GATEWAY_TOKEN_RESEARCH',
    gatewayFallbackEnv2: 'OPENCLAW_GATEWAY_TOKEN',
    botEnv: 'TELEGRAM_BOT_TOKEN_TREND_BAK',
    botFallbackEnv: 'TELEGRAM_BOT_TOKEN_RESEARCH_BAK',
    userEnv: 'TELEGRAM_USER_ID_TREND_BAK',
    userFallbackEnv: 'TELEGRAM_USER_ID_RESEARCH_BAK',
    enableEnv: 'OPENCLAW_RESEARCH_BAK_TELEGRAM_ENABLED',
    defaultTelegramEnabled: false,
    telegramName: 'MoltbotResearchBackup',
  },
  daily_bak: {
    container: 'moltbot-daily-bak',
    service: 'openclaw-daily-bak',
    composeProfile: 'backup',
    templateProfile: 'daily',
    gatewayEnv: 'OPENCLAW_GATEWAY_TOKEN_DAILY_BAK',
    gatewayFallbackEnv: 'OPENCLAW_GATEWAY_TOKEN_DAILY',
    gatewayFallbackEnv2: 'OPENCLAW_GATEWAY_TOKEN',
    botEnv: 'TELEGRAM_BOT_TOKEN_DAILY_BAK',
    botFallbackEnv: null,
    userEnv: 'TELEGRAM_USER_ID_DAILY_BAK',
    userFallbackEnv: 'TELEGRAM_USER_ID_DAILY',
    enableEnv: 'OPENCLAW_DAILY_BAK_TELEGRAM_ENABLED',
    defaultTelegramEnabled: false,
    telegramName: 'MoltbotDailyBackup',
  },
};

const LIVE_PROFILES = ['dev', 'anki', 'research', 'daily'];
const BACKUP_PROFILES = ['dev_bak', 'anki_bak', 'research_bak', 'daily_bak'];
const ALL_PROFILES = [...LIVE_PROFILES, ...BACKUP_PROFILES];
const PROFILE_ALIASES = {
  main: 'dev',
  sub1: 'anki',
  main_bak: 'dev_bak',
  sub1_bak: 'anki_bak',
};

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

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function parseBoolean(input, fallback = false) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureContainerRunning(profile) {
  const meta = PROFILE_META[profile];
  const { container, service, composeProfile } = meta;
  const isRunning = run('docker', ['inspect', '-f', '{{.State.Running}}', container]);
  if (isRunning.ok && isRunning.stdout === 'true') {
    return { container, service, started: false };
  }

  const args = ['compose', ...composeEnvArgs({ allowLegacyFallback: true, required: false })];
  if (composeProfile) {
    args.push('--profile', composeProfile);
  }
  args.push('up', '-d', service);
  mustRun('docker', args, { cwd: ROOT });

  return { container, service, started: true };
}

function templatePath(profile) {
  const meta = PROFILE_META[profile];
  const templateProfile = meta && meta.templateProfile ? meta.templateProfile : profile;
  return path.join(ROOT, 'configs', templateProfile, 'openclaw.json');
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
  else delete cfg.gateway.auth.token;
} else if (cfg.gateway && cfg.gateway.auth) {
  delete cfg.gateway.auth.token;
}

cfg.channels = cfg.channels || {};
cfg.channels.telegram = cfg.channels.telegram || {};
cfg.channels.telegram.groupPolicy = 'allowlist';
cfg.channels.telegram.dmPolicy = payload.dmPolicy || 'allowlist';
if (payload.telegramName) cfg.channels.telegram.name = payload.telegramName;

if (payload.action === 'inject') {
  const enabled = Boolean(payload.telegramEnabled && payload.botToken);
  cfg.channels.telegram.enabled = enabled;
  if (enabled) {
    cfg.channels.telegram.botToken = payload.botToken;
    if (Array.isArray(payload.allowFrom) && payload.allowFrom.length) {
      cfg.channels.telegram.allowFrom = payload.allowFrom;
    } else {
      delete cfg.channels.telegram.allowFrom;
    }
  } else {
    delete cfg.channels.telegram.botToken;
    delete cfg.channels.telegram.allowFrom;
  }
} else {
  cfg.channels.telegram.enabled = false;
  delete cfg.channels.telegram.botToken;
  delete cfg.channels.telegram.allowFrom;
}

cfg.plugins = cfg.plugins || {};
cfg.plugins.entries = cfg.plugins.entries || {};
cfg.plugins.entries.telegram = cfg.plugins.entries.telegram || {};
cfg.plugins.entries.telegram.enabled = payload.action === 'inject'
  ? Boolean(payload.telegramEnabled && payload.botToken)
  : false;

cfg.skills = cfg.skills || {};
cfg.skills.entries = cfg.skills.entries || {};
const githubSkill = cfg.skills.entries.github || {};
if (payload.action === 'inject' && payload.githubToken) {
  githubSkill.enabled = true;
  githubSkill.env = githubSkill.env || {};
  githubSkill.env.GITHUB_TOKEN = payload.githubToken;
  cfg.skills.entries.github = githubSkill;
} else {
  if (githubSkill.env) delete githubSkill.env.GITHUB_TOKEN;
  if (githubSkill.env && Object.keys(githubSkill.env).length === 0) delete githubSkill.env;
  githubSkill.enabled = false;
  if (Object.keys(githubSkill).length === 1 && githubSkill.enabled === false) {
    delete cfg.skills.entries.github;
  } else {
    cfg.skills.entries.github = githubSkill;
  }
}

if (cfg.plugins.entries.github) {
  if (payload.action === 'inject' && payload.githubToken) {
    cfg.plugins.entries.github.enabled = true;
    cfg.plugins.entries.github.token = payload.githubToken;
  } else {
    delete cfg.plugins.entries.github.token;
    cfg.plugins.entries.github.enabled = false;
  }
}

// Hard-disable Google auth plugins for this workspace policy.
if (cfg.plugins.entries['google-antigravity-auth']) {
  cfg.plugins.entries['google-antigravity-auth'].enabled = false;
}
if (cfg.plugins.entries['google-gemini-cli-auth']) {
  cfg.plugins.entries['google-gemini-cli-auth'].enabled = false;
}

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({
  ok: true,
  profile: payload.profile,
  action: payload.action,
  cfgPath,
  gatewayTokenSet: Boolean(cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token),
  telegramEnabled: cfg && cfg.channels && cfg.channels.telegram ? cfg.channels.telegram.enabled === true : false,
  githubTokenSet: Boolean(
    (cfg && cfg.skills && cfg.skills.entries && cfg.skills.entries.github &&
      cfg.skills.entries.github.env && cfg.skills.entries.github.env.GITHUB_TOKEN) ||
    (cfg && cfg.plugins && cfg.plugins.entries && cfg.plugins.entries.github &&
      cfg.plugins.entries.github.token)
  )
}));
`;

  const out = mustRun('docker', ['exec', '-i', container, 'node', '-e', script, JSON.stringify(payload)]);
  const parsed = parseJsonFromStdout(out.stdout);
  return parsed || { ok: true, raw: out.stdout };
}

function payloadFor(profile, action) {
  const meta = PROFILE_META[profile];
  const githubToken = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();

  const gatewayToken = firstNonEmpty(
    process.env[meta.gatewayEnv],
    meta.gatewayFallbackEnv ? process.env[meta.gatewayFallbackEnv] : '',
    meta.gatewayFallbackEnv2 ? process.env[meta.gatewayFallbackEnv2] : '',
  );
  const botToken = firstNonEmpty(
    process.env[meta.botEnv],
    meta.botFallbackEnv ? process.env[meta.botFallbackEnv] : '',
  );
  const allowFromRaw = firstNonEmpty(
    process.env[meta.userEnv],
    meta.userFallbackEnv ? process.env[meta.userFallbackEnv] : '',
    process.env.TELEGRAM_USER_ID,
  );

  if (action === 'redact') {
    return {
      profile,
      action,
      gatewayToken: '',
      githubToken: '',
      dmPolicy: 'allowlist',
      telegramEnabled: false,
      botToken: '',
      allowFrom: [],
      telegramName: meta.telegramName,
    };
  }

  const enableRawPrimary = Object.prototype.hasOwnProperty.call(process.env, meta.enableEnv)
    ? process.env[meta.enableEnv]
    : '';
  const enableRawFallback = meta.enableFallbackEnv && Object.prototype.hasOwnProperty.call(process.env, meta.enableFallbackEnv)
    ? process.env[meta.enableFallbackEnv]
    : '';
  const enableRaw = firstNonEmpty(enableRawPrimary, enableRawFallback);
  const enabledByFlag = parseBoolean(enableRaw, meta.defaultTelegramEnabled);

  return {
    profile,
    action,
    gatewayToken,
    githubToken,
    dmPolicy: 'allowlist',
    telegramEnabled: Boolean(enabledByFlag && botToken),
    botToken,
    allowFrom: ensureStringArray(allowFromRaw),
    telegramName: meta.telegramName,
  };
}

function usage() {
  console.error('Usage: node scripts/openclaw_config_secrets.js <inject|redact> <dev|anki|research|daily|dev_bak|anki_bak|research_bak|daily_bak|all_live|all_backup|all>');
}

function resolveProfiles(profileArg) {
  if (profileArg === 'all') return [...ALL_PROFILES];
  if (profileArg === 'all_live') return [...LIVE_PROFILES];
  if (profileArg === 'all_backup') return [...BACKUP_PROFILES];
  return [PROFILE_ALIASES[profileArg] || profileArg];
}

function runMain() {
  loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true, required: false });

  const action = String(process.argv[2] || '').trim();
  const profileArg = String(process.argv[3] || '').trim();
  if (!action || !profileArg || !['inject', 'redact'].includes(action)) {
    usage();
    process.exit(1);
  }

  const profiles = resolveProfiles(profileArg);
  const results = [];

  for (const profile of profiles) {
    if (!PROFILE_META[profile]) {
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
