#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { LEGACY_ENV_PATH, resolveRuntimeEnvPath } = require('./env_runtime');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyMode600(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {
    // ignore permission errors on unsupported filesystems
  }
}

function run() {
  const runtimePath = resolveRuntimeEnvPath();
  const hasLegacy = fs.existsSync(LEGACY_ENV_PATH);
  const hasRuntime = fs.existsSync(runtimePath);

  if (!hasLegacy && !hasRuntime) {
    throw new Error(
      `no env file found. create runtime env at ${runtimePath} or set MOLTBOT_ENV_FILE`,
    );
  }

  ensureDir(runtimePath);
  let moved = false;
  let backup = null;

  if (hasLegacy && !hasRuntime) {
    fs.renameSync(LEGACY_ENV_PATH, runtimePath);
    moved = true;
  } else if (hasLegacy && hasRuntime) {
    backup = `${runtimePath}.legacy-backup.${Date.now()}`;
    fs.copyFileSync(LEGACY_ENV_PATH, backup);
    copyMode600(backup);
    fs.unlinkSync(LEGACY_ENV_PATH);
    moved = true;
  }

  copyMode600(runtimePath);
  console.log(
    JSON.stringify(
      {
        ok: true,
        runtimePath,
        legacyPath: LEGACY_ENV_PATH,
        moved,
        backup,
      },
      null,
      2,
    ),
  );
}

try {
  run();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
