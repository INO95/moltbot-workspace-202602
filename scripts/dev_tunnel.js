#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadRuntimeEnv } = require('./env_runtime');

const CONTAINER = 'moltbot-dev-tunnel';
const IMAGE = 'cloudflare/cloudflared:latest';
const STATE_PATH = path.join(__dirname, '..', 'data', 'runtime', 'tunnel_state.json');

function getTargetUrl() {
  return String(process.env.DEV_TUNNEL_TARGET || 'http://host.docker.internal:18787').trim();
}

function getNamedToken() {
  return String(process.env.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
}

function getNamedPublicBase() {
  return String(process.env.DEV_TUNNEL_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
}

loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true });

function resolveMode() {
  return getNamedToken() ? 'named' : 'quick';
}

function normalizedPublicBase(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+$/i.test(u) ? u : null;
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    ok: !res.error && res.status === 0,
    code: res.status == null ? 1 : res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function extractUrl(logText) {
  const m = String(logText || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
  return m ? m[m.length - 1] : null;
}

function saveState(payload) {
  try {
    const dir = path.dirname(STATE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {}
}

function ensureRunning() {
  const ps = run('docker', ['ps', '--format', '{{.Names}}']);
  if (!ps.ok) return { ok: false, error: ps.stderr || ps.error };
  if (ps.stdout.split('\n').includes(CONTAINER)) return { ok: true, started: false };

  run('docker', ['rm', '-f', CONTAINER]);
  const mode = resolveMode();
  const targetUrl = getTargetUrl();
  const namedToken = getNamedToken();
  const args = [
    'run',
    '-d',
    '--name', CONTAINER,
    '--restart', 'unless-stopped',
    IMAGE,
    'tunnel',
    '--no-autoupdate',
  ];
  if (mode === 'named') {
    args.push('run', '--token', namedToken);
  } else {
    args.push('--url', targetUrl);
  }
  const start = run('docker', args);
  if (!start.ok) return { ok: false, error: start.stderr || start.error };
  return { ok: true, started: true, mode };
}

function status() {
  const ps = run('docker', ['ps', '--filter', `name=${CONTAINER}`, '--format', '{{.Names}}\t{{.Status}}']);
  if (!ps.ok) throw new Error(ps.stderr || ps.error);
  const logs = run('docker', ['logs', '--tail', '200', CONTAINER]);
  const mode = resolveMode();
  const targetUrl = getTargetUrl();
  const namedPublicBase = getNamedPublicBase();
  const discovered = logs.ok ? extractUrl(logs.stdout + '\n' + logs.stderr) : null;
  const url = mode === 'named' ? (normalizedPublicBase(namedPublicBase) || discovered) : discovered;
  const out = {
    ok: true,
    mode,
    running: Boolean(ps.stdout),
    status: ps.stdout || 'not-running',
    target: targetUrl,
    publicUrl: url,
  };
  saveState({ ...out, updatedAt: new Date().toISOString() });
  console.log(JSON.stringify(out, null, 2));
}

function start() {
  const r = ensureRunning();
  if (!r.ok) throw new Error(r.error || 'failed to start tunnel');
  const logs = run('docker', ['logs', '--tail', '300', CONTAINER]);
  const mode = r.mode || resolveMode();
  const targetUrl = getTargetUrl();
  const namedPublicBase = getNamedPublicBase();
  const discovered = logs.ok ? extractUrl(logs.stdout + '\n' + logs.stderr) : null;
  const url = mode === 'named' ? (normalizedPublicBase(namedPublicBase) || discovered) : discovered;
  const out = {
    ok: true,
    mode,
    started: r.started,
    container: CONTAINER,
    target: targetUrl,
    publicUrl: url,
    note: mode === 'named'
      ? 'named tunnel active (public URL should remain stable)'
      : 'publicUrl can rotate after restart (free quick tunnel)',
  };
  saveState({ ...out, running: true, updatedAt: new Date().toISOString() });
  console.log(JSON.stringify(out, null, 2));
}

function stop() {
  const rm = run('docker', ['rm', '-f', CONTAINER]);
  if (!rm.ok && !/No such container/i.test(rm.stderr)) {
    throw new Error(rm.stderr || rm.error);
  }
  saveState({
    ok: true,
    mode: resolveMode(),
    running: false,
    status: 'stopped',
    target: getTargetUrl(),
    publicUrl: null,
    updatedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({ ok: true, stopped: true, container: CONTAINER }, null, 2));
}

function showUrl() {
  const logs = run('docker', ['logs', '--tail', '300', CONTAINER]);
  if (!logs.ok) throw new Error(logs.stderr || logs.error);
  const mode = resolveMode();
  const namedPublicBase = getNamedPublicBase();
  const discovered = extractUrl(logs.stdout + '\n' + logs.stderr);
  const url = mode === 'named' ? (normalizedPublicBase(namedPublicBase) || discovered) : discovered;
  const out = { ok: true, mode, container: CONTAINER, publicUrl: url };
  saveState({ ...out, running: true, target: getTargetUrl(), updatedAt: new Date().toISOString() });
  console.log(JSON.stringify(out, null, 2));
}

function main() {
  const action = String(process.argv[2] || 'status').toLowerCase();
  if (action === 'start') return start();
  if (action === 'status') return status();
  if (action === 'stop') return stop();
  if (action === 'url') return showUrl();
  console.error('usage: node scripts/dev_tunnel.js <start|status|url|stop>');
  process.exit(2);
}

try {
  main();
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
