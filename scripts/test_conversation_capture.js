const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { redactSensitiveText } = require('./conversation_capture');

const ROOT = path.join(__dirname, '..');

function runBridge(text, env = {}) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', text], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
    assert.strictEqual(res.status, 0, `bridge exit=${res.status}, stderr=${res.stderr || '(empty)'}`);
    const stdout = String(res.stdout || '').trim();
    assert.ok(stdout, 'bridge output should not be empty');
    return JSON.parse(stdout);
}

function testRedaction() {
    const redacted = redactSensitiveText('token sk-1234567890abcdefghijklmnop and 123456:ABCdefGhijk_lmnopQRSTuv');
    assert.ok(redacted.includes('[REDACTED_OPENAI_KEY]'));
    assert.ok(redacted.includes('[REDACTED_TELEGRAM_TOKEN]'));
}

function testCaptureAllRoutes() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-capture-'));
    const env = { CONVERSATION_DATA_DIR: tmp };

    runBridge('기록: 회의 요약', env); // memo
    runBridge('작업: 요청: A; 대상: B; 완료기준: C', env); // work
    runBridge('점검: 대상: B; 체크항목: smoke', env); // inspect
    runBridge('배포: 대상: api; 환경: prod; 검증: health', env); // deploy
    runBridge('오늘 저녁 뭐 먹지?', env); // none

    const stagingPath = path.join(tmp, 'staging.jsonl');
    assert.ok(fs.existsSync(stagingPath), 'staging file should exist');
    const rows = fs.readFileSync(stagingPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const routes = new Set(rows.map((r) => String(r.route || '')));
    assert.ok(routes.has('memo'), 'memo route must be captured');
    assert.ok(routes.has('work'), 'work route must be captured');
    assert.ok(routes.has('inspect'), 'inspect route must be captured');
    assert.ok(routes.has('deploy'), 'deploy route must be captured');
    assert.ok(routes.has('none'), 'none route must be captured');
}

function main() {
    testRedaction();
    testCaptureAllRoutes();
    console.log('test_conversation_capture: ok');
}

main();
