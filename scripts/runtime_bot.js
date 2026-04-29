#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { ROOT, composeEnvArgs } = require('./env_runtime');

const RUNTIMES = Object.freeze({
  daily: { service: 'openclaw-daily', container: 'moltbot-daily' },
  dev: { service: 'openclaw-dev', container: 'moltbot-dev' },
  anki: { service: 'openclaw-anki', container: 'moltbot-anki' },
  research: { service: 'openclaw-research', container: 'moltbot-research' },
});

function runDocker(args) {
  const res = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  return {
    ok: !res.error && res.status === 0,
    code: Number.isInteger(res.status) ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function parseJsonLine(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function status(runtimeKey) {
  const runtime = RUNTIMES[runtimeKey];
  const res = runDocker([
    'ps',
    '-a',
    '--filter',
    `name=^/${runtime.container}$`,
    '--format',
    '{{json .}}',
  ]);
  if (!res.ok) {
    return {
      ok: true,
      runtime: runtimeKey,
      service: runtime.service,
      container: runtime.container,
      dockerOk: false,
      state: 'unknown',
      error: res.error || res.stderr || `exit=${res.code}`,
    };
  }
  const line = res.stdout.split(/\r?\n/).map((v) => v.trim()).find(Boolean);
  if (!line) {
    return {
      ok: true,
      runtime: runtimeKey,
      service: runtime.service,
      container: runtime.container,
      dockerOk: true,
      state: 'missing',
    };
  }
  const parsed = parseJsonLine(line);
  return {
    ok: true,
    runtime: runtimeKey,
    service: runtime.service,
    container: runtime.container,
    dockerOk: true,
    state: String((parsed && parsed.State) || (parsed && parsed.Status) || 'unknown'),
    status: String((parsed && parsed.Status) || ''),
    raw: parsed || line,
  };
}

function composeAction(runtimeKey, action) {
  const runtime = RUNTIMES[runtimeKey];
  const base = ['compose', ...composeEnvArgs({ allowLegacyFallback: true, required: false }), '--profile', 'live'];
  const actionArgs = action === 'start'
    ? ['up', '-d', runtime.service]
    : action === 'stop'
      ? ['stop', runtime.service]
      : ['restart', runtime.service];
  const res = runDocker([...base, ...actionArgs]);
  return {
    ok: res.ok,
    runtime: runtimeKey,
    service: runtime.service,
    action,
    code: res.code,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    error: res.error,
    status: status(runtimeKey),
  };
}

function main() {
  const runtimeKey = String(process.argv[2] || '').trim();
  const action = String(process.argv[3] || 'status').trim();
  if (!RUNTIMES[runtimeKey] || !['status', 'start', 'stop', 'restart'].includes(action)) {
    console.error(JSON.stringify({
      ok: false,
      error: 'usage: node scripts/runtime_bot.js <daily|dev|anki|research> <status|start|stop|restart>',
    }, null, 2));
    process.exit(1);
  }

  const result = action === 'status'
    ? status(runtimeKey)
    : composeAction(runtimeKey, action);
  console.log(JSON.stringify(result, null, 2));
  if (action !== 'status' && !result.ok) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  RUNTIMES,
  status,
  composeAction,
};
