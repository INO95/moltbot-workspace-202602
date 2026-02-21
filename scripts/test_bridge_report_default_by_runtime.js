const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runAuto(message, env = {}) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 90000,
        env: {
            ...process.env,
            BRIDGE_ALLOWLIST_ENABLED: 'true',
            BRIDGE_ALLOWLIST_DIRECT_COMMANDS: 'auto',
            BRIDGE_ALLOWLIST_AUTO_ROUTES: 'word,memo,news,report,work,inspect,deploy,project,prompt,link,status,ops',
            ...env,
        },
    });
    assert.strictEqual(res.status, 0, `bridge failed: ${res.stderr || res.stdout}`);
    const raw = String(res.stdout || '').trim();
    assert.ok(raw, 'bridge output empty');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
            return JSON.parse(lines[i]);
        } catch (_) {
            // Continue scanning until the last JSON line.
        }
    }
    throw new Error(`bridge output missing json: ${raw}`);
}

function main() {
    const researchOut = runAuto('리포트: 보내줘', {
        MOLTBOT_BOT_ID: 'bot-research',
        MOLTBOT_BOT_ROLE: 'worker',
    });
    assert.strictEqual(researchOut.route, 'report');
    assert.strictEqual(researchOut.routeHint, 'report-tech-trend');
    assert.ok(!String(researchOut.telegramReply || '').includes('알 수 없는 소식 명령'));
    assert.strictEqual(researchOut.preferredModelAlias, 'gpt');
    assert.strictEqual(researchOut.activeModelStage, 'write');

    const devOut = runAuto('리포트: 보내줘', {
        MOLTBOT_BOT_ID: 'bot-dev',
        MOLTBOT_BOT_ROLE: 'worker',
    });
    assert.strictEqual(devOut.route, 'report');
    assert.strictEqual(devOut.routeHint, 'report-daily');
    assert.ok(!String(devOut.telegramReply || '').includes('알 수 없는 소식 명령'));

    console.log('test_bridge_report_default_by_runtime: ok');
}

main();
