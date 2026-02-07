const assert = require('assert');
const { parseHealthBridgePayload } = require('./health_bridge_payload');

function run() {
  const a = parseHealthBridgePayload([
    '어깨',
    '2026.02.08',
    '20 sets',
    '405 reps',
    'image_path: /tmp/shoulder.png',
  ].join('\n'));
  assert.strictEqual(a.mode, 'text');
  assert.strictEqual(a.imagePath, '/tmp/shoulder.png');
  assert.ok(a.text.includes('어깨'));
  assert.ok(!a.text.includes('image_path:'));

  const b = parseHealthBridgePayload([
    'Indoor Run 2026-02-08 Distance 5.5km 40min 300kcal',
    '![run](/tmp/run.jpg)',
  ].join('\n'));
  assert.strictEqual(b.mode, 'text');
  assert.strictEqual(b.imagePath, '/tmp/run.jpg');
  assert.ok(b.text.includes('Indoor Run'));

  const c = parseHealthBridgePayload(
    '{"date":"2026-02-08","sportType":"running","distanceKm":5.5,"imagePath":"/tmp/running.png"}',
  );
  assert.strictEqual(c.mode, 'structured');
  assert.strictEqual(c.imagePath, '/tmp/running.png');
  assert.strictEqual(c.structured.sportType, 'running');

  const d = parseHealthBridgePayload(
    '{"text":"Indoor Run 2026-02-08 Distance 5.5km 40min 300kcal","imagePath":"/tmp/t.png"}',
  );
  assert.strictEqual(d.mode, 'text');
  assert.strictEqual(d.imagePath, '/tmp/t.png');
  assert.ok(d.text.includes('Indoor Run'));

  const e = parseHealthBridgePayload('Indoor Run 2026-02-08 5.5km\\nimage_path: /tmp/literal.png');
  assert.strictEqual(e.mode, 'text');
  assert.strictEqual(e.imagePath, '/tmp/literal.png');
  assert.ok(!e.text.includes('image_path:'));

  const f = parseHealthBridgePayload(JSON.stringify({
    text: 'Indoor Run 2026-02-08 Distance 6.0km 44min 350kcal',
    attachments: [{ type: 'image', path: '/tmp/att_a.png' }],
  }));
  assert.strictEqual(f.mode, 'text');
  assert.strictEqual(f.imagePath, '/tmp/att_a.png');
  assert.ok(f.text.includes('Indoor Run'));

  const g = parseHealthBridgePayload(JSON.stringify({
    caption: '어깨 2026.02.08 20 sets 400 reps 5200kg',
    photo: { localPath: '/tmp/photo_local.jpg' },
  }));
  assert.strictEqual(g.mode, 'text');
  assert.strictEqual(g.imagePath, '/tmp/photo_local.jpg');
  assert.ok(g.text.includes('어깨'));

  console.log('test_health_bridge_payload: ok');
}

run();
