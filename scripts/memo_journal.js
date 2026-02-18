const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');

const DEFAULT_PATHS = Object.freeze({
    entriesPath: path.join(RUNTIME_DIR, 'memo_journal_entries.jsonl'),
    dedupePath: path.join(RUNTIME_DIR, 'memo_journal_dedupe.json'),
    dailyPath: path.join(RUNTIME_DIR, 'memo_journal_daily.json'),
    aggregatePath: path.join(RUNTIME_DIR, 'memo_journal_stats.json'),
});

const CATEGORY_RULES = Object.freeze([
    { key: 'exercise', label: '운동', regex: /(운동|러닝|벤치|오헤프|스쿼트|데드|풀업|바벨로우|헬스)/i },
    { key: 'toeic', label: '토익/영어', regex: /(토익|영단어|anki|안키|프영안|파트[567]|문법|영어공부)/i },
    { key: 'algorithm', label: '알고리즘', regex: /(알고리즘|알고)/i },
    { key: 'coding', label: '코딩/개발', regex: /(오픈클로|코딩|바이브\s*코딩|vibe\s*coding|gpt\s*project|llm|프로젝트)/i },
    { key: 'reading', label: '독서', regex: /(독서|책)/i },
    { key: 'journal', label: '감정기록', regex: /(감사일기|다이어리|cbt)/i },
    { key: 'sleep', label: '수면', regex: /(취침|자기|잠)/i },
    { key: 'meal', label: '식사/밀프랩', regex: /(점심|저녁|아침|도시락|밥|닭가슴살|닭갈비|계란|밀프랩)/i },
    { key: 'chore', label: '집안일', regex: /(빨래|청소|정리|소분|개기|에어팟\s*청소|프로젝터\s*청소)/i },
    { key: 'finance', label: '소비/금전', regex: /(구매|결제|아마존|현금|엔|만엔|장보기|출금|증권|우편|가격)/i },
    { key: 'media', label: '콘텐츠소비', regex: /(보기|솔로지옥|더\s*베어|어플)/i },
    { key: 'admin', label: '행정/업무', regex: /(상담|서류|우편|오모테산도|바버|피부과)/i },
]);

const CATEGORY_LABELS = Object.freeze(
    CATEGORY_RULES.reduce((acc, row) => {
        acc[row.key] = row.label;
        return acc;
    }, {}),
);

