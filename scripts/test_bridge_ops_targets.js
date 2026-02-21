const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runTarget(target) {
    const res = spawnSync('node', ['scripts/bridge.js', 'ops', `액션: 상태; 대상: ${target}`], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, BRIDGE_ALLOWLIST_ENABLED: 'false' },
    });

    assert.strictEqual(res.status, 0, `bridge failed: ${res.stderr || res.stdout}`);
    const out = JSON.parse(String(res.stdout || '{}').trim());
    assert.strictEqual(out.route, 'ops');
    assert.strictEqual(out.templateValid, true);
    assert.ok(!String(out.telegramReply || '').includes('지원하지 않는 대상'));
    assert.ok(String(out.telegramReply || '').includes('요약:'), 'status reply should include summary');
}

function main() {
    runTarget('research');
    runTarget('daily');
    runTarget('research_bak');
    console.log('test_bridge_ops_targets: ok');
}

main();
