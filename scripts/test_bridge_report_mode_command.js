const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function runAuto(message, env = {}) {
  const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      MOLTBOT_BOT_ROLE: 'supervisor',
      MOLTBOT_BOT_ID: 'bot-daily',
      BRIDGE_ALLOWLIST_ENABLED: 'true',
      BRIDGE_ALLOWLIST_DIRECT_COMMANDS: 'auto',
      BRIDGE_ALLOWLIST_AUTO_ROUTES: 'word,memo,news,report,work,inspect,deploy,project,prompt,link,status,ops,finance,todo,routine,workout,media,place,none',
      TELEGRAM_FINALIZER_ECHO_ONLY: 'true',
      ...env,
    },
  });
  assert.strictEqual(res.status, 0, `bridge failed: ${res.stderr || res.stdout}`);
  return JSON.parse(String(res.stdout || '{}').trim());
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-mode-test-'));
  const prefsPath = path.join(tempDir, 'user_prefs.json');

  try {
    const envelope = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-18 00:00 UTC]';

    const outKo = runAuto(`${envelope} /report ko [message_id: 101]`, {
      TELEGRAM_FINALIZER_PREFS_PATH: prefsPath,
    });
    assert.strictEqual(outKo.route, 'report');
    assert.ok(String(outKo.telegramReply || '').includes('REPORT_MODE=ko'));
    const prefsKo = readJson(prefsPath);
    assert.strictEqual(prefsKo.users['telegram:7704103236'].reportMode, 'ko');

    const outKoEn = runAuto(`${envelope} /report ko+en [message_id: 102]`, {
      TELEGRAM_FINALIZER_PREFS_PATH: prefsPath,
    });
    assert.strictEqual(outKoEn.route, 'report');
    assert.ok(String(outKoEn.telegramReply || '').includes('REPORT_MODE=ko+en'));
    const prefsKoEn = readJson(prefsPath);
    assert.strictEqual(prefsKoEn.users['telegram:7704103236'].reportMode, 'ko+en');

    const outInvalid = runAuto(`${envelope} /report en [message_id: 103]`, {
      TELEGRAM_FINALIZER_PREFS_PATH: prefsPath,
    });
    assert.strictEqual(outInvalid.route, 'report');
    assert.ok(String(outInvalid.telegramReply || '').includes('지원하지 않는 REPORT_MODE'));

    console.log('test_bridge_report_mode_command: ok');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
