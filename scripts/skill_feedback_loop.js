const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONVERSATION_STAGING_PATH = process.env.CONVERSATION_STAGING_PATH
    ? path.resolve(String(process.env.CONVERSATION_STAGING_PATH))
    : path.join(ROOT, 'data', 'conversation', 'staging.jsonl');
const BRIDGE_INBOX_LOG_PATH = process.env.BRIDGE_INBOX_LOG_PATH
    ? path.resolve(String(process.env.BRIDGE_INBOX_LOG_PATH))
    : path.join(ROOT, 'data', 'bridge', 'inbox.jsonl');
const FEEDBACK_QUEUE_PATH = process.env.SKILL_FEEDBACK_QUEUE_PATH
    ? path.resolve(String(process.env.SKILL_FEEDBACK_QUEUE_PATH))
    : path.join(ROOT, 'data', 'skill', 'feedback_queue.jsonl');
const PATCH_PREVIEW_PATH = process.env.SKILL_PATCH_PREVIEW_PATH
    ? path.resolve(String(process.env.SKILL_PATCH_PREVIEW_PATH))
    : path.join(ROOT, 'reports', 'skill_patch_preview.md');

const FEEDBACK_TRIGGER_RE = /(수정해|수정|틀렸|오류|에러|고쳐|개선|다시|누락|잘못)/i;

