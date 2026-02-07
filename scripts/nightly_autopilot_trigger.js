#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'runtime', 'nightly_autopilot_state.json');

function nowKstLike() {
  return new Date();
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return { lastRunDate: null, lastRunAt: null, lastResultOk: null };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function inWindow(d) {
  const h = d.getHours();
  // 야간 배치는 03:00~05:59 사이 1회만 실행
  return h >= 3 && h <= 5;
}

function main() {
  if (String(process.env.SKIP_AUTOPILOT_TRIGGER || '') === '1') {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'SKIP_AUTOPILOT_TRIGGER' }, null, 2));
    return;
  }

  const now = nowKstLike();
  const today = localDateKey(now);
  const state = loadState();

  if (!inWindow(now)) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'outside window', now: now.toISOString() }, null, 2));
    return;
  }

  if (state.lastRunDate === today) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'already ran today', state }, null, 2));
    return;
  }

  const env = { ...process.env, SKIP_OPS_WORKER: '1', SKIP_AUTOPILOT_TRIGGER: '1' };
  const run = spawnSync('node', ['scripts/nightly_autopilot.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 15 * 60 * 1000,
  });

  const ok = !run.error && run.status === 0;
  const nextState = {
    lastRunDate: today,
    lastRunAt: new Date().toISOString(),
    lastResultOk: ok,
    lastExitCode: run.status == null ? 1 : run.status,
  };
  saveState(nextState);

  console.log(JSON.stringify({
    ok,
    triggered: true,
    state: nextState,
    stderr: String(run.stderr || '').trim().slice(0, 1000),
    stdout: String(run.stdout || '').trim().slice(0, 1000),
  }, null, 2));

  if (!ok) process.exit(1);
}

try {
  main();
} catch (e) {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
}
