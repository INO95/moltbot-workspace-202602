const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEGACY_ENV_PATH = path.join(ROOT, '.env');
const DEFAULT_RUNTIME_ENV_PATH = path.join(os.homedir(), '.config', 'moltbot', 'runtime.env');

function parseEnv(raw) {
  const out = [];
  const lines = String(raw || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    out.push([key, value]);
  }
  return out;
}

function loadEnvFile(filePath, { override = false } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const [key, value] of parseEnv(raw)) {
    if (override || process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
  return true;
}

function resolveRuntimeEnvPath() {
  const configured = String(process.env.MOLTBOT_ENV_FILE || '').trim();
  return configured ? path.resolve(configured) : DEFAULT_RUNTIME_ENV_PATH;
}

function loadRuntimeEnv(options = {}) {
  const {
    allowLegacyFallback = true,
    warnOnLegacyFallback = false,
    required = false,
    override = false,
    silent = false,
  } = options;

  const runtimePath = resolveRuntimeEnvPath();
  let source = null;
  let usedLegacyFallback = false;

  if (loadEnvFile(runtimePath, { override })) {
    source = runtimePath;
  } else if (allowLegacyFallback && loadEnvFile(LEGACY_ENV_PATH, { override })) {
    source = LEGACY_ENV_PATH;
    usedLegacyFallback = true;
    if (warnOnLegacyFallback && !silent) {
      console.error(
        `[env] WARNING: using legacy workspace env file at ${LEGACY_ENV_PATH}. ` +
        `Move secrets to ${runtimePath} and set MOLTBOT_ENV_FILE explicitly.`,
      );
    }
  } else if (required) {
    throw new Error(
      `[env] runtime env file not found. Set MOLTBOT_ENV_FILE or create ${runtimePath}`,
    );
  }

  return {
    root: ROOT,
    source,
    runtimePath,
    legacyPath: LEGACY_ENV_PATH,
    usedLegacyFallback,
  };
}

function composeEnvArgs(options = {}) {
  const {
    allowLegacyFallback = true,
    required = false,
  } = options;
  const meta = loadRuntimeEnv({
    allowLegacyFallback,
    warnOnLegacyFallback: false,
    required: false,
    silent: true,
  });

  const candidate = meta.source || (fs.existsSync(meta.runtimePath) ? meta.runtimePath : null);
  if (candidate) return ['--env-file', candidate];
  if (required) {
    throw new Error(
      `[env] docker compose env file missing. Set MOLTBOT_ENV_FILE or create ${meta.runtimePath}`,
    );
  }
  return [];
}

module.exports = {
  ROOT,
  LEGACY_ENV_PATH,
  DEFAULT_RUNTIME_ENV_PATH,
  loadEnvFile,
  loadRuntimeEnv,
  resolveRuntimeEnvPath,
  composeEnvArgs,
};
