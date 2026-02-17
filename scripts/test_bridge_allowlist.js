const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runBridge(args, env = {}) {
    const res = spawnSync('node', ['scripts/bridge.js', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });

    assert.strictEqual(res.status, 0, `bridge exit=${res.status}, stderr=${res.stderr || '(empty)'}`);
    const stdout = String(res.stdout || '').trim();
    assert.ok(stdout, `bridge output is empty for args=${JSON.stringify(args)}`);

    try {
        return JSON.parse(stdout);
    } catch (error) {
        throw new Error(`bridge output is not JSON for args=${JSON.stringify(args)}: ${stdout}`);
    }
}

function main() {
    const blockedChecklist = runBridge(['checklist', '안키']);
    assert.strictEqual(blockedChecklist.route, 'blocked');
    assert.strictEqual(blockedChecklist.blocked, true);
    assert.strictEqual(blockedChecklist.errorCode, 'COMMAND_NOT_ALLOWED');

    const blockedAnki = runBridge(['anki', 'decks']);
    assert.strictEqual(blockedAnki.route, 'blocked');
    assert.strictEqual(blockedAnki.blocked, true);
    assert.strictEqual(blockedAnki.errorCode, 'COMMAND_NOT_ALLOWED');

    const allowedWork = runBridge(['work', '요청: x; 대상: y; 완료기준: z']);
    assert.strictEqual(allowedWork.route, 'work');
    assert.strictEqual(allowedWork.templateValid, true);

    const allowedProject = runBridge(['project', '프로젝트명: demo; 목표: 테스트; 스택: next.js; 경로: /tmp; 완료기준: 실행']);
    assert.strictEqual(allowedProject.route, 'project');
    assert.strictEqual(allowedProject.templateValid, true);

    const allowedLink = runBridge(['auto', '링크: 프롬프트']);
    assert.strictEqual(allowedLink.route, 'link');

    const allowedFinance = runBridge(['auto', '가계: 점심 1200엔']);
    assert.strictEqual(allowedFinance.route, 'finance');

    const blockedAutoRoute = runBridge(
        ['auto', '작업: 요청: x; 대상: y; 완료기준: z'],
        { BRIDGE_ALLOWLIST_AUTO_ROUTES: 'link,status' },
    );
    assert.strictEqual(blockedAutoRoute.route, 'blocked');
    assert.strictEqual(blockedAutoRoute.requestedRoute, 'work');

    const noPrefixGuide = runBridge(['auto', '오늘 뭐 먹지']);
    assert.strictEqual(noPrefixGuide.route, 'none');
    assert.ok(String(noPrefixGuide.telegramReply || '').includes('명령 프리픽스를 붙여주세요.'));

    console.log('test_bridge_allowlist: ok');
}

main();
