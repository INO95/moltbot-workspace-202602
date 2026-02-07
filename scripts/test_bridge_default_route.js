const assert = require('assert');
const { spawnSync } = require('child_process');

function run() {
  const text = '오늘 저녁 뭐 먹지?';
  const r = spawnSync('node', ['scripts/bridge.js', 'auto', text], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });

  assert.strictEqual(r.status, 0, `bridge exit code=${r.status}, stderr=${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}').trim());

  assert.strictEqual(out.route, 'none', `expected none route, got ${out.route}`);
  assert.ok(typeof out.telegramReply === 'string' && out.telegramReply.includes('프리픽스'), 'missing guidance reply');

  console.log('test_bridge_default_route: ok');
}

run();
