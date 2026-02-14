const { spawnSync } = require('child_process');
const { ROOT, composeEnvArgs, loadRuntimeEnv } = require('./env_runtime');

const CONTAINER = 'moltbot-main';
const CONFIG_PATH = '/home/node/.openclaw/openclaw.json';

const PREFERRED = [
  'openai-codex/gpt-5.3-codex',
  'openai-codex/gpt-5.2-codex',
  'openai-codex/gpt-5.2',
  'openai-codex/gpt-5.1-codex-max',
  'openai-codex/gpt-5.1',
];

const DEFAULT_OPENAI_FALLBACKS = [
  'openai-codex/gpt-5.2',
  'openai-codex/gpt-5.1-codex-mini',
  'openai-codex/gpt-5.1',
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

function ensureMainRunning() {
  const running = run('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER]);
  if (running.ok && running.stdout === 'true') return false;
  const args = ['compose', ...composeEnvArgs({ allowLegacyFallback: true, required: false }), 'up', '-d', 'openclaw-main'];
  mustRun('docker', args, { cwd: ROOT });
  return true;
}

function listAvailableCodexModels() {
  const out = mustRun(
    'docker',
    ['exec', CONTAINER, '/bin/sh', '-lc', 'node dist/index.js models list --all --provider openai-codex --plain'],
  );
  return out.stdout
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

function selectBest(available) {
  for (const model of PREFERRED) {
    if (available.includes(model)) return model;
  }
  return null;
}

function syncConfigInContainer(bestModel) {
  const script = `
const fs = require('fs');
const cfgPath = ${JSON.stringify(CONFIG_PATH)};
const bestModel = ${JSON.stringify(bestModel)};
const defaultFallbacks = ${JSON.stringify(DEFAULT_OPENAI_FALLBACKS)};

function isGeminiModel(model) {
  return String(model || '').trim().toLowerCase().startsWith('google/gemini');
}

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

const prevFallbacks = Array.isArray(model.fallbacks) ? model.fallbacks : [];
const cleanedFallbacks = prevFallbacks.filter((v) => {
  const value = String(v || '').trim();
  if (!value) return false;
  if (isGeminiModel(value)) return false;
  return true;
});

const prevPrimary = String(model.primary || '').trim();
const primary = !prevPrimary || isGeminiModel(prevPrimary) ? bestModel : prevPrimary;
model.primary = primary;

let nextFallbacks = cleanedFallbacks.filter((v) => v !== primary);
if (nextFallbacks.length === 0) {
  nextFallbacks = defaultFallbacks.filter((v) => v !== primary);
}
if (bestModel !== primary && !nextFallbacks.includes(bestModel)) {
  nextFallbacks.unshift(bestModel);
}
model.fallbacks = [...new Set(nextFallbacks)];

for (const key of Object.keys(models)) {
  if (models[key] && models[key].alias === 'codex' && key !== bestModel) {
    delete models[key].alias;
  }
}
models[bestModel] = { ...(models[bestModel] || {}), alias: 'codex' };

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
  codexAlias: bestModel,
  gatewayBind: cfg.gateway.bind
}));
`;
  const out = mustRun('docker', ['exec', '-i', CONTAINER, 'node', '-e', script]);
  const parsed = parseJsonFromStdout(out.stdout);
  if (!parsed) throw new Error('failed to parse openclaw config sync output');
  return parsed;
}

function maybeRestart(changed, args) {
  if (!changed) return false;
  if (!args.includes('--restart')) return false;
  const composeArgs = [
    'compose',
    ...composeEnvArgs({ allowLegacyFallback: true, required: false }),
    'up',
    '-d',
    '--force-recreate',
    'openclaw-main',
  ];
  mustRun('docker', composeArgs, { cwd: ROOT });
  return true;
}

function main() {
  loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true, required: false });
  const args = process.argv.slice(2);
  const started = ensureMainRunning();
  const available = listAvailableCodexModels();
  const bestModel = selectBest(available);
  if (!bestModel) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: 'no_openai_codex_model_found',
          available,
          containerStarted: started,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const sync = syncConfigInContainer(bestModel);
  const restarted = maybeRestart(sync.changed, args);

  console.log(
    JSON.stringify(
      {
        ok: true,
        containerStarted: started,
        bestModel,
        available,
        changed: sync.changed,
        restarted,
        primary: sync.primary,
        fallbacks: sync.fallbacks,
        gatewayBind: sync.gatewayBind,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { listAvailableCodexModels, selectBest };
