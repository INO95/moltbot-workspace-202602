const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAlertCompact } = require('./ops_alerts_compact');

function writeAlert(root, name, payload) {
  const filePath = path.join(root, 'ops', 'alerts', 'sent', name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-alerts-compact-'));
  try {
    const a = writeAlert(root, 'a.json', {
      alert_id: 'a',
      issue_id: 'bot-dev_bot_down',
      severity: 'P2',
      created_at: '2026-04-01T01:00:00.000Z',
    });
    const b = writeAlert(root, 'b.json', {
      alert_id: 'b',
      issue_id: 'bot-dev_bot_down',
      severity: 'P2',
      created_at: '2026-04-01T02:00:00.000Z',
    });
    const single = writeAlert(root, 'single.json', {
      alert_id: 'c',
      issue_id: 'bot-anki_bot_down',
      severity: 'P3',
      created_at: '2026-04-01T03:00:00.000Z',
    });
    fs.symlinkSync(a, path.join(root, 'ops', 'alerts', 'sent', 'link.json'));

    const dryRun = runAlertCompact({ root, apply: false });
    assert.strictEqual(dryRun.ok, true);
    assert.strictEqual(dryRun.groupCount, 1);
    assert.strictEqual(dryRun.fileCount, 2);
    assert.ok(fs.existsSync(a));
    assert.ok(fs.existsSync(b));
    assert.ok(fs.existsSync(single));
    assert.ok(dryRun.skipped.some((row) => row.reason === 'symlink'));

    const applied = runAlertCompact({ root, apply: true });
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.written.length, 1);
    assert.strictEqual(applied.deleted.length, 2);
    assert.ok(!fs.existsSync(a));
    assert.ok(!fs.existsSync(b));
    assert.ok(fs.existsSync(single));
    assert.ok(fs.existsSync(path.join(root, applied.written[0])));

    console.log('test_ops_alerts_compact: ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
