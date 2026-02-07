#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SESSIONS_DIR = path.join(ROOT, 'configs', 'main', 'agents', 'main', 'sessions');
const SESSIONS_JSON = path.join(SESSIONS_DIR, 'sessions.json');
const KEY = 'agent:main:main';

function backupFile(filePath) {
  const stamp = Date.now();
  const bak = `${filePath}.bak.${stamp}`;
  fs.copyFileSync(filePath, bak);
  return bak;
}

function main() {
  if (!fs.existsSync(SESSIONS_JSON)) {
    console.error('sessions.json not found');
    process.exit(1);
  }

  const raw = fs.readFileSync(SESSIONS_JSON, 'utf8');
  const json = JSON.parse(raw);
  const current = json[KEY];
  if (!current) {
    console.log(JSON.stringify({ ok: true, changed: false, reason: 'session key not found' }, null, 2));
    return;
  }

  const sessionId = String(current.sessionId || '').trim();
  const sessionFile = sessionId ? path.join(SESSIONS_DIR, `${sessionId}.jsonl`) : null;

  const bakJson = backupFile(SESSIONS_JSON);
  let bakSession = null;
  if (sessionFile && fs.existsSync(sessionFile)) {
    bakSession = backupFile(sessionFile);
  }

  delete json[KEY];
  fs.writeFileSync(SESSIONS_JSON, JSON.stringify(json, null, 2), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    changed: true,
    removedKey: KEY,
    removedSessionId: sessionId || null,
    backups: {
      sessionsJson: bakJson,
      sessionFile: bakSession,
    },
  }, null, 2));
}

try {
  main();
} catch (e) {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
}
