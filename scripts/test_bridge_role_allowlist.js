const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runAuto(text, env = {}) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', text], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
    assert.strictEqual(res.status, 0, `bridge failed: ${res.stderr || res.stdout}`);
    return JSON.parse(String(res.stdout || '{}').trim());
}

function main() {
    const devEnv = {
        BRIDGE_ALLOWLIST_ENABLED: 'true',
        BRIDGE_ALLOWLIST_DIRECT_COMMANDS: 'auto',
        BRIDGE_ALLOWLIST_AUTO_ROUTES: 'work,inspect,deploy,project,ops,status,link',
        BRIDGE_BLOCK_HINT: 'dev-only',
    };

    const devAllowed = runAuto('링크: 프롬프트', devEnv);
    assert.strictEqual(devAllowed.route, 'link');

    const devBlocked = runAuto('단어: activate 활성화하다', devEnv);
    assert.strictEqual(devBlocked.route, 'blocked');
    assert.strictEqual(devBlocked.requestedRoute, 'word');
    assert.ok(String(devBlocked.telegramReply || '').includes('dev-only'));

    const devProject = runAuto('프로젝트: 프로젝트명: demo; 목표: 테스트; 스택: next.js; 경로: /tmp; 완료기준: 실행', devEnv);
    assert.strictEqual(devProject.route, 'project');
    assert.strictEqual(devProject.templateValid, true);

    const researchEnv = {
        BRIDGE_ALLOWLIST_ENABLED: 'true',
        BRIDGE_ALLOWLIST_DIRECT_COMMANDS: 'auto',
        BRIDGE_ALLOWLIST_AUTO_ROUTES: 'news,report,prompt',
    };

    const researchAllowed = runAuto('프롬프트: 목적: 테스트', researchEnv);
    assert.strictEqual(researchAllowed.route, 'prompt');

    const researchBlocked = runAuto('작업: 요청: x; 대상: y; 완료기준: z', researchEnv);
    assert.strictEqual(researchBlocked.route, 'blocked');
    assert.strictEqual(researchBlocked.requestedRoute, 'work');

    const researchProjectBlocked = runAuto('프로젝트: 프로젝트명: demo; 목표: 테스트; 스택: next.js; 경로: /tmp; 완료기준: 실행', researchEnv);
    assert.strictEqual(researchProjectBlocked.route, 'blocked');
    assert.strictEqual(researchProjectBlocked.requestedRoute, 'project');

    const dailyEnv = {
        BRIDGE_ALLOWLIST_ENABLED: 'true',
        BRIDGE_ALLOWLIST_DIRECT_COMMANDS: 'auto',
        BRIDGE_ALLOWLIST_AUTO_ROUTES: '__none__',
    };

    const dailyBlocked = runAuto('배포: 대상: a; 환경: b; 검증: c', dailyEnv);
    assert.strictEqual(dailyBlocked.route, 'blocked');
    assert.strictEqual(dailyBlocked.requestedRoute, 'deploy');

    const dailyNoPrefix = runAuto('오늘 저녁 뭐 먹지?', dailyEnv);
    assert.strictEqual(dailyNoPrefix.route, 'none');

    console.log('test_bridge_role_allowlist: ok');
}

main();