function ensureParent(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function writeJson(filePath, data) {
    ensureParent(filePath);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function appendJsonl(filePath, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    ensureParent(filePath);
    const body = rows.map((row) => JSON.stringify(row)).join('\n');
    fs.appendFileSync(filePath, `${body}\n`, 'utf8');
}

function pad2(v) {
    return String(v).padStart(2, '0');
}

function nowIso() {
    return new Date().toISOString();
}

function toIsoDate(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function normalizeLine(line) {
    return String(line || '').replace(/\s+/g, ' ').trim();
}

function normalizeItemText(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line) return { text: '', status: 'done' };
    let status = 'done';
    if (/(스킵|skip|못함|미완|보류)/i.test(line)) {
        status = 'partial';
    } else if (/[-–—]\s*$/.test(line)) {
        status = 'planned';
    }
    const cleaned = line
        .replace(/^[\-\*\u2022]+\s*/, '')
        .replace(/[-–—]\s*$/, '')
        .trim();
    return {
        text: cleaned || line,
        status,
    };
}

function parseRangeHint(lines, now = new Date()) {
    for (const raw of lines) {
        const line = normalizeLine(raw);
        if (!line) continue;
        const m = line.match(/^(\d{2})(\d{2})(\d{1,2})\s*[~\-]\s*(\d{1,2})$/);
        if (!m) break;
        const yy = Number(m[1]);
        const mm = Number(m[2]);
        const startDay = Number(m[3]);
        const endDay = Number(m[4]);
        if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(startDay) || !Number.isFinite(endDay)) break;
        return {
            year: 2000 + yy,
            month: mm,
            startDay,
            endDay,
        };
    }
    return {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        startDay: null,
        endDay: null,
    };
}

function parseDayHeader(line) {
    const m = String(line || '').trim().match(/^(\d{1,2})\s*(월|화|수|목|금|토|일)(?:요일)?$/);
    if (!m) return null;
    return {
        day: Number(m[1]),
        weekday: m[2],
    };
}

function classifyCategories(text) {
    const line = String(text || '').trim();
    const categories = [];
    for (const row of CATEGORY_RULES) {
        if (row.regex.test(line)) categories.push(row.key);
    }
    if (!categories.length) categories.push('misc');
    return [...new Set(categories)];
}

function parseExpenseYen(text, categories = []) {
    const line = String(text || '').trim();
    const isFinance = Array.isArray(categories) && categories.includes('finance');
    if (!line || !isFinance) return 0;

    let total = 0;
    const manPattern = /(\d+(?:,\d{3})*)\s*만엔/g;
    const yenPattern = /(\d+(?:,\d{3})*)\s*엔/g;
    let m;
    while ((m = manPattern.exec(line)) !== null) {
        total += Number(String(m[1]).replace(/,/g, '')) * 10000;
    }
    while ((m = yenPattern.exec(line)) !== null) {
        total += Number(String(m[1]).replace(/,/g, ''));
    }

    if (total === 0 && /만엔/.test(line)) {
        total = 10000;
    }
    if (total > 0) return total;

    // "구매 2491 아마존"처럼 통화 단위가 생략된 케이스를 보정한다.
    if (/(구매|결제|아마존|현금|출금|장보기|가격)/i.test(line)) {
        const nums = line.match(/\d{3,7}/g) || [];
        if (nums.length > 0) {
            const candidate = Number(nums[nums.length - 1]);
            if (Number.isFinite(candidate) && candidate > 0) return candidate;
        }
    }
    return 0;
}

function resolveDate(day, context) {
    const safeDay = Math.max(1, Math.min(31, Number(day || 1)));
    return toIsoDate(context.year, context.month, safeDay);
}

function parseMemoJournalText(text, options = {}) {
    const now = options.now ? new Date(options.now) : new Date();
    const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = raw.split('\n');
    const range = parseRangeHint(lines, now);
    const daySet = new Set();
    const items = [];
    const warnings = [];
    let currentDate = '';

    for (const rawLine of lines) {
        const line = normalizeLine(rawLine);
        if (!line) continue;
        if (/^\d{2}\d{2}\d{1,2}\s*[~\-]\s*\d{1,2}$/.test(line)) continue;

        const header = parseDayHeader(line);
        if (header) {
            currentDate = resolveDate(header.day, range);
            daySet.add(currentDate);
            continue;
        }

        if (!currentDate) {
            // 날짜 헤더 전 텍스트는 무시(제목/범위/메모 헤더 등)
            continue;
        }

        const normalized = normalizeItemText(rawLine);
        if (!normalized.text) continue;
        const categories = classifyCategories(normalized.text);
        const expenseYen = parseExpenseYen(normalized.text, categories);
        items.push({
            date: currentDate,
            raw: String(rawLine || '').trim(),
            text: normalized.text,
            status: normalized.status,
            categories,
            expenseYen,
        });
    }

    if (items.length === 0) {
        const fallbackDate = toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
        const fallbackItems = raw
            .split('\n')
            .map((line) => normalizeLine(line))
            .filter(Boolean);
        for (const line of fallbackItems) {
            const normalized = normalizeItemText(line);
            if (!normalized.text) continue;
            const categories = classifyCategories(normalized.text);
            const expenseYen = parseExpenseYen(normalized.text, categories);
            items.push({
                date: fallbackDate,
                raw: line,
                text: normalized.text,
                status: normalized.status,
                categories,
                expenseYen,
            });
        }
        if (items.length > 0) daySet.add(fallbackDate);
        warnings.push('day_header_missing_fallback_used');
    }

    const days = [...daySet].sort();
    return {
        inputText: raw,
        days,
        items,
        range,
        warnings,
    };
}

function hashItem(date, text, status = '') {
    const material = `${String(date)}|${normalizeLine(text).toLowerCase()}|${String(status || '')}`;
    return crypto.createHash('sha256').update(material).digest('hex');
}

function resolvePaths(options = {}) {
    const env = options.env || process.env;
    const overrides = options.paths && typeof options.paths === 'object' ? options.paths : {};
    return {
        entriesPath: String(overrides.entriesPath || env.MEMO_JOURNAL_ENTRIES_PATH || DEFAULT_PATHS.entriesPath),
        dedupePath: String(overrides.dedupePath || env.MEMO_JOURNAL_DEDUPE_PATH || DEFAULT_PATHS.dedupePath),
        dailyPath: String(overrides.dailyPath || env.MEMO_JOURNAL_DAILY_PATH || DEFAULT_PATHS.dailyPath),
        aggregatePath: String(overrides.aggregatePath || env.MEMO_JOURNAL_AGGREGATE_PATH || DEFAULT_PATHS.aggregatePath),
    };
}

function initDailyRow(date) {
    return {
        date,
        item_count: 0,
        status_counts: { done: 0, planned: 0, partial: 0 },
        expense_yen: 0,
        category_counts: {},
        updated_at: nowIso(),
    };
}

function rebuildAggregate(dailyDoc) {
    const totals = {
        day_count: 0,
        item_count: 0,
        status_counts: { done: 0, planned: 0, partial: 0 },
        expense_yen: 0,
        exercise_days: 0,
        study_days: 0,
    };
    const categoryCounts = {};
    const dayRows = Object.values((dailyDoc && dailyDoc.days) || {});
    const sortedRows = dayRows
        .filter((row) => row && typeof row === 'object')
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    totals.day_count = sortedRows.length;
    for (const row of sortedRows) {
        totals.item_count += Number(row.item_count || 0);
        totals.status_counts.done += Number(row.status_counts && row.status_counts.done || 0);
        totals.status_counts.planned += Number(row.status_counts && row.status_counts.planned || 0);
        totals.status_counts.partial += Number(row.status_counts && row.status_counts.partial || 0);
        totals.expense_yen += Number(row.expense_yen || 0);

        const categories = row.category_counts || {};
        const hasExercise = Number(categories.exercise || 0) > 0;
        const hasStudy = Number(categories.toeic || 0) > 0
            || Number(categories.algorithm || 0) > 0
            || Number(categories.coding || 0) > 0;
        if (hasExercise) totals.exercise_days += 1;
        if (hasStudy) totals.study_days += 1;

        for (const [key, value] of Object.entries(categories)) {
            categoryCounts[key] = (categoryCounts[key] || 0) + Number(value || 0);
        }
    }

    return {
        version: 1,
        updated_at: nowIso(),
        totals,
        category_counts: categoryCounts,
    };
}

function persistParsedMemo(parsed, options = {}) {
    const paths = resolvePaths(options);
    const dedupeDoc = readJson(paths.dedupePath, { version: 1, updated_at: null, hashes: [] });
    const hashSet = new Set(Array.isArray(dedupeDoc.hashes) ? dedupeDoc.hashes : []);
    const dailyDoc = readJson(paths.dailyPath, { version: 1, updated_at: null, days: {} });
    if (!dailyDoc.days || typeof dailyDoc.days !== 'object') dailyDoc.days = {};

    const addedRows = [];
    const addedByDate = {};
    let duplicateCount = 0;
    for (const item of (Array.isArray(parsed.items) ? parsed.items : [])) {
        const hash = hashItem(item.date, item.text, item.status);
        if (hashSet.has(hash)) {
            duplicateCount += 1;
            continue;
        }
        hashSet.add(hash);
        const row = {
            ingested_at: nowIso(),
            date: item.date,
            text: item.text,
            raw: item.raw,
            status: item.status,
            categories: item.categories,
            expense_yen: Number(item.expenseYen || 0),
            hash,
        };
        addedRows.push(row);
        addedByDate[item.date] = (addedByDate[item.date] || 0) + 1;

        if (!dailyDoc.days[item.date]) {
            dailyDoc.days[item.date] = initDailyRow(item.date);
        }
        const dayRow = dailyDoc.days[item.date];
        dayRow.item_count = Number(dayRow.item_count || 0) + 1;
        const statusKey = String(item.status || 'done');
        if (!dayRow.status_counts || typeof dayRow.status_counts !== 'object') {
            dayRow.status_counts = { done: 0, planned: 0, partial: 0 };
        }
        if (!Object.prototype.hasOwnProperty.call(dayRow.status_counts, statusKey)) {
            dayRow.status_counts[statusKey] = 0;
        }
        dayRow.status_counts[statusKey] += 1;
        dayRow.expense_yen = Number(dayRow.expense_yen || 0) + Number(item.expenseYen || 0);
        if (!dayRow.category_counts || typeof dayRow.category_counts !== 'object') {
            dayRow.category_counts = {};
        }
        for (const category of (Array.isArray(item.categories) ? item.categories : [])) {
            dayRow.category_counts[category] = Number(dayRow.category_counts[category] || 0) + 1;
        }
        dayRow.updated_at = nowIso();
    }

    appendJsonl(paths.entriesPath, addedRows);
    dailyDoc.updated_at = nowIso();
    writeJson(paths.dailyPath, dailyDoc);

    const dedupeHashes = [...hashSet];
    const cappedHashes = dedupeHashes.slice(Math.max(0, dedupeHashes.length - 50000));
    writeJson(paths.dedupePath, {
        version: 1,
        updated_at: nowIso(),
        hashes: cappedHashes,
    });

    const aggregate = rebuildAggregate(dailyDoc);
    writeJson(paths.aggregatePath, aggregate);

    return {
        paths,
        added: addedRows.length,
        duplicates: duplicateCount,
        addedRows,
        addedByDate,
        aggregate,
        daily: dailyDoc,
    };
}

function topCategoryText(categoryCounts, limit = 5) {
    const rows = Object.entries(categoryCounts || {})
        .map(([key, value]) => ({ key, count: Number(value || 0) }))
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, Math.max(1, Number(limit || 5)));
    if (!rows.length) return '-';
    return rows.map((row) => `${CATEGORY_LABELS[row.key] || row.key} ${row.count}회`).join(', ');
}

