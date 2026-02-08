#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(__dirname, '..', 'data', 'runtime');
const QUEUE_PATH = path.join(RUNTIME_DIR, 'ops_requests.jsonl');
const RESULT_PATH = path.join(RUNTIME_DIR, 'ops_results.jsonl');
const PROCESSED_PATH = path.join(RUNTIME_DIR, 'ops_processed_ids.json');
const SNAPSHOT_PATH = path.join(RUNTIME_DIR, 'ops_snapshot.json');
const TUNNEL_STATE_PATH = path.join(RUNTIME_DIR, 'tunnel_state.json');
const MAIN_SESSIONS_DIR = path.join(ROOT, 'configs', 'main', 'agents', 'main', 'sessions');
const MAIN_SESSIONS_JSON = path.join(MAIN_SESSIONS_DIR, 'sessions.json');
const MAIN_SESSION_KEY = 'agent:main:main';

const KNOWN_CONTAINERS = [
  'moltbot-main',
  'moltbot-sub1',
  'moltbot-prompt-web',
  'moltbot-proxy',
  'moltbot-web-proxy',
  'moltbot-dev-tunnel',
];

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

function ensureDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  return fs.readFileSync(QUEUE_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function appendResult(result) {
  fs.appendFileSync(RESULT_PATH, `${JSON.stringify(result)}\n`, 'utf8');
}

function getTunnelUrlFromState() {
  const st = readJson(TUNNEL_STATE_PATH, null);
  const url = st && st.publicUrl ? String(st.publicUrl).trim() : '';
  return /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(url) ? url : null;
}

function collectSnapshot() {
  const ps = run('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}']);
  const rows = ps.ok ? ps.stdout.split('\n').filter(Boolean) : [];
  const map = new Map();
  for (const row of rows) {
    const idx = row.indexOf('\t');
    if (idx <= 0) continue;
    const name = row.slice(0, idx).trim();
    const status = row.slice(idx + 1).trim();
    map.set(name, status);
  }
  const containers = KNOWN_CONTAINERS.map((name) => ({
    name,
    status: map.get(name) || 'not-running',
  }));
  const snapshot = {
    ok: true,
    updatedAt: new Date().toISOString(),
    dockerOk: ps.ok,
    dockerError: ps.ok ? '' : (ps.stderr || ps.error || 'unknown error'),
    tunnelUrl: getTunnelUrlFromState(),
    containers,
  };
  writeJson(SNAPSHOT_PATH, snapshot);
  return snapshot;
}

function backup(filePath) {
  const stamp = Date.now();
  const bak = `${filePath}.bak.${stamp}`;
  fs.copyFileSync(filePath, bak);
  return bak;
}

function maybeRotateStaleMainSession() {
  if (!fs.existsSync(MAIN_SESSIONS_JSON)) {
    return { rotated: false, reason: 'sessions.json not found' };
  }
  let sessions;
  try {
    sessions = JSON.parse(fs.readFileSync(MAIN_SESSIONS_JSON, 'utf8'));
  } catch (e) {
    return { rotated: false, reason: `parse error: ${e.message}` };
  }
  const current = sessions[MAIN_SESSION_KEY];
  if (!current) {
    return { rotated: false, reason: 'main session key missing' };
  }

  const promptFiles = (((current.systemPromptReport || {}).injectedWorkspaceFiles) || []);
  const injectedAgents = promptFiles.find((f) => String(f.name || '').trim() === 'AGENTS.md');
  const injectedRawChars = injectedAgents && Number.isFinite(Number(injectedAgents.rawChars))
    ? Number(injectedAgents.rawChars)
    : null;
  const agentsPath = path.join(ROOT, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return { rotated: false, reason: 'workspace AGENTS.md not found' };
  }
  const currentRawChars = fs.statSync(agentsPath).size;

  if (injectedRawChars == null || injectedRawChars === currentRawChars) {
    return { rotated: false, reason: 'prompt snapshot up to date' };
  }

  const backups = { sessionsJson: backup(MAIN_SESSIONS_JSON), sessionFile: null };
  const sessionId = String(current.sessionId || '').trim();
  if (sessionId) {
    const sessionFile = path.join(MAIN_SESSIONS_DIR, `${sessionId}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      backups.sessionFile = backup(sessionFile);
    }
  }
  delete sessions[MAIN_SESSION_KEY];
  fs.writeFileSync(MAIN_SESSIONS_JSON, JSON.stringify(sessions, null, 2), 'utf8');
  return {
    rotated: true,
    reason: 'AGENTS.md changed; reset stale long-lived session',
    injectedRawChars,
    currentRawChars,
    backups,
  };
}

function processQueue() {
  const processed = new Set(readJson(PROCESSED_PATH, []));
  const requests = readQueue();
  let handled = 0;

  for (const req of requests) {
    if (!req || !req.id || processed.has(req.id)) continue;
    const action = String(req.action || '').toLowerCase();
    const targets = Array.isArray(req.targets) ? req.targets : [];
    let result;

    if (action === 'restart' && targets.length) {
      const items = targets.map((container) => {
        const r = run('docker', ['restart', container]);
        return {
          container,
          ok: r.ok,
          code: r.code,
          stderr: r.stderr,
          error: r.error,
        };
      });
      result = {
        id: req.id,
        action,
        target: req.target || '',
        createdAt: req.createdAt || null,
        processedAt: new Date().toISOString(),
        ok: items.every((i) => i.ok),
        items,
      };
    } else {
      result = {
        id: req.id,
        action,
        target: req.target || '',
        createdAt: req.createdAt || null,
        processedAt: new Date().toISOString(),
        ok: false,
        error: 'unsupported request',
      };
    }

    appendResult(result);
    processed.add(req.id);
    handled += 1;
  }

  writeJson(PROCESSED_PATH, Array.from(processed));
  return handled;
}

function main() {
  ensureDir();
  const sessionRotate = maybeRotateStaleMainSession();
  const handled = processQueue();
  const snapshot = collectSnapshot();
  const out = {
    ok: true,
    handled,
    sessionRotate,
    snapshotUpdatedAt: snapshot.updatedAt,
    tunnelUrl: snapshot.tunnelUrl,
  };
  console.log(JSON.stringify(out, null, 2));
}

try {
  main();
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
