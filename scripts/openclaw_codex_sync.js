#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { ROOT, composeEnvArgs, loadRuntimeEnv } = require('./env_runtime');

const CONFIG_PATH = '/home/node/.openclaw/openclaw.json';

const PROFILE_META = {
  dev: { container: 'moltbot-dev', service: 'openclaw-dev', composeProfile: 'live' },
  anki: { container: 'moltbot-anki', service: 'openclaw-anki', composeProfile: 'live' },
  research: { container: 'moltbot-research', service: 'openclaw-research', composeProfile: 'live' },
  daily: { container: 'moltbot-daily', service: 'openclaw-daily', composeProfile: 'live' },
  codex: { container: 'moltbot-codex', service: 'openclaw-codex', composeProfile: 'live' },
  dev_bak: { container: 'moltbot-dev-bak', service: 'openclaw-dev-bak', composeProfile: 'backup' },
  anki_bak: { container: 'moltbot-anki-bak', service: 'openclaw-anki-bak', composeProfile: 'backup' },
  research_bak: { container: 'moltbot-research-bak', service: 'openclaw-research-bak', composeProfile: 'backup' },
  daily_bak: { container: 'moltbot-daily-bak', service: 'openclaw-daily-bak', composeProfile: 'backup' },
};

const LIVE_PROFILES = ['dev', 'anki', 'research', 'daily', 'codex'];
const BACKUP_PROFILES = ['dev_bak', 'anki_bak', 'research_bak', 'daily_bak'];

// Operational profile:
// - default: gpt-5.2-pro
// - complex coding: gpt-5.3-codex
// - ultra-low-latency edit loops: gpt-5.3-codex-spark
const DEFAULT_PREFERRED = [
  'openai/gpt-5.2-pro',
  'openai/gpt-5.2',
  'openai-codex/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
];

const CODING_PREFERRED = [
  'openai-codex/gpt-5.3-codex',
  'openai-codex/gpt-5.2-codex',
  'openai-codex/gpt-5.2',
];

const SPARK_PREFERRED = [
  'openai-codex/gpt-5.3-codex-spark',
  'openai-codex/gpt-5.1-codex-mini',
  'openai-codex/gpt-5.1',
];

// Keep spark out of automatic fallback by default (text-only model).
const DEFAULT_OPERATION_FALLBACKS = [
  'openai/gpt-5.2-pro',
  'openai/gpt-5.2',
  'openai-codex/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: !res.error && res.status === 0,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function mustRun(cmd, args, opts = {}) {
  const out = run(cmd, args, opts);
  if (out.ok) return out;
  throw new Error(`${cmd} ${args.join(' ')} failed: ${out.stderr || out.stdout || out.error || 'unknown error'}`);
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

function parseArgs(argv) {
  const out = {
    profiles: [...LIVE_PROFILES],
    includeBackup: false,
    restart: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--restart') {
      out.restart = true;
      continue;
    }
    if (arg === '--include-backup') {
      out.includeBackup = true;
      continue;
    }
    if (arg === '--profiles' && argv[i + 1]) {
      out.profiles = String(argv[i + 1] || '')
        .split(',')
        .map((v) => resolveProfileName(v))
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }

  if (out.includeBackup) {
    out.profiles = [...new Set([...out.profiles, ...BACKUP_PROFILES])];
  }
  return out;
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/openclaw_codex_sync.js [--profiles dev,anki,research,daily,codex] [--include-backup] [--restart]\n',
  );
}

function resolveProfileName(name) {
  const raw = String(name || '').trim();
  const aliases = {
    main: 'dev',
    sub1: 'anki',
    trend: 'research',
    main_bak: 'dev_bak',
    sub1_bak: 'anki_bak',
    trend_bak: 'research_bak',
  };
  return aliases[raw] || raw;
}

function ensureProfile(profile) {
  if (!PROFILE_META[profile]) {
    throw new Error(`unsupported profile: ${profile}`);
  }
}

function ensureContainerRunning(profile) {
  ensureProfile(profile);
  const meta = PROFILE_META[profile];
  const running = run('docker', ['inspect', '-f', '{{.State.Running}}', meta.container]);
  if (running.ok && running.stdout === 'true') {
    return { container: meta.container, started: false };
  }
  const args = ['compose', ...composeEnvArgs({ allowLegacyFallback: true, required: false })];
  if (meta.composeProfile) args.push('--profile', meta.composeProfile);
  args.push('up', '-d', meta.service);
  mustRun('docker', args, { cwd: ROOT });
  return { container: meta.container, started: true };
}