function buildIngestReply(parsed, persisted) {
    const days = Array.isArray(parsed.days) ? parsed.days : [];
    const totalItems = Array.isArray(parsed.items) ? parsed.items.length : 0;
    const start = days.length ? days[0] : '-';
    const end = days.length ? days[days.length - 1] : '-';
    const addedByDateText = Object.entries(persisted.addedByDate || {})
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
        .map(([date, count]) => `${date}: ${count}개`)
        .join(' / ');

    const totals = (persisted.aggregate && persisted.aggregate.totals) || {};
    const lines = [];
    lines.push('메모 기록 완료');
    lines.push(`- 파싱 기간: ${start} ~ ${end}`);
    lines.push(`- 인식 일수: ${days.length}일, 항목: ${totalItems}개`);
    lines.push(`- 신규 저장: ${persisted.added}개 (중복 제외: ${persisted.duplicates}개)`);
    if (addedByDateText) lines.push(`- 날짜별 신규: ${addedByDateText}`);
    lines.push(`- 누적 항목: ${Number(totals.item_count || 0)}개`);
    lines.push(`- 누적 운동일: ${Number(totals.exercise_days || 0)}일 / 공부일: ${Number(totals.study_days || 0)}일`);
    lines.push(`- 누적 소비: ${Number(totals.expense_yen || 0).toLocaleString('en-US')}엔`);
    lines.push(`- 카테고리 상위: ${topCategoryText(persisted.aggregate && persisted.aggregate.category_counts, 6)}`);
    lines.push('통계 조회: 메모: 통계');
    return lines.join('\n');
}

