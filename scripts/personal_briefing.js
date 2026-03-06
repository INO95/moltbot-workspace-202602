#!/usr/bin/env node
const { enqueueBridgePayload } = require('./bridge_queue');
const { runSqlJson, sqlQuote } = require('./news_storage');
const { ensurePersonalSchema, resolveDbPath } = require('./personal_schema');
const storage = require('./personal_storage');

const TOKYO_TIMEZONE = 'Asia/Tokyo';
const TOKYO_DAY_FORMAT = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TOKYO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

function toDate(input = null) {
    const date = input ? new Date(input) : new Date();
    if (Number.isFinite(date.getTime())) return date;
    return new Date();
}

function nowKstLikeDate(now = null) {
    return TOKYO_DAY_FORMAT.format(toDate(now));
}

function getTokyoDayWindow(now = null) {
    const date = nowKstLikeDate(now);
    const start = new Date(`${date}T00:00:00+09:00`);
    const end = new Date(start.getTime() + (24 * 60 * 60 * 1000));
    return {
        date,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
    };
}

function pickStorageOptions(options = {}) {
    const out = {};
    if (options.dbPath) out.dbPath = options.dbPath;
    return out;
}

function fmtNum(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0';
    return Math.round(n).toLocaleString('en-US');
}

function getWordActivity(options = {}) {
    const dbPath = resolveDbPath(options);
    const { date } = getTokyoDayWindow(options.now);
    ensurePersonalSchema(dbPath);

    const totals = runSqlJson(
        dbPath,
        `
SELECT
  COUNT(*) AS total,
  COALESCE(SUM(CASE WHEN save_status = 'saved' THEN 1 ELSE 0 END), 0) AS saved,
  COALESCE(SUM(CASE WHEN save_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
FROM vocab_logs
WHERE date(datetime(created_at), '+9 hours') = ${sqlQuote(date)};
`,
    )[0] || { total: 0, saved: 0, failed: 0 };

    const recentSaved = runSqlJson(
        dbPath,
        `
SELECT word, created_at
FROM vocab_logs
WHERE save_status = 'saved'
  AND date(datetime(created_at), '+9 hours') = ${sqlQuote(date)}
ORDER BY datetime(created_at) DESC, id DESC
LIMIT 5;
`,
    );

    return { totals, recentSaved };
}

function buildWordActivityLines(options = {}) {
    const activity = getWordActivity(options);
    const total = Number(activity.totals && activity.totals.total || 0);
    if (total <= 0) return [];

    const lines = [];
    lines.push('- 단어 활동:');
    lines.push(`  • 저장: ${Number(activity.totals && activity.totals.saved || 0)}건`);
    lines.push(`  • 실패: ${Number(activity.totals && activity.totals.failed || 0)}건`);
    if (activity.recentSaved.length) {
        lines.push(`  • 최근 저장: ${activity.recentSaved.map((row) => row.word).join(', ')}`);
    }
    return lines;
}

function buildMorningText(options = {}) {
    const date = nowKstLikeDate(options.now);
    const storageOptions = pickStorageOptions(options);
    const tasks = storage.listTasks({ status: 'open', limit: 8, ...storageOptions });
    const routines = storage.listRoutineTemplates({ onlyActive: true, ...storageOptions });
    const wordActivityLines = buildWordActivityLines(options);

    const lines = [];
    lines.push(`☀️ Morning Briefing (${date})`);
    lines.push(`- 오늘 오픈 투두: ${tasks.length}개`);
    if (tasks.length) {
        lines.push(...tasks.slice(0, 5).map((row) => `  • #${row.id} ${row.title}`));
    }
    lines.push(`- 활성 루틴: ${routines.length}개`);
    if (routines.length) {
        lines.push(...routines.slice(0, 5).map((row) => `  • ${row.name}`));
    }
    if (wordActivityLines.length) {
        lines.push(...wordActivityLines);
    }
    lines.push('입력 예시: 투두: 완료 12 / 루틴: 체크 물 2L / 운동: 러닝 30분');
    return lines.join('\n');
}

function buildEveningText(options = {}) {
    const date = nowKstLikeDate(options.now);
    const month = date.slice(0, 7);
    const storageOptions = pickStorageOptions(options);
    const todoSummary = storage.summarizeTasks(storageOptions);
    const routineSummary = storage.summarizeRoutine({ month, ...storageOptions });
    const workoutSummary = storage.summarizeWorkout({ month, ...storageOptions });
    const ledgerSummary = storage.summarizeLedger({ month, ...storageOptions });
    const lines = [
        `🌙 Evening Briefing (${date})`,
        `- 투두(open/done): ${Number(todoSummary.totals && todoSummary.totals.open || 0)}/${Number(todoSummary.totals && todoSummary.totals.done || 0)}`,
        `- 루틴 체크인(월): ${Number(routineSummary.totals && routineSummary.totals.checkins || 0)}회`,
        `- 운동 세션(월): ${Number(workoutSummary.totals && workoutSummary.totals.sessions || 0)}회`,
        `- 월 지출(JPY): ${fmtNum(ledgerSummary.totals && ledgerSummary.totals.expense_jpy)}`,
        `- 월 순합계(JPY): ${fmtNum(ledgerSummary.totals && ledgerSummary.totals.net_jpy)}`,
    ];
    const wordActivityLines = buildWordActivityLines(options);
    if (wordActivityLines.length) {
        lines.push(...wordActivityLines);
    }
    return lines.join('\n');
}

async function sendInboxMessage(message) {
    const payload = {
        taskId: `personal-briefing-${Date.now()}`,
        command: `[NOTIFY] ${String(message || '').trim()}`,
        timestamp: new Date().toISOString(),
        status: 'pending',
        source: 'personal-briefing',
    };
    enqueueBridgePayload(payload);
    return payload.taskId;
}

async function run(mode = 'morning', options = {}) {
    const normalized = String(mode || 'morning').trim().toLowerCase();
    const enqueue = options.enqueue !== false;

    let text;
    if (normalized === 'evening') {
        text = buildEveningText(options);
    } else {
        text = buildMorningText(options);
    }

    let taskId = null;
    if (enqueue) {
        taskId = await sendInboxMessage(text);
    }

    return {
        ok: true,
        mode: normalized,
        enqueue,
        taskId,
        text,
    };
}

async function main() {
    const mode = String(process.argv[2] || 'morning').trim();
    const enqueue = !process.argv.includes('--no-enqueue');
    const result = await run(mode, { enqueue });
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = {
    run,
    buildMorningText,
    buildEveningText,
    getWordActivity,
};