function ensureDirs() {
    fs.mkdirSync(path.dirname(FEEDBACK_QUEUE_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(PATCH_PREVIEW_PATH), { recursive: true });
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
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

function readQueueRows() {
    return readJsonl(FEEDBACK_QUEUE_PATH);
}

function isPendingSuggestionDuplicate(suggestion, queueRows, nowMs) {
    const key = String(suggestion && suggestion.key || '').trim();
    if (!key) return false;
    const windowMs = Math.max(1, Number(process.env.SKILL_FEEDBACK_DEDUPE_HOURS || 72)) * 60 * 60 * 1000;
    return queueRows.some((row) => {
        if (!row || String(row.status || '') !== 'pending_approval') return false;
        const existingKey = String(row.suggestion && row.suggestion.key || '').trim();
        if (existingKey !== key) return false;
        const createdAt = Date.parse(String(row.createdAt || ''));
        if (!Number.isFinite(createdAt)) return true;
        return (nowMs - createdAt) <= windowMs;
    });
}

function toUnifiedRows() {
    const rows = [];
    for (const row of readJsonl(CONVERSATION_STAGING_PATH)) {
        rows.push({
            timestamp: row.timestamp || null,
            route: row.route || 'none',
            message: row.message || '',
            source: row.source || 'user',
            id: row.id || null,
        });
    }
    for (const row of readJsonl(BRIDGE_INBOX_LOG_PATH)) {
        rows.push({
            timestamp: row.timestamp || null,
            route: row.route || 'none',
            message: row.command || '',
            source: row.source || 'bridge',
            id: row.taskId || null,
        });
    }
    return rows;
}

function pickTriggered(rows, limit = 100) {
    const filtered = rows.filter((row) => FEEDBACK_TRIGGER_RE.test(String(row.message || '')));
    return filtered.slice(-Math.max(1, limit));
}

function buildSuggestions(triggeredRows) {
    const joined = triggeredRows.map((row) => String(row.message || '').toLowerCase()).join('\n');
    const suggestions = [];

    if (/스킬/.test(joined) || /skill/.test(joined)) {
        suggestions.push({
            key: 'skill-revision-loop',
            title: '스킬 수정 루프 강화',
            why: '스킬 수정 요청이 반복적으로 관측됨',
            patchHint: 'SKILL.md에 수정요청→diff제안→승인→즉시반영 절차를 고정 규칙으로 명시',
        });
    }
    if (/메모|기록|로그/.test(joined)) {
        suggestions.push({
            key: 'conversation-routing',
            title: '메모/기록 라우트 보강',
            why: '대화 기록 관련 요청이 반복됨',
            patchHint: 'bridge prefix/allowlist에 메모·기록을 상시 허용하고 저장 성공 메시지 표준화',
        });
    }
    if (/노션|notion/.test(joined)) {
        suggestions.push({
            key: 'notion-governance',
            title: 'Notion 승인 가드 강화',
            why: 'Notion 반영/수정 요청이 반복됨',
            patchHint: 'DB write는 approval token 필수, DB meta mutation은 기본 차단',
        });
    }
    if (/포트폴리오|headhunter|헤드헌터/.test(joined)) {
        suggestions.push({
            key: 'portfolio-structure',
            title: '포트폴리오 섹션 구조화',
            why: '채용 관점(임팩트/신뢰성) 보강 요청이 반복됨',
            patchHint: 'Business Impact / Reliability Metrics / Trade-off / 90-day Plan 섹션을 기본 템플릿화',
        });
    }

    if (!suggestions.length && triggeredRows.length > 0) {
        suggestions.push({
            key: 'general-fallback',
            title: '일반 스킬 보정',
            why: '오류/수정 요청이 감지됨',
            patchHint: '재현 단계와 기대 출력 형식을 스킬 규칙에 명시',
        });
    }

    return suggestions;
}

function appendQueue(suggestions, triggeredRows) {
    ensureDirs();
    const queueRows = readQueueRows();
    const now = new Date().toISOString();
    const nowMs = Date.now();
    let appended = 0;
    let skippedExisting = 0;
    for (const suggestion of suggestions) {
        if (isPendingSuggestionDuplicate(suggestion, queueRows, nowMs)) {
            skippedExisting += 1;
            continue;
        }
        const row = {
            id: `skill-fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: now,
            status: 'pending_approval',
            suggestion,
            evidenceCount: triggeredRows.length,
        };
        fs.appendFileSync(FEEDBACK_QUEUE_PATH, `${JSON.stringify(row)}\n`, 'utf8');
        queueRows.push(row);
        appended += 1;
    }
    return { appended, skippedExisting };
}

function renderPreview(triggeredRows, suggestions) {
    const lines = [];
    lines.push(`# Skill Patch Preview (${new Date().toISOString()})`);
    lines.push('');
    lines.push(`- Triggered rows: ${triggeredRows.length}`);
    lines.push(`- Suggestions: ${suggestions.length}`);
    lines.push('');
    lines.push('## Proposed Changes');
    for (const [idx, suggestion] of suggestions.entries()) {
        lines.push(`${idx + 1}. ${suggestion.title}`);
        lines.push(`- Why: ${suggestion.why}`);
        lines.push(`- Patch hint: ${suggestion.patchHint}`);
    }
    lines.push('');
    lines.push('## Evidence (Recent)');
    for (const row of triggeredRows.slice(-20)) {
        const ts = row.timestamp || '-';
        const route = row.route || 'none';
        const msg = String(row.message || '').replace(/\s+/g, ' ').slice(0, 180);
        lines.push(`- ${ts} | ${route} | ${msg}`);
    }
    if (triggeredRows.length === 0) {
        lines.push('- none');
    }
    return lines.join('\n');
}

function parseCliArgs(argv) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    const opts = {};
    for (let i = 0; i < args.length; i += 1) {
        const token = String(args[i] || '');
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = args[i + 1];
        if (next != null && !String(next).startsWith('--')) {
            opts[key] = String(next);
            i += 1;
        } else {
            opts[key] = '1';
        }
    }
    return opts;
}

function main() {
    const opts = parseCliArgs(process.argv.slice(2));
    const limit = Math.max(1, Number(opts.limit || 120));
    const rows = toUnifiedRows();
    const triggered = pickTriggered(rows, limit);
    const suggestions = buildSuggestions(triggered);
    const queueResult = appendQueue(suggestions, triggered);
    const preview = renderPreview(triggered, suggestions);
    ensureDirs();
    fs.writeFileSync(PATCH_PREVIEW_PATH, preview, 'utf8');
    console.log(JSON.stringify({
        ok: true,
        scanned: rows.length,
        triggered: triggered.length,
        suggestions: suggestions.length,
        appended: queueResult.appended,
        skippedExisting: queueResult.skippedExisting,
        queuePath: FEEDBACK_QUEUE_PATH,
        previewPath: PATCH_PREVIEW_PATH,
    }, null, 2));
}

if (require.main === module) {
    main();
}

module.exports = {
    buildSuggestions,
    pickTriggered,
    FEEDBACK_TRIGGER_RE,
};