function parseStatsTarget(text) {
    const line = String(text || '').trim();
    const match = line.match(/^(통계|요약|summary|status)(?:\s+([0-9]{4}-[0-9]{2}|[0-9]{6}))?$/i);
    if (!match) return null;
    const token = String(match[2] || '').trim();
    if (!token) return { type: 'all', month: '' };
    if (/^\d{4}-\d{2}$/.test(token)) return { type: 'month', month: token };
    if (/^\d{6}$/.test(token)) return { type: 'month', month: `${token.slice(0, 4)}-${token.slice(4, 6)}` };
    return { type: 'all', month: '' };
}

function summarizeMonth(dailyDoc, month) {
    const rows = Object.values((dailyDoc && dailyDoc.days) || {})
        .filter((row) => row && typeof row === 'object')
        .filter((row) => String(row.date || '').startsWith(`${month}-`));
    const sum = {
        day_count: rows.length,
        item_count: 0,
        expense_yen: 0,
        exercise_days: 0,
        study_days: 0,
        status_counts: { done: 0, planned: 0, partial: 0 },
        category_counts: {},
    };
    for (const row of rows) {
        sum.item_count += Number(row.item_count || 0);
        sum.expense_yen += Number(row.expense_yen || 0);
        sum.status_counts.done += Number(row.status_counts && row.status_counts.done || 0);
        sum.status_counts.planned += Number(row.status_counts && row.status_counts.planned || 0);
        sum.status_counts.partial += Number(row.status_counts && row.status_counts.partial || 0);
        const categories = row.category_counts || {};
        if (Number(categories.exercise || 0) > 0) sum.exercise_days += 1;
        if (
            Number(categories.toeic || 0) > 0
            || Number(categories.algorithm || 0) > 0
            || Number(categories.coding || 0) > 0
        ) {
            sum.study_days += 1;
        }
        for (const [key, value] of Object.entries(categories)) {
            sum.category_counts[key] = (sum.category_counts[key] || 0) + Number(value || 0);
        }
    }
    return sum;
}

