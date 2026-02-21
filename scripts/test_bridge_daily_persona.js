const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const finalizer = require('./finalizer');

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
  const raw = String(res.stdout || '').trim();
  assert.ok(raw, 'bridge output empty');
  return JSON.parse(raw);
}

function main() {
  assert.strictEqual(finalizer.resolvePersonaForRuntime({ botId: 'bot-dev' }), 'zeke');
  assert.strictEqual(finalizer.resolvePersonaForRuntime({ botId: 'bot-dev-bak' }), 'zeke');
  assert.strictEqual(finalizer.resolvePersonaForRuntime({ botId: 'bot-anki' }), 'hange');
  assert.strictEqual(finalizer.resolvePersonaForRuntime({ botId: 'bot-research' }), 'armin');
  assert.strictEqual(finalizer.resolvePersonaForRuntime({ botId: 'bot-daily' }), 'erwin');

  const blockedSwitch = runAuto('페르소나: 에일리');
  assert.strictEqual(blockedSwitch.route, 'none');
  assert.ok(String(blockedSwitch.telegramReply || '').includes('전환할 수 없습니다'));
  assert.ok(!String(blockedSwitch.telegramReply || '').includes('에일리'));
  assert.ok(!String(blockedSwitch.telegramReply || '').includes('베일리'));
  assert.ok(!String(blockedSwitch.telegramReply || '').includes('문학소녀'));
  assert.ok(!String(blockedSwitch.telegramReply || '').includes('T_Ray'));

  const blockedList = runAuto('다른 페르소나 뭐 있어?');
  assert.strictEqual(blockedList.route, 'none');
  assert.ok(String(blockedList.telegramReply || '').includes('봇별로 고정'));

  const noPrefix = runAuto('안녕');
  assert.strictEqual(noPrefix.route, 'none');
  assert.ok(String(noPrefix.telegramReply || '').includes('명령 프리픽스를 붙여주세요'));

  console.log('test_bridge_daily_persona: ok');
}

main();
