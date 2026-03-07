const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotateMainSessionIfNeeded } = require('./lib/main_session_rotation');

function seedPromptFiles(root) {
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'a'.repeat(100), 'utf8');
  fs.writeFileSync(path.join(root, 'IDENTITY.md'), 'b'.repeat(50), 'utf8');
  fs.writeFileSync(path.join(root, 'HEARTBEAT.md'), 'c'.repeat(40), 'utf8');
  fs.writeFileSync(path.join(root, 'TOOLS.md'), 'd'.repeat(30), 'utf8');
}

function createSessionHarness(current) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-rotate-root-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-rotate-state-'));
  const sessionsDir = path.join(stateDir, 'agents', 'main', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  seedPromptFiles(root);
  const sessionsJson = path.join(sessionsDir, 'sessions.json');
  const sessionId = String(current.sessionId || 'main-test');
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), '{}\n', 'utf8');
  fs.writeFileSync(sessionsJson, JSON.stringify({
    'agent:main:main': {
      sessionId,
      ...current,
    },
  }, null, 2), 'utf8');
  return { root, stateDir, sessionsDir, sessionsJson };
}

function runRotation(current, nowMs) {
  const harness = createSessionHarness(current);
  const result = rotateMainSessionIfNeeded({
    root: harness.root,
    env: { OPENCLAW_STATE_DIR: harness.stateDir },
    nowMs,
  });
  return { harness, result };
}

function main() {
  const ceiling = runRotation({
    sessionId: 'ceiling',
    totalTokens: 60000,
    updatedAt: new Date('2026-03-07T00:00:00Z').toISOString(),
  }, Date.parse('2026-03-07T12:00:00Z'));
  assert.strictEqual(ceiling.result.rotated, true);
  assert.ok(String(ceiling.result.reason).includes('token ceiling'));
  assert.ok(fs.existsSync(ceiling.result.backups.sessionsJson));
  assert.ok(fs.existsSync(ceiling.result.backups.sessionFile));

  const stale = runRotation({
    sessionId: 'stale',
    totalTokens: 30000,
    updatedAt: new Date('2026-03-05T00:00:00Z').toISOString(),
  }, Date.parse('2026-03-07T12:00:00Z'));
  assert.strictEqual(stale.result.rotated, true);
  assert.ok(String(stale.result.reason).includes('stale'));

  const promptMismatch = runRotation({
    sessionId: 'mismatch',
    totalTokens: 1200,
    updatedAt: new Date('2026-03-07T08:00:00Z').toISOString(),
    systemPromptReport: {
      injectedWorkspaceFiles: [
        { name: 'AGENTS.md', rawChars: 10 },
        { name: 'IDENTITY.md', rawChars: 50 },
        { name: 'HEARTBEAT.md', rawChars: 40 },
        { name: 'TOOLS.md', rawChars: 30 },
      ],
    },
  }, Date.parse('2026-03-07T12:00:00Z'));
  assert.strictEqual(promptMismatch.result.rotated, true);
  assert.ok(String(promptMismatch.result.reason).includes('prompt snapshot mismatch'));

  console.log('test_ops_session_rotation: ok');
}

main();