function buildStatsReply(paths, target) {
    const aggregate = readJson(paths.aggregatePath, null);
    const dailyDoc = readJson(paths.dailyPath, { version: 1, days: {} });
    if (!aggregate || !aggregate.totals) {
        return {
            success: true,
            action: 'stats',
            target: target.type,
            telegramReply: '아직 기록된 메모 통계가 없어. 먼저 메모: 로 기록을 보내줘.',
        };
    }

    if (target.type === 'month' && target.month) {
        const monthSum = summarizeMonth(dailyDoc, target.month);
        return {
            success: true,
            action: 'stats',
            target: 'month',
            month: target.month,
            summary: monthSum,
            telegramReply: [
                `메모 통계 (${target.month})`,
                `- 기록 일수: ${monthSum.day_count}일`,
                `- 항목: ${monthSum.item_count}개`,
                `- 운동일: ${monthSum.exercise_days}일 / 공부일: ${monthSum.study_days}일`,
                `- 소비: ${monthSum.expense_yen.toLocaleString('en-US')}엔`,
                `- 완료/계획/부분: ${monthSum.status_counts.done}/${monthSum.status_counts.planned}/${monthSum.status_counts.partial}`,
                `- 카테고리 상위: ${topCategoryText(monthSum.category_counts, 6)}`,
            ].join('\n'),
        };
    }

    const totals = aggregate.totals || {};
    return {
        success: true,
        action: 'stats',
        target: 'all',
        summary: totals,
        telegramReply: [
            '메모 누적 통계',
            `- 기록 일수: ${Number(totals.day_count || 0)}일`,
            `- 항목: ${Number(totals.item_count || 0)}개`,
            `- 운동일: ${Number(totals.exercise_days || 0)}일 / 공부일: ${Number(totals.study_days || 0)}일`,
            `- 소비: ${Number(totals.expense_yen || 0).toLocaleString('en-US')}엔`,
            `- 완료/계획/부분: ${Number(totals.status_counts && totals.status_counts.done || 0)}/${Number(totals.status_counts && totals.status_counts.planned || 0)}/${Number(totals.status_counts && totals.status_counts.partial || 0)}`,
            `- 카테고리 상위: ${topCategoryText(aggregate.category_counts, 6)}`,
            '월별 조회: 메모: 통계 2026-02',
        ].join('\n'),
    };
}

function loadTextFromPayload(payload) {
    const raw = String(payload || '').trim();
    if (!raw) return { ok: false, text: '', error: 'empty payload' };

    const fileMatch = raw.match(/^(파일|file)\s*[:：]\s*(.+)$/i);
    if (fileMatch) {
        const filePath = String(fileMatch[2] || '').trim();
        if (!filePath) return { ok: false, text: '', error: 'file path missing' };
        if (!fs.existsSync(filePath)) {
            return { ok: false, text: '', error: `file not found: ${filePath}` };
        }
        return {
            ok: true,
            text: fs.readFileSync(filePath, 'utf8'),
            source: 'file',
            sourcePath: filePath,
        };
    }

    if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
        return {
            ok: true,
            text: fs.readFileSync(raw, 'utf8'),
            source: 'file',
            sourcePath: raw,
        };
    }

    return { ok: true, text: raw, source: 'inline', sourcePath: '' };
}

async function handleMemoCommand(payload, options = {}) {
    const raw = String(payload || '').trim();
    const paths = resolvePaths(options);
    if (!raw) {
        return {
            success: false,
            errorCode: 'MEMO_EMPTY',
            telegramReply: '메모 내용이 비어있어. 메모: 뒤에 텍스트를 붙여서 보내줘.',
        };
    }

    const statsTarget = parseStatsTarget(raw);
    if (statsTarget) {
        return buildStatsReply(paths, statsTarget);
    }

    const loaded = loadTextFromPayload(raw);
    if (!loaded.ok) {
        return {
            success: false,
            errorCode: 'MEMO_LOAD_FAILED',
            telegramReply: `메모 로드 실패: ${loaded.error}`,
        };
    }

    const parsed = parseMemoJournalText(loaded.text, { now: options.now });
    if (!parsed.items.length) {
        return {
            success: false,
            errorCode: 'MEMO_PARSE_EMPTY',
            telegramReply: '메모에서 인식 가능한 항목이 없었어. 날짜/항목 형식을 다시 확인해줘.',
        };
    }

    const persisted = persistParsedMemo(parsed, options);
    return {
        success: true,
        action: 'ingest',
        source: loaded.source,
        sourcePath: loaded.sourcePath || null,
        parsedDays: parsed.days.length,
        parsedItems: parsed.items.length,
        added: persisted.added,
        duplicates: persisted.duplicates,
        warnings: parsed.warnings,
        telegramReply: buildIngestReply(parsed, persisted),
    };
}

async function main() {
    const payload = process.argv.slice(2).join(' ').trim();
    const result = await handleMemoCommand(payload);
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exit(1);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = {
    parseMemoJournalText,
    handleMemoCommand,
    summarizeMonth,
};
