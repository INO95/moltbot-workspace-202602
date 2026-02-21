const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonLines(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

async function waitForCritiqueTask(inboxLogPath, timeoutMs = 7000, pollMs = 40) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        const lines = readJsonLines(inboxLogPath);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const row = lines[i] || {};
            const taskId = String(row.taskId || '');
            const command = String(row.command || '');
            if (taskId.startsWith('bridge-critique-') && command.includes('[DUEL_CRITIQUE_REQUEST:v1]')) {
                return row;
            }
        }
        await sleep(pollMs);
    }
    throw new Error(`Timed out waiting for bridge-critique task in ${inboxLogPath}`);
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duel-live-harness-'));
    const bridgeDir = path.join(root, 'bridge');
    const duelLogPath = path.join(bridgeDir, 'model_duel.jsonl');
    const duelLockPath = path.join(root, 'model_duel.lock');
    const inboxLogPath = path.join(bridgeDir, 'inbox.jsonl');
    const outboxPath = path.join(bridgeDir, 'outbox.json');

    fs.mkdirSync(bridgeDir, { recursive: true });

    process.env.BRIDGE_DIR = bridgeDir;
    process.env.DUEL_LOG_PATH = duelLogPath;
    process.env.DUEL_LOCK_PATH = duelLockPath;

    const { sendCommand } = require('./ag_bridge_client');
    const { readEvents } = require('./duel_log');

    const structuredCritique = {
        content: '구조화 비평: 롤백 조건과 실패 시나리오 명시가 부족합니다.',
        rubric: {
            correctness: 4,
            feasibility: 4,
            risk: 3,
            clarity: 4,
            testability: 5,
        },
        issues: [
            {
                claim: '롤백 트리거 기준이 없습니다.',
                evidence: '초안에 롤백 조건/담당자/실행시점이 없습니다.',
                suggestedFix: '롤백 트리거, 담당자, 실행 윈도우를 명시하세요.',
            },
            {
                claim: '부정 케이스 테스트가 누락되었습니다.',
                evidence: '정상 흐름만 있고 malformed/timeout 검증이 없습니다.',
                suggestedFix: 'malformed payload, timeout, partial failure 테스트를 추가하세요.',
            },
        ],
    };

    const critiqueWriter = (async () => {
        const critiqueTask = await waitForCritiqueTask(inboxLogPath, 8000, 40);
        fs.writeFileSync(
            outboxPath,
            JSON.stringify(
                {
                    taskId: critiqueTask.taskId,
                    result: JSON.stringify(structuredCritique),
                    actions: ['structured critique injected by live harness'],
                    timestamp: new Date().toISOString(),
                },
                null,
                2,
            ),
            'utf8',
        );
        return critiqueTask.taskId;
    })();

    try {
        let response;
        try {
            response = await sendCommand('요청: 듀얼 라이브 하네스 검증; 대상: ag_bridge_client; 완료기준: 구조화 비평 파싱', {
                duelMode: true,
                timeoutMs: 12000,
                outboxTimeoutMs: 7000,
                requireStructuredCritique: true,
                runDraft: async () => ({
                    content: '테스트용 codex draft: 실패 처리/롤백 기준을 보완해야 합니다.',
                }),
            });
        } finally {
            const injectedTaskId = await critiqueWriter;
            assert.ok(String(injectedTaskId).startsWith('bridge-critique-'));
        }

        assert.ok(response && response.duel && response.duel.enabled, 'duel response missing');
        assert.strictEqual(response.duel.critique.structured, true, 'structured critique should be true');
        assert.strictEqual(response.duel.critique.source, 'antigravity-structured-request');
        assert.ok(String(response.duel.critique.critiqueTaskId || '').startsWith('bridge-critique-'));
        assert.strictEqual(response.duel.status, 'completed');

        const events = readEvents({ logPath: duelLogPath, debateId: response.duel.debateId });
        const critiqueEvent = events.find((event) => event.type === 'critique');
        assert.ok(critiqueEvent, 'critique event missing in duel log');
        assert.strictEqual(Array.isArray(critiqueEvent.issues), true);
        assert.strictEqual(critiqueEvent.issues.length, 2);
        assert.strictEqual(critiqueEvent.rubric.testability, 5);

        console.log('test_ag_bridge_duel_live_harness: ok');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
