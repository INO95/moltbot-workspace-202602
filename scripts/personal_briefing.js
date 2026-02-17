#!/usr/bin/env node
const { enqueueBridgePayload } = require('./bridge_queue');
const storage = require('./personal_storage');

function nowKstLikeDate() {
    const fmt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return fmt.format(new Date());
}

function fmtNum(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0';
    return Math.round(n).toLocaleString('en-US');
}

function buildMorningText() {
    const date = nowKstLikeDate();
    const tasks = storage.listTasks({ status: 'open', limit: 8 });
    const routines = storage.listRoutineTemplates({ onlyActive: true });

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
    lines.push('입력 예시: 투두: 완료 12 / 루틴: 체크 물 2L / 운동: 러닝 30분');
    return lines.join('\n');
}

function buildEveningText() {
    const date = nowKstLikeDate();
    const month = date.slice(0, 7);
    const todoSummary = storage.summarizeTasks();
    const routineSummary = storage.summarizeRoutine({ month });
    const workoutSummary = storage.summarizeWorkout({ month });
    const ledgerSummary = storage.summarizeLedger({ month });

    return [
        `🌙 Evening Briefing (${date})`,
        `- 투두(open/done): ${Number(todoSummary.totals && todoSummary.totals.open || 0)}/${Number(todoSummary.totals && todoSummary.totals.done || 0)}`,
        `- 루틴 체크인(월): ${Number(routineSummary.totals && routineSummary.totals.checkins || 0)}회`,
        `- 운동 세션(월): ${Number(workoutSummary.totals && workoutSummary.totals.sessions || 0)}회`,
        `- 월 지출(JPY): ${fmtNum(ledgerSummary.totals && ledgerSummary.totals.expense_jpy)}`,
        `- 월 순합계(JPY): ${fmtNum(ledgerSummary.totals && ledgerSummary.totals.net_jpy)}`,
    ].join('\n');
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
        text = buildEveningText();
    } else {
        text = buildMorningText();
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
};
