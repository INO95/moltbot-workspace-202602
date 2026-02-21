const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

function main() {
    const root = path.join(__dirname, '..');
    const res = spawnSync('node', ['scripts/bridge.js', 'news', '상태'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000,
    });

    assert.strictEqual(res.status, 0, `bridge command failed: ${res.stderr || res.stdout}`);
    const out = String(res.stdout || '').trim();
    assert.ok(out, 'bridge output should not be empty');

    let parsed;
    try {
        parsed = JSON.parse(out);
    } catch (error) {
        throw new Error(`bridge output is not json: ${out}`);
    }

    assert.strictEqual(parsed.route, 'news');
    assert.strictEqual(parsed.preferredModelAlias, 'fast');
    assert.strictEqual(parsed.apiLane, 'local-only');
    assert.strictEqual(parsed.apiAuthMode, 'none');
    assert.strictEqual(parsed.apiBlocked, false);
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'success'));
    assert.ok(parsed.telegramReply, 'telegramReply should be provided');

    console.log(JSON.stringify({ ok: true, success: parsed.success }));
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