function listAvailableModels(container, provider) {
  const out = mustRun(
    'docker',
    ['exec', container, '/bin/sh', '-lc', `node dist/index.js models list --all --provider ${provider} --plain`],
  );
  return out.stdout
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

function selectBest(available, preferred, excludes = new Set()) {
  const skip = excludes instanceof Set ? excludes : new Set(excludes || []);
  for (const model of preferred) {
    if (skip.has(model)) continue;
    if (available.includes(model)) return model;
  }
  return null;
}

function syncConfigInContainer(container, selection) {
  const script = `
const fs = require('fs');
const cfgPath = ${JSON.stringify(CONFIG_PATH)};
const defaultModel = ${JSON.stringify(selection.defaultModel)};
const codingModel = ${JSON.stringify(selection.codingModel)};
const sparkModel = ${JSON.stringify(selection.sparkModel)};
const defaultFallbacks = ${JSON.stringify(DEFAULT_OPERATION_FALLBACKS)};
const availableModels = ${JSON.stringify(selection.availableModels || [])};

let cfg = {};
let raw = '';
try {
  raw = fs.readFileSync(cfgPath, 'utf8');
  cfg = JSON.parse(raw);
} catch (_) {
  cfg = {};
}

cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
const defaults = cfg.agents.defaults;
defaults.model = defaults.model || {};
defaults.models = defaults.models || {};
const model = defaults.model;
const models = defaults.models;
const availableSet = new Set(availableModels.map((v) => String(v || '').trim()).filter(Boolean));

const trackedAliases = new Set(['gpt', 'codex', 'deep', 'spark', 'fast']);
for (const key of Object.keys(models)) {
  const row = models[key];
  if (!row || typeof row !== 'object') continue;
  if (trackedAliases.has(row.alias)) delete row.alias;
}

function setAlias(modelName, alias) {
  if (!modelName || !alias) return;
  models[modelName] = { ...(models[modelName] || {}), alias };
}

setAlias(defaultModel, 'gpt');
setAlias(codingModel, 'codex');
setAlias(sparkModel, 'spark');

model.primary = defaultModel;
let nextFallbacks = defaultFallbacks
  .filter((v) => availableSet.has(v))
  .filter((v) => v !== defaultModel);
if (codingModel && codingModel !== defaultModel && !nextFallbacks.includes(codingModel)) {
  nextFallbacks.unshift(codingModel);
}
model.fallbacks = [...new Set(nextFallbacks)];

if (!cfg.gateway) cfg.gateway = {};
cfg.gateway.bind = 'loopback';

const nextRaw = JSON.stringify(cfg, null, 2) + '\\n';
const changed = nextRaw !== raw;
if (changed) fs.writeFileSync(cfgPath, nextRaw, 'utf8');

process.stdout.write(JSON.stringify({
  ok: true,
  cfgPath,
  changed,
  primary: model.primary,
  fallbacks: model.fallbacks,
  aliases: {
    gpt: defaultModel,
    codex: codingModel,
    spark: sparkModel
  },
  gatewayBind: cfg.gateway.bind
}));
`;
  const out = mustRun('docker', ['exec', '-i', container, 'node', '-e', script]);
  const parsed = parseJsonFromStdout(out.stdout);
  if (!parsed) throw new Error(`failed to parse config sync output for ${container}`);
  return parsed;
}

function restartContainer(container, enabled) {
  if (!enabled) return false;
  mustRun('docker', ['restart', container]);
  return true;
}

function main() {
  loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true, required: false });
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }
  const profiles = (args.profiles || []).map(resolveProfileName);
  for (const profile of profiles) ensureProfile(profile);

  const results = [];
  for (const profile of profiles) {
    const started = ensureContainerRunning(profile);
    const container = PROFILE_META[profile].container;
    const availableOpenAI = listAvailableModels(container, 'openai');
    const availableCodex = listAvailableModels(container, 'openai-codex');
    const available = [...new Set([...availableOpenAI, ...availableCodex])];
    const defaultModel = selectBest(available, DEFAULT_PREFERRED);
    if (!defaultModel) {
      throw new Error(`[${profile}] no default model found. available=${available.join(',')}`);
    }
    let codingModel = selectBest(available, CODING_PREFERRED, new Set([defaultModel]));
    if (!codingModel) {
      codingModel = selectBest(available, CODING_PREFERRED);
    }
    if (!codingModel) {
      throw new Error(`[${profile}] no coding codex model found. available=${available.join(',')}`);
    }
    let sparkModel = selectBest(available, SPARK_PREFERRED, new Set([defaultModel, codingModel]));
    if (!sparkModel) {
      sparkModel = selectBest(available, SPARK_PREFERRED, new Set([defaultModel]));
    }
    if (!sparkModel) {
      throw new Error(`[${profile}] no spark/fast codex model found. available=${available.join(',')}`);
    }

    const sync = syncConfigInContainer(container, {
      defaultModel,
      codingModel,
      sparkModel,
      availableModels: available,
    });
    const restarted = restartContainer(container, args.restart && sync.changed);

    results.push({
      profile,
      container,
      containerStarted: started.started,
      changed: sync.changed,
      restarted,
      primary: sync.primary,
      fallbacks: sync.fallbacks,
      aliases: sync.aliases,
      available,
    });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    profiles,
    restartRequested: args.restart,
    results,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  LIVE_PROFILES,
  PROFILE_META,
  listAvailableModels,
  selectBest,
};
