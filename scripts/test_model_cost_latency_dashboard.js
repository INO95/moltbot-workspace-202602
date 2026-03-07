const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('./personal_storage');
const {
    parseBridgeRouteCounts,
    summarizeWordMetrics,
    markdownReport,
} = require('./model_cost_latency_dashboard');

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeJsonl(filePath, rows) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const body = rows.map((row) => JSON.stringify(row)).join('\n');
    fs.writeFileSync(filePath, `${body}\n`, 'utf8');
}

function seedWordMetrics(dbPath) {
    storage.ensureStorage({ dbPath });
    storage.recordVocabLog({
        eventId: 'evt-1',
        word: 'activate',
        deck: 'TOEIC_AI',
        noteId: 101,
        saveStatus: 'saved',
        meta: { duplicate: false, correctedWord: '' },
    }, { dbPath });
    storage.recordVocabLog({
        eventId: 'evt-2',
        word: 'budget',
        deck: 'TOEIC_AI',
        noteId: 102,
        saveStatus: 'saved',
        meta: { duplicate: true, correctedWord: '' },
    }, { dbPath });
    storage.recordVocabLog({
        eventId: 'evt-3',
        word: 'fragle',
        deck: 'TOEIC_AI',
        saveStatus: 'failed',
        errorText: 'parse_failed',
        meta: {},
    }, { dbPath });
    storage.recordVocabLog({
        eventId: 'evt-4',
        word: 'fragile',
        deck: 'TOEIC_AI',
        noteId: 103,
        saveStatus: 'saved',
        meta: { duplicate: false, correctedWord: 'fragile' },
    }, { dbPath });
}

function buildConfigFixture() {
    return {
        commandPrefixes: {
            word: '단어:',
            learn: '학습:',
            memo: '메모:',
            record: '기록:',
            news: '소식:',
            report: '리포트:',
            summary: '요약:',
            work: '작업:',
            do: '실행:',
            inspect: '점검:',
            check: '검토:',
            deploy: '배포:',
            ship: '출시:',
            project: '프로젝트:',
            prompt: '프롬프트:',
            ask: '질문:',
            link: '링크:',
            status: '상태:',
            ops: '운영:',
            finance: '가계:',
            ledger: '가계부:',
            todo: '투두:',
            task: '할일:',
            routine: '루틴:',
            workout: '운동:',
            media: '콘텐츠:',
            place: '식당:',
            restaurant: '맛집:',
        },
        naturalLanguageRouting: {
            enabled: true,
            hubOnly: false,
            inferMemo: true,
            inferFinance: true,
            inferTodo: true,
            inferRoutine: true,
            inferWorkout: true,
            inferBrowser: true,
            inferStatus: true,
            inferLink: true,
            inferWork: true,
            inferInspect: true,
            inferReport: true,
            inferProject: true,
        },
        budgetPolicy: {
            monthlyApiBudgetYen: 0,
            paidApiRequiresApproval: false,
        },
    };
}

function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-dashboard-'));
    try {
        const bridgeLogPath = path.join(tmpRoot, 'data', 'bridge', 'inbox.jsonl');
        const configPath = path.join(tmpRoot, 'data', 'config.json');
        const dbPath = path.join(tmpRoot, 'data', 'personal', 'personal.sqlite');

        writeJson(configPath, buildConfigFixture());
        writeJsonl(bridgeLogPath, [
            { command: '기록: 오늘 테스트 로그 남김', source: 'user' },
            { command: '브릿지 라우터 리팩터링해줘', source: 'user' },
            { command: '오늘 할 일에 장보기 추가해줘', source: 'user' },
            { command: '요즘 테크 트렌드 리포트 한번 줘', source: 'user' },
            { command: '구글 캘린더 확인', source: 'user' },
            { command: '그냥 잡담', source: 'user' },
            { command: 'support: manual row only', route: 'anki', source: 'user' },
            { command: '', route: 'work', source: 'user' },
            { command: '[NOTIFY] ops briefing', route: 'report', source: 'ops-daily-supervisor' },
            { command: '[CRON FAIL] nightly_autopilot', source: 'cron-guard' },
        ]);
        seedWordMetrics(dbPath);

        const routes = parseBridgeRouteCounts({
            bridgeLogPath,
            configPath,
            env: {
                ...process.env,
                MOLTBOT_BOT_ROLE: 'supervisor',
                MOLTBOT_BOT_ID: 'bot-daily',
                PERSONAL_DB_PATH: dbPath,
            },
        });
        assert.deepStrictEqual(Object.keys(routes.counts), [
            'word',
            'memo',
            'finance',
            'todo',
            'routine',
            'workout',
            'media',
            'place',
            'news',
            'report',
            'work',
            'inspect',
            'deploy',
            'project',
            'prompt',
            'link',
            'status',
            'ops',
            'anki',
            'none',
            'other',
        ]);
        assert.strictEqual(routes.counts.memo, 1);
        assert.strictEqual(routes.counts.work, 1);
        assert.strictEqual(routes.counts.todo, 1);
        assert.strictEqual(routes.counts.report, 1);
        assert.strictEqual(routes.counts.ops, 1);
        assert.strictEqual(routes.counts.anki, 1);
        assert.strictEqual(routes.counts.none, 1);
        assert.strictEqual(routes.counts.other, 1);
        assert.strictEqual(routes.total, 8);
        assert.strictEqual(routes.system.total, 2);
        assert.strictEqual(routes.system.cronFail, 1);
        assert.strictEqual(routes.system.otherSystem, 1);
        assert.strictEqual(routes.apiLanes.total, 7);
        assert.strictEqual(routes.apiLanes.byLane['oauth-codex'], 2);
        assert.strictEqual(routes.apiLanes.byLane['local-only'], 5);

        const wordMetrics = summarizeWordMetrics({ dbPath });
        assert.deepStrictEqual(wordMetrics, {
            total: 4,
            saved: 3,
            failed: 1,
            duplicate: 1,
            autoCorrected: 1,
        });

        const markdown = markdownReport({
            generatedAt: '2026-03-07T00:00:00.000Z',
            runtime: {
                defaultModel: 'openai/gpt-5.2',
                bestCodexModel: 'openai-codex/gpt-5.3-codex',
            },
            cost: {
                estimatedMonthlyYen: 0,
                budgetPolicy: { monthlyApiBudgetYen: 0 },
            },
            latency: {
                probes: [],
            },
            routes,
            wordMetrics,
            sessions: {
                byModel: {},
            },
        });
        assert.ok(markdown.includes('## Word ROI'));
        assert.ok(markdown.includes('- saved: 3'));
        assert.ok(markdown.includes('- autoCorrected: 1'));
        assert.ok(markdown.includes('- memo: 1'));
        assert.ok(markdown.includes('- none: 1'));

        console.log('test_model_cost_latency_dashboard: ok');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

main();
