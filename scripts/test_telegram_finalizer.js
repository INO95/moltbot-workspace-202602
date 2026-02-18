const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const finalizer = require('./finalizer');

function main() {
  const originalEcho = process.env.TELEGRAM_FINALIZER_ECHO_ONLY;
  const originalEnabled = process.env.TELEGRAM_FINALIZER_ENABLED;
  const originalPrefsPath = process.env.TELEGRAM_FINALIZER_PREFS_PATH;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalizer-test-'));
  const prefsPath = path.join(tempDir, 'user_prefs.json');
  process.env.TELEGRAM_FINALIZER_PREFS_PATH = prefsPath;
  process.env.TELEGRAM_FINALIZER_ENABLED = 'true';
  process.env.TELEGRAM_FINALIZER_ECHO_ONLY = 'false';

  try {
    assert.strictEqual(finalizer.isHeartbeatBypass('HEARTBEAT_OK'), true);
    assert.strictEqual(finalizer.isHeartbeatBypass('HEARTBEAT_WARN'), true);
    assert.strictEqual(finalizer.finalizeTelegramReply('HEARTBEAT_OK', {}), 'HEARTBEAT_OK');

    const sample = [
      '결과 정리',
      '/approve 123',
      '코드 블록:',
      '```json',
      '{"a":1}',
      '```',
      'inline `const a = 1;` 포함',
      'URL: https://example.com/a?b=1',
      'PATH: /Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js',
      'UUID: 123e4567-e89b-12d3-a456-426614174000',
      'TS: 2026-02-18T11:22:33Z',
      'HASH: a3f5e8a3f5e8a3f5e8a3f5e8a3f5e8a3',
    ].join('\n');

    const masked = finalizer.maskProtectedSegments(sample);
    const restored = finalizer.restoreProtectedSegments(masked.maskedText, masked.state);
    assert.strictEqual(restored, sample);

    finalizer.__setModelCallerForTest((params) => {
      return ['요약', String(params.draft || '')].join('\n');
    });

    const finalized = finalizer.finalizeTelegramReply(sample, {
      botId: 'bot-dev',
      botRole: 'worker',
      telegramContext: { provider: 'telegram', userId: '7704103236', groupId: '' },
      requestedBy: 'telegram:7704103236',
    });

    assert.ok(finalized.includes('/approve 123'));
    assert.ok(finalized.includes('```json\n{"a":1}\n```'));
    assert.ok(finalized.includes('`const a = 1;`'));
    assert.ok(finalized.includes('https://example.com/a?b=1'));
    assert.ok(finalized.includes('/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js'));
    assert.ok(finalized.includes('123e4567-e89b-12d3-a456-426614174000'));
    assert.ok(finalized.includes('2026-02-18T11:22:33Z'));

    const setKo = finalizer.writeReportMode({
      mode: 'ko',
      telegramContext: { provider: 'telegram', userId: '7704103236', groupId: '' },
      requestedBy: 'telegram:7704103236',
    });
    assert.strictEqual(setKo.ok, true);
    assert.strictEqual(finalizer.readReportMode({
      telegramContext: { provider: 'telegram', userId: '7704103236', groupId: '' },
      requestedBy: 'telegram:7704103236',
    }), 'ko');

    console.log('test_telegram_finalizer: ok');
  } finally {
    finalizer.__setModelCallerForTest(null);
    process.env.TELEGRAM_FINALIZER_ECHO_ONLY = originalEcho;
    process.env.TELEGRAM_FINALIZER_ENABLED = originalEnabled;
    process.env.TELEGRAM_FINALIZER_PREFS_PATH = originalPrefsPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
