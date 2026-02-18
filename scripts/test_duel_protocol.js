const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const duelLog = require('./duel_log');
const { runTwoPassDebate } = require('./duel_orchestrator');

function mkTempPaths() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-duel-test-'));
    return {
        root,
        logPath: path.join(root, 'model_duel.jsonl'),
        lockPath: path.join(root, 'model_duel.lock'),
    };
}

function cleanup(root) {
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch {
        // ignore cleanup error
    }
}

function spawnAppend({ modulePath, logPath, lockPath, debateId, index }) {
    return new Promise((resolve, reject) => {
        const code = [
            `const duel = require(${JSON.stringify(modulePath)});`,
            'duel.appendEvent({',
            `  debateId: ${JSON.stringify(debateId)},`,
            "  taskId: 'task-concurrency',",
            "  ackId: 'ack-concurrency',",
            '  round: 1,',
            "  speaker: 'codex',",
            "  type: 'draft',",
            `  content: ${JSON.stringify(`draft-${index}`)},`,
            '  replyToEventId: null,',
            "  status: 'ok',",
            `}, { logPath: ${JSON.stringify(logPath)}, lockPath: ${JSON.stringify(lockPath)} });`,
        ].join('\n');

        const child = spawn('node', ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
        child.on('error', reject);
        child.on('close', (codeValue) => {
            if (codeValue !== 0) {
                reject(new Error(`concurrency child failed: code=${codeValue}, stderr=${stderr}`));
                return;
            }
            resolve();
        });
    });
}

function buildValidCritique(content) {
    return {
        content,
        rubric: {
            correctness: 4,
            feasibility: 4,
            risk: 3,
            clarity: 4,
            testability: 3,
        },
        issues: [
            {
                claim: 'A key failure mode is not covered.',
                evidence: 'No timeout/degraded strategy appears in the draft.',
                suggestedFix: 'Add timeout and degraded fallback handling.',
            },
        ],
    };
}

function buildValidRevision(content, issues, decisions = ['accepted']) {
    return {
        content,
        rubric: {
            correctness: 4,
            feasibility: 4,
            risk: 4,
            clarity: 4,
            testability: 4,
        },
        issues,
        decision: 'partially_accepted',
        responses: issues.map((issue, idx) => ({
            issueRef: idx,
            decision: decisions[idx] || 'accepted',
            rationale: `Handled: ${issue.claim}`,
        })),
    };
}

function testSchemaValidationRejectsMissingField() {
    const paths = mkTempPaths();
    try {
        assert.throws(() => {
            duelLog.appendEvent(
                {
                    debateId: 'debate-schema',
                    taskId: 'task-schema',
                    // ackId intentionally missing
                    round: 0,
                    speaker: 'system',
                    type: 'request',
                    content: 'schema validation test',
                    replyToEventId: null,
                    status: 'ok',
                },
                { logPath: paths.logPath, lockPath: paths.lockPath },
            );
        }, /Invalid duel event/);
    } finally {
        cleanup(paths.root);
    }
}

async function testConcurrentWrites() {
    const paths = mkTempPaths();
    try {
        const modulePath = path.join(process.cwd(), 'scripts', 'duel_log.js');
        const debateId = 'debate-concurrency';
        const workerCount = 18;

        await Promise.all(
            Array.from({ length: workerCount }).map((_, i) => spawnAppend({
                modulePath,
                logPath: paths.logPath,
                lockPath: paths.lockPath,
                debateId,
                index: i,
            })),
        );

        const events = duelLog.readEvents({ logPath: paths.logPath, debateId });
        assert.strictEqual(events.length, workerCount, 'unexpected event count after concurrent writes');
        assert.ok(events.every((event) => typeof event.contentHash === 'string' && event.contentHash.length === 64));

        const rawLines = fs.readFileSync(paths.logPath, 'utf8').split('\n').filter(Boolean);
        assert.strictEqual(rawLines.length, workerCount, 'line count mismatch after concurrent writes');
        rawLines.forEach((line) => JSON.parse(line));
    } finally {
        cleanup(paths.root);
    }
}

async function testLoopLimitOneRound() {
    const paths = mkTempPaths();
    try {
        const result = await runTwoPassDebate({
            taskId: 'task-loop-limit',
            ackId: 'ack-loop-limit',
            command: '요청: loop limit validation',
            maxRounds: 7,
            timeoutMs: 2000,
            logPath: paths.logPath,
            lockPath: paths.lockPath,
            runDraft: async () => ({ content: 'draft for loop limit test' }),
            runCritique: async () => buildValidCritique('critique for loop limit test'),
            runRevision: async (ctx) => buildValidRevision('revision for loop limit test', ctx.critique.issues),
        });

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.maxRoundsUsed, 1);

        const finals = result.events.filter((event) => event.type === 'final');
        assert.strictEqual(finals.length, 1, 'final event should appear exactly once');
        assert.strictEqual(finals[0].status, 'completed');
    } finally {
        cleanup(paths.root);
    }
}

