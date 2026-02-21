const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function runBridge(text, env) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', text], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
    assert.strictEqual(res.status, 0, `bridge exit=${res.status}, stderr=${res.stderr || '(empty)'}`);
    const out = JSON.parse(String(res.stdout || '{}').trim());
    return out;
}

function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-record-'));
    const env = { CONVERSATION_DATA_DIR: tmp };
    const out = runBridge('기록: 오늘 테스트 로그 남김', env);
    assert.strictEqual(out.route, 'memo');
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.logged, true);

    const stagingPath = path.join(tmp, 'staging.jsonl');
    assert.ok(fs.existsSync(stagingPath), `staging path missing: ${stagingPath}`);
    const rows = fs.readFileSync(stagingPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(rows.length >= 1, 'expected at least one captured row');
    const last = rows[rows.length - 1];
    assert.strictEqual(last.route, 'memo');
    assert.ok(String(last.message || '').includes('기록: 오늘 테스트 로그 남김'));
    console.log('test_bridge_record_route: ok');
}

main();
