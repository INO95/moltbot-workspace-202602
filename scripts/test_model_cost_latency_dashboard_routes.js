const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseBridgeRouteCounts } = require('./model_cost_latency_dashboard');

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-dashboard-'));
  const bridgeLogPath = path.join(tempDir, 'inbox.jsonl');
  const rows = [
    {
      source: 'user',
      route: 'other',
      command: '[Telegram Test User id:1 +0m 2026-03-07 10:00 UTC] 작업: 요청: A; 대상: B; 완료기준: C [message_id: 11]',
    },
    {
      source: 'user',
      route: 'other',
      command: '[Telegram Test User id:1 +0m 2026-03-07 10:01 UTC] 단어: apple [Replying to Bot id:12] old text [/Replying] [message_id: 12]',
    },
  ];
  fs.writeFileSync(bridgeLogPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const result = parseBridgeRouteCounts({
    bridgeLogPath,
    config: {
      commandPrefixes: {},
      naturalLanguageRouting: {},
      budgetPolicy: {},
    },
    env: {},
  });

  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.counts.work, 1);
  assert.strictEqual(result.counts.word, 1);
  assert.strictEqual(result.counts.other, 0);
  assert.strictEqual(result.byRoute.work, 1);
  assert.strictEqual(result.byRoute.word, 1);

  console.log('test_model_cost_latency_dashboard_routes: ok');
}

main();