async function testTimeoutDegradedFlow() {
    const paths = mkTempPaths();
    try {
        const result = await runTwoPassDebate({
            taskId: 'task-timeout',
            ackId: 'ack-timeout',
            command: '요청: timeout degraded flow',
            timeoutMs: 40,
            logPath: paths.logPath,
            lockPath: paths.lockPath,
            runDraft: async () => ({ content: 'draft timeout test' }),
            runCritique: async () => {
                await new Promise((resolve) => setTimeout(resolve, 120));
                return buildValidCritique('late critique');
            },
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, 'degraded');
        assert.ok(result.events.some((event) => event.type === 'error'), 'error event should be logged');
        assert.ok(
            result.events.some((event) => event.type === 'final' && event.status === 'degraded'),
            'degraded final event should be logged',
        );
    } finally {
        cleanup(paths.root);
    }
}

async function testQualityMetrics() {
    const paths = mkTempPaths();
    try {
        const critiqueIssues = [
            {
                claim: 'Need stronger validation coverage.',
                evidence: 'No negative case is listed.',
                suggestedFix: 'Add malformed-input tests.',
            },
            {
                claim: 'Rollback criteria are not explicit.',
                evidence: 'No rollback trigger appears.',
                suggestedFix: 'Define rollback trigger and owner.',
            },
        ];

        const result = await runTwoPassDebate({
            taskId: 'task-metrics',
            ackId: 'ack-metrics',
            command: '요청: metrics validation',
            timeoutMs: 2000,
            logPath: paths.logPath,
            lockPath: paths.lockPath,
            runDraft: async () => ({ content: 'draft metrics test' }),
            runCritique: async () => ({
                content: 'critique metrics test',
                rubric: {
                    correctness: 5,
                    feasibility: 4,
                    risk: 3,
                    clarity: 4,
                    testability: 5,
                },
                issues: critiqueIssues,
            }),
            runRevision: async () => buildValidRevision(
                'revision metrics test',
                critiqueIssues,
                ['accepted', 'rejected'],
            ),
        });

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.metrics.critiqueIssueCount, 2);
        assert.strictEqual(result.metrics.revisionResponseCount, 2);
        assert.strictEqual(result.metrics.accepted, 1);
        assert.strictEqual(result.metrics.rejected, 1);
        assert.strictEqual(result.metrics.acceptanceRate, 0.5);
    } finally {
        cleanup(paths.root);
    }
}

function testBridgeRegression() {
    const cmd = '요청: 듀얼모드 메타 검증; 대상: scripts/bridge.js; 완료기준: work route JSON';
    const direct = spawnSync('node', ['scripts/bridge.js', 'work', cmd], {
        encoding: 'utf8',
        cwd: process.cwd(),
    });
    assert.strictEqual(direct.status, 0, `bridge work failed: ${direct.stderr}`);
    const out1 = JSON.parse(String(direct.stdout || '{}').trim());
    assert.strictEqual(out1.route, 'work');
    assert.strictEqual(out1.templateValid, true);
    assert.ok(out1.duelMode && out1.duelMode.enabled === true, 'duelMode metadata missing on work route');
    assert.ok(
        typeof out1.preferredModelAlias === 'string' && out1.preferredModelAlias.trim().length > 0,
        'preferredModelAlias should be present on work route',
    );
    assert.strictEqual(typeof out1.apiLane, 'string', 'apiLane should be present on work route');
    assert.ok(
        typeof out1.apiAuthMode === 'string' && out1.apiAuthMode.trim().length > 0,
        'apiAuthMode should be present on work route',
    );
    assert.strictEqual(typeof out1.apiBlocked, 'boolean', 'apiBlocked should be boolean');

    const auto = spawnSync('node', ['scripts/bridge.js', 'auto', `작업: ${cmd}`], {
        encoding: 'utf8',
        cwd: process.cwd(),
    });
    assert.strictEqual(auto.status, 0, `bridge auto failed: ${auto.stderr}`);
    const out2 = JSON.parse(String(auto.stdout || '{}').trim());
    assert.strictEqual(out2.route, 'work');
    assert.strictEqual(out2.templateValid, true);
    assert.ok(out2.duelMode && out2.duelMode.mode === 'two-pass', 'duelMode metadata missing on auto work route');
    assert.ok(
        typeof out2.preferredModelAlias === 'string' && out2.preferredModelAlias.trim().length > 0,
        'preferredModelAlias should be present on auto work route',
    );
    assert.strictEqual(typeof out2.apiLane, 'string', 'apiLane should be present on auto work route');
    assert.ok(
        typeof out2.apiAuthMode === 'string' && out2.apiAuthMode.trim().length > 0,
        'apiAuthMode should be present on auto work route',
    );
    assert.strictEqual(typeof out2.apiBlocked, 'boolean', 'apiBlocked should be boolean on auto work route');
}

async function run() {
    testSchemaValidationRejectsMissingField();
    await testConcurrentWrites();
    await testLoopLimitOneRound();
    await testTimeoutDegradedFlow();
    await testQualityMetrics();
    testBridgeRegression();

    console.log('test_duel_protocol: ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
