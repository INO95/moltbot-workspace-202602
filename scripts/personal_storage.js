const crypto = require('crypto');
const { runSql, runSqlJson, sqlQuote } = require('./news_storage');
const { resolveDbPath, ensurePersonalSchema } = require('./personal_schema');

const DEFAULT_RETAIN_DAYS = 90;

const DEFAULT_FX_TO_JPY = Object.freeze({
    JPY: 1,
    KRW: 0.11,
    USD: 150,
    EUR: 160,
});

function nowIso() {
    return new Date().toISOString();
}

function toIsoDate(input = null) {
    const date = input ? new Date(input) : new Date();
    if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(0, 10);
    return date.toISOString().slice(0, 10);
}

function normalizeSpace(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
}

function normalizeRoute(route) {
    return String(route || '').trim().toLowerCase() || 'none';
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function buildEventId(prefix = 'evt') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getDbPath(options = {}) {
    return resolveDbPath(options);
}

function ensureStorage(options = {}) {
    const dbPath = getDbPath(options);
    ensurePersonalSchema(dbPath);
    return dbPath;
}

function safeJson(value, fallback = '{}') {
    try {
        return JSON.stringify(value == null ? {} : value);
    } catch (_) {
        return fallback;
    }
}

function eventLookupByDedupe(dbPath, dedupeHash) {
    const rows = runSqlJson(
        dbPath,
        `SELECT event_id, created_at FROM event_inbox WHERE dedupe_hash = ${sqlQuote(dedupeHash)} LIMIT 1;`,
    );
    return rows[0] || null;
}

function retainUntilIso(days = DEFAULT_RETAIN_DAYS, baseIso = nowIso()) {
    const base = new Date(baseIso);
    if (!Number.isFinite(base.getTime())) return null;
    base.setUTCDate(base.getUTCDate() + Math.max(1, Number(days || DEFAULT_RETAIN_DAYS)));
    return base.toISOString();
}

function createEvent(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const route = normalizeRoute(input.route);
    const rawText = String(input.rawText || '').trim();
    const normalizedText = normalizeSpace(input.normalizedText || rawText);
    const source = String(input.source || 'telegram').trim() || 'telegram';
    const createdAt = String(input.createdAt || nowIso());
    const payloadJson = safeJson(input.payload || {});
    const dedupeMaterial = String(input.dedupeMaterial || '').trim();
    const hashMaterial = [source, route, normalizedText.toLowerCase(), dedupeMaterial].join('|');
    const dedupeHash = String(input.dedupeHash || sha256(hashMaterial));

    const existing = eventLookupByDedupe(dbPath, dedupeHash);
    if (existing) {
        return {
            dbPath,
            eventId: String(existing.event_id),
            duplicate: true,
            dedupeHash,
            createdAt: String(existing.created_at || createdAt),
        };
    }

    const eventId = String(input.eventId || buildEventId('evt'));
    const retainedUntil = retainUntilIso(input.retainDays, createdAt);

    try {
        runSql(
            dbPath,
            `
INSERT INTO event_inbox (
  event_id, source, route, raw_text, normalized_text, payload_json, dedupe_hash,
  created_at, retained_until, ingest_status, error_text
)
VALUES (
  ${sqlQuote(eventId)},
  ${sqlQuote(source)},
  ${sqlQuote(route)},
  ${sqlQuote(rawText || null)},
  ${sqlQuote(normalizedText || null)},
  ${sqlQuote(payloadJson)},
  ${sqlQuote(dedupeHash)},
  ${sqlQuote(createdAt)},
  ${sqlQuote(retainedUntil)},
  ${sqlQuote('processed')},
  NULL
);
`,
        );
    } catch (error) {
        const msg = String(error && error.message ? error.message : error);
        if (/UNIQUE constraint failed:\s*event_inbox\.dedupe_hash/i.test(msg)) {
            const collided = eventLookupByDedupe(dbPath, dedupeHash);
            if (collided) {
                return {
                    dbPath,
                    eventId: String(collided.event_id),
                    duplicate: true,
                    dedupeHash,
                    createdAt: String(collided.created_at || createdAt),
                };
            }
        }
        throw error;
    }

    return {
        dbPath,
        eventId,
        duplicate: false,
        dedupeHash,
        createdAt,
    };
}

function markEventFailed(eventId, errorText, options = {}) {
    if (!eventId) return;
    const dbPath = ensureStorage(options);
    runSql(
        dbPath,
        `
UPDATE event_inbox
SET ingest_status = 'failed',
    error_text = ${sqlQuote(String(errorText || '').slice(0, 500))}
WHERE event_id = ${sqlQuote(String(eventId))};
`,
    );
}

function getFxRateToJpy(currency, overrides = {}) {
    const code = String(currency || 'JPY').trim().toUpperCase() || 'JPY';
    const merged = { ...DEFAULT_FX_TO_JPY, ...(overrides || {}) };
    const value = Number(merged[code]);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function convertToJpy(amount, currency, overrides = {}) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return { fxRate: null, amountJpy: null };
    const fxRate = getFxRateToJpy(currency, overrides);
    if (!Number.isFinite(fxRate) || fxRate <= 0) {
        return { fxRate: null, amountJpy: null };
    }
    return {
        fxRate,
        amountJpy: Math.round(n * fxRate * 100) / 100,
    };
}

function insertLedgerEntry(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const createdAt = String(input.createdAt || nowIso());
    const entryDate = toIsoDate(input.entryDate || createdAt);
    const entryType = String(input.entryType || 'expense').trim().toLowerCase();
    const item = String(input.item || '지출').trim() || '지출';
    const amount = Number(input.amount);
    const currency = String(input.currency || 'JPY').trim().toUpperCase() || 'JPY';
    const conv = convertToJpy(amount, currency, input.fxOverrides || options.fxOverrides || {});
    const tagsJson = safeJson(Array.isArray(input.tags) ? input.tags : []);

    if (!Number.isFinite(amount)) {
        throw new Error('ledger amount must be numeric');
    }

    runSql(
        dbPath,
        `
INSERT OR IGNORE INTO ledger_entries (
  event_id, entry_date, entry_type, item, amount, currency, fx_rate_to_jpy, amount_jpy,
  category, payment_method, memo, tags_json, created_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(entryDate)},
  ${sqlQuote(entryType)},
  ${sqlQuote(item)},
  ${sqlQuote(amount)},
  ${sqlQuote(currency)},
  ${sqlQuote(conv.fxRate == null ? null : conv.fxRate)},
  ${sqlQuote(conv.amountJpy == null ? null : conv.amountJpy)},
  ${sqlQuote(String(input.category || '').trim() || null)},
  ${sqlQuote(String(input.paymentMethod || '').trim() || null)},
  ${sqlQuote(String(input.memo || '').trim() || null)},
  ${sqlQuote(tagsJson)},
  ${sqlQuote(createdAt)}
);
`,
    );

    const row = runSqlJson(
        dbPath,
        `
SELECT id, event_id, entry_date, entry_type, item, amount, currency, amount_jpy
FROM ledger_entries
WHERE event_id = ${sqlQuote(String(input.eventId || ''))}
ORDER BY id DESC
LIMIT 1;
`,
    )[0] || null;

    return row;
}

function summarizeLedger(options = {}) {
    const dbPath = ensureStorage(options);
    const month = String(options.month || '').trim();
    const where = /^\d{4}-\d{2}$/.test(month)
        ? `WHERE entry_date LIKE ${sqlQuote(`${month}-%`)}`
        : '';

    const totals = runSqlJson(
        dbPath,
        `
SELECT
  COUNT(*) AS count,
  COALESCE(SUM(CASE WHEN entry_type = 'expense' THEN amount_jpy ELSE 0 END), 0) AS expense_jpy,
  COALESCE(SUM(CASE WHEN entry_type IN ('income', 'refund') THEN amount_jpy ELSE 0 END), 0) AS income_jpy,
  COALESCE(SUM(CASE WHEN entry_type = 'transfer' THEN amount_jpy ELSE 0 END), 0) AS transfer_jpy,
  COALESCE(SUM(amount_jpy), 0) AS net_jpy
FROM ledger_entries
${where};
`,
    )[0] || { count: 0, expense_jpy: 0, income_jpy: 0, transfer_jpy: 0, net_jpy: 0 };

    const byCategory = runSqlJson(
        dbPath,
        `
SELECT COALESCE(category, '기타') AS category, COUNT(*) AS count, COALESCE(SUM(amount_jpy), 0) AS amount_jpy
FROM ledger_entries
${where}
GROUP BY COALESCE(category, '기타')
ORDER BY ABS(amount_jpy) DESC
LIMIT 6;
`,
    );

    const recent = runSqlJson(
        dbPath,
        `
SELECT id, entry_date, entry_type, item, amount, currency, amount_jpy, category
FROM ledger_entries
${where}
ORDER BY entry_date DESC, id DESC
LIMIT 8;
`,
    );

    return { totals, byCategory, recent };
}

function createTask(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const now = String(input.createdAt || nowIso());
    const title = normalizeSpace(input.title);
    if (!title) throw new Error('task title is required');

    runSql(
        dbPath,
        `
INSERT INTO tasks (
  event_id, title, status, priority, due_date, notes, archived,
  created_at, updated_at, completed_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(title)},
  ${sqlQuote(String(input.status || 'open').trim() || 'open')},
  ${sqlQuote(Number.isFinite(Number(input.priority)) ? Number(input.priority) : 3)},
  ${sqlQuote(String(input.dueDate || '').trim() || null)},
  ${sqlQuote(String(input.notes || '').trim() || null)},
  ${sqlQuote(Number(input.archived ? 1 : 0))},
  ${sqlQuote(now)},
  ${sqlQuote(now)},
  NULL
);
`,
    );

    return runSqlJson(dbPath, 'SELECT * FROM tasks ORDER BY id DESC LIMIT 1;')[0] || null;
}

function listTasks(options = {}) {
    const dbPath = ensureStorage(options);
    const status = String(options.status || '').trim().toLowerCase();
    const where = status ? `WHERE status = ${sqlQuote(status)} AND archived = 0` : 'WHERE archived = 0';
    return runSqlJson(
        dbPath,
        `
SELECT id, title, status, priority, due_date, created_at, updated_at, completed_at
FROM tasks
${where}
ORDER BY
  CASE status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,
  priority ASC,
  id DESC
LIMIT ${Math.max(1, Number(options.limit || 20))};
`,
    );
}

function findTaskByToken(token, options = {}) {
    const dbPath = ensureStorage(options);
    const raw = String(token || '').trim();
    if (!raw) return null;

    if (/^\d+$/.test(raw)) {
        return runSqlJson(
            dbPath,
            `SELECT * FROM tasks WHERE id = ${sqlQuote(Number(raw))} LIMIT 1;`,
        )[0] || null;
    }

    const normalized = normalizeSpace(raw).toLowerCase();
    return runSqlJson(
        dbPath,
        `
SELECT * FROM tasks
WHERE archived = 0
  AND LOWER(title) LIKE ${sqlQuote(`%${normalized}%`)}
ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC
LIMIT 1;
`,
    )[0] || null;
}

function updateTaskStatus(taskId, status, options = {}) {
    const dbPath = ensureStorage(options);
    const now = nowIso();
    const normalizedStatus = String(status || '').trim().toLowerCase() || 'open';
    runSql(
        dbPath,
        `
UPDATE tasks
SET status = ${sqlQuote(normalizedStatus)},
    updated_at = ${sqlQuote(now)},
    completed_at = ${normalizedStatus === 'done' ? sqlQuote(now) : 'NULL'}
WHERE id = ${sqlQuote(Number(taskId))};
`,
    );

    return runSqlJson(dbPath, `SELECT * FROM tasks WHERE id = ${sqlQuote(Number(taskId))} LIMIT 1;`)[0] || null;
}

function archiveTask(taskId, options = {}) {
    const dbPath = ensureStorage(options);
    runSql(
        dbPath,
        `
UPDATE tasks
SET archived = 1,
    updated_at = ${sqlQuote(nowIso())}
WHERE id = ${sqlQuote(Number(taskId))};
`,
    );
    return runSqlJson(dbPath, `SELECT * FROM tasks WHERE id = ${sqlQuote(Number(taskId))} LIMIT 1;`)[0] || null;
}

function summarizeTasks(options = {}) {
    const dbPath = ensureStorage(options);
    const totals = runSqlJson(
        dbPath,
        `
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN status = 'open' AND archived = 0 THEN 1 ELSE 0 END) AS open,
  SUM(CASE WHEN status = 'done' AND archived = 0 THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived
FROM tasks;
`,
    )[0] || { total: 0, open: 0, done: 0, archived: 0 };

    const recent = runSqlJson(
        dbPath,
        `
SELECT id, title, status, priority, due_date, updated_at
FROM tasks
WHERE archived = 0
ORDER BY id DESC
LIMIT 8;
`,
    );

    return { totals, recent };
}

function upsertRoutineTemplate(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const now = nowIso();
    const name = normalizeSpace(input.name);
    if (!name) throw new Error('routine name is required');

    runSql(
        dbPath,
        `
INSERT INTO routine_templates (
  event_id, name, description, schedule_hint, active, created_at, updated_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(name)},
  ${sqlQuote(String(input.description || '').trim() || null)},
  ${sqlQuote(String(input.scheduleHint || '').trim() || null)},
  ${sqlQuote(Number(input.active == null ? 1 : (input.active ? 1 : 0)))},
  ${sqlQuote(now)},
  ${sqlQuote(now)}
)
ON CONFLICT(name) DO UPDATE SET
  description = COALESCE(excluded.description, routine_templates.description),
  schedule_hint = COALESCE(excluded.schedule_hint, routine_templates.schedule_hint),
  active = COALESCE(excluded.active, routine_templates.active),
  updated_at = excluded.updated_at;
`,
    );

    return runSqlJson(
        dbPath,
        `SELECT * FROM routine_templates WHERE name = ${sqlQuote(name)} LIMIT 1;`,
    )[0] || null;
}

function listRoutineTemplates(options = {}) {
    const dbPath = ensureStorage(options);
    const onlyActive = options.onlyActive === true;
    const where = onlyActive ? 'WHERE active = 1' : '';
    return runSqlJson(
        dbPath,
        `
SELECT id, name, description, schedule_hint, active, updated_at
FROM routine_templates
${where}
ORDER BY active DESC, name ASC;
`,
    );
}

function findRoutineTemplate(token, options = {}) {
    const dbPath = ensureStorage(options);
    const raw = String(token || '').trim();
    if (!raw) return null;

    if (/^\d+$/.test(raw)) {
        return runSqlJson(
            dbPath,
            `SELECT * FROM routine_templates WHERE id = ${sqlQuote(Number(raw))} LIMIT 1;`,
        )[0] || null;
    }

    const normalized = normalizeSpace(raw).toLowerCase();
    return runSqlJson(
        dbPath,
        `
SELECT * FROM routine_templates
WHERE LOWER(name) LIKE ${sqlQuote(`%${normalized}%`)}
ORDER BY active DESC, id DESC
LIMIT 1;
`,
    )[0] || null;
}

function setRoutineTemplateActive(templateId, active, options = {}) {
    const dbPath = ensureStorage(options);
    runSql(
        dbPath,
        `
UPDATE routine_templates
SET active = ${sqlQuote(active ? 1 : 0)},
    updated_at = ${sqlQuote(nowIso())}
WHERE id = ${sqlQuote(Number(templateId))};
`,
    );
    return runSqlJson(
        dbPath,
        `SELECT * FROM routine_templates WHERE id = ${sqlQuote(Number(templateId))} LIMIT 1;`,
    )[0] || null;
}

function logRoutineCheckin(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const templateId = Number(input.templateId);
    if (!Number.isFinite(templateId) || templateId <= 0) throw new Error('templateId is required');

    const logDate = toIsoDate(input.logDate || nowIso());
    const createdAt = String(input.createdAt || nowIso());
    const status = String(input.status || 'done').trim().toLowerCase() || 'done';

    runSql(
        dbPath,
        `
INSERT OR IGNORE INTO routine_logs (
  event_id, template_id, log_date, status, note, created_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(templateId)},
  ${sqlQuote(logDate)},
  ${sqlQuote(status)},
  ${sqlQuote(String(input.note || '').trim() || null)},
  ${sqlQuote(createdAt)}
);
`,
    );

    return runSqlJson(
        dbPath,
        `
SELECT rl.*, rt.name AS template_name
FROM routine_logs rl
JOIN routine_templates rt ON rt.id = rl.template_id
WHERE rl.template_id = ${sqlQuote(templateId)}
  AND rl.log_date = ${sqlQuote(logDate)}
  AND rl.status = ${sqlQuote(status)}
ORDER BY rl.id DESC
LIMIT 1;
`,
    )[0] || null;
}

function summarizeRoutine(options = {}) {
    const dbPath = ensureStorage(options);
    const month = String(options.month || '').trim();
    const where = /^\d{4}-\d{2}$/.test(month)
        ? `WHERE rl.log_date LIKE ${sqlQuote(`${month}-%`)}`
        : '';

    const totals = runSqlJson(
        dbPath,
        `
SELECT
  COUNT(*) AS checkins,
  COUNT(DISTINCT rl.template_id) AS touched_templates,
  COUNT(DISTINCT rl.log_date) AS active_days
FROM routine_logs rl
${where};
`,
    )[0] || { checkins: 0, touched_templates: 0, active_days: 0 };

    const byTemplate = runSqlJson(
        dbPath,
        `
SELECT rt.name, COUNT(*) AS count
FROM routine_logs rl
JOIN routine_templates rt ON rt.id = rl.template_id
${where}
GROUP BY rt.name
ORDER BY count DESC, rt.name ASC
LIMIT 8;
`,
    );

    return { totals, byTemplate };
}

function recordWorkout(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const createdAt = String(input.createdAt || nowIso());
    const workoutDate = toIsoDate(input.workoutDate || createdAt);

    runSql(
        dbPath,
        `
INSERT INTO workout_logs (
  event_id, workout_date, workout_type, duration_min, calories, distance_km,
  intensity, note, created_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(workoutDate)},
  ${sqlQuote(String(input.workoutType || '운동').trim() || '운동')},
  ${sqlQuote(input.durationMin == null ? null : Number(input.durationMin))},
  ${sqlQuote(input.calories == null ? null : Number(input.calories))},
  ${sqlQuote(input.distanceKm == null ? null : Number(input.distanceKm))},
  ${sqlQuote(String(input.intensity || '').trim() || null)},
  ${sqlQuote(String(input.note || '').trim() || null)},
  ${sqlQuote(createdAt)}
);
`,
    );

    return runSqlJson(dbPath, 'SELECT * FROM workout_logs ORDER BY id DESC LIMIT 1;')[0] || null;
}

function summarizeWorkout(options = {}) {
    const dbPath = ensureStorage(options);
    const month = String(options.month || '').trim();
    const where = /^\d{4}-\d{2}$/.test(month)
        ? `WHERE workout_date LIKE ${sqlQuote(`${month}-%`)}`
        : '';

    const totals = runSqlJson(
        dbPath,
        `
SELECT
  COUNT(*) AS sessions,
  COALESCE(SUM(duration_min), 0) AS total_duration_min,
  COALESCE(SUM(calories), 0) AS total_calories,
  COALESCE(SUM(distance_km), 0) AS total_distance_km,
  COUNT(DISTINCT workout_date) AS active_days
FROM workout_logs
${where};
`,
    )[0] || { sessions: 0, total_duration_min: 0, total_calories: 0, total_distance_km: 0, active_days: 0 };

    const byType = runSqlJson(
        dbPath,
        `
SELECT workout_type, COUNT(*) AS count, COALESCE(SUM(duration_min), 0) AS duration_min
FROM workout_logs
${where}
GROUP BY workout_type
ORDER BY count DESC, workout_type ASC
LIMIT 8;
`,
    );

    const recent = runSqlJson(
        dbPath,
        `
SELECT id, workout_date, workout_type, duration_min, calories, distance_km, intensity
FROM workout_logs
${where}
ORDER BY workout_date DESC, id DESC
LIMIT 8;
`,
    );

    return { totals, byType, recent };
}

function recordVocabLog(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const createdAt = String(input.createdAt || nowIso());

    runSql(
        dbPath,
        `
INSERT OR IGNORE INTO vocab_logs (
  event_id, word, deck, note_id, save_status, error_text, meta_json, created_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(String(input.word || '').trim())},
  ${sqlQuote(String(input.deck || 'TOEIC_AI').trim() || 'TOEIC_AI')},
  ${sqlQuote(input.noteId == null ? null : Number(input.noteId))},
  ${sqlQuote(String(input.saveStatus || 'saved'))},
  ${sqlQuote(String(input.errorText || '').trim() || null)},
  ${sqlQuote(safeJson(input.meta || {}))},
  ${sqlQuote(createdAt)}
);
`,
    );

    return runSqlJson(dbPath, 'SELECT * FROM vocab_logs ORDER BY id DESC LIMIT 1;')[0] || null;
}

function summarizeVocab(options = {}) {
    const dbPath = ensureStorage(options);
    return runSqlJson(
        dbPath,
        `
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN save_status = 'saved' THEN 1 ELSE 0 END) AS saved,
  SUM(CASE WHEN save_status = 'failed' THEN 1 ELSE 0 END) AS failed
FROM vocab_logs;
`,
    )[0] || { total: 0, saved: 0, failed: 0 };
}

function recordMediaPlace(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const now = String(input.createdAt || nowIso());
    const title = normalizeSpace(input.title);
    if (!title) throw new Error('title is required');

    runSql(
        dbPath,
        `
INSERT INTO media_place_logs (
  event_id, kind, title, status, rating, memo, tags_json, visit_date, created_at, updated_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(String(input.kind || 'media').trim().toLowerCase() || 'media')},
  ${sqlQuote(title)},
  ${sqlQuote(String(input.status || '').trim() || null)},
  ${sqlQuote(input.rating == null ? null : Number(input.rating))},
  ${sqlQuote(String(input.memo || '').trim() || null)},
  ${sqlQuote(safeJson(Array.isArray(input.tags) ? input.tags : []))},
  ${sqlQuote(String(input.visitDate || '').trim() || toIsoDate(now))},
  ${sqlQuote(now)},
  ${sqlQuote(now)}
);
`,
    );

    return runSqlJson(dbPath, 'SELECT * FROM media_place_logs ORDER BY id DESC LIMIT 1;')[0] || null;
}

function listMediaPlace(kind, options = {}) {
    const dbPath = ensureStorage(options);
    const normalizedKind = String(kind || '').trim().toLowerCase();
    const where = normalizedKind ? `WHERE kind = ${sqlQuote(normalizedKind)}` : '';
    return runSqlJson(
        dbPath,
        `
SELECT id, kind, title, status, rating, memo, tags_json, visit_date, updated_at
FROM media_place_logs
${where}
ORDER BY visit_date DESC, id DESC
LIMIT ${Math.max(1, Number(options.limit || 20))};
`,
    );
}

function summarizeMediaPlace(kind, options = {}) {
    const dbPath = ensureStorage(options);
    const normalizedKind = String(kind || '').trim().toLowerCase();
    const where = normalizedKind ? `WHERE kind = ${sqlQuote(normalizedKind)}` : '';

    const totals = runSqlJson(
        dbPath,
        `
SELECT COUNT(*) AS count,
       AVG(rating) AS avg_rating
FROM media_place_logs
${where};
`,
    )[0] || { count: 0, avg_rating: null };

    const byStatus = runSqlJson(
        dbPath,
        `
SELECT COALESCE(status, 'unknown') AS status, COUNT(*) AS count
FROM media_place_logs
${where}
GROUP BY COALESCE(status, 'unknown')
ORDER BY count DESC;
`,
    );

    return { totals, byStatus };
}

function appendSyncAudit(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const createdAt = String(input.createdAt || nowIso());
    runSql(
        dbPath,
        `
INSERT INTO sync_audit (
  event_id, sync_target, sync_action, status, payload_json, error_text, created_at
)
VALUES (
  ${sqlQuote(String(input.eventId || '').trim() || null)},
  ${sqlQuote(String(input.syncTarget || 'notion').trim())},
  ${sqlQuote(String(input.syncAction || 'prepare').trim())},
  ${sqlQuote(String(input.status || 'ok').trim())},
  ${sqlQuote(safeJson(input.payload || {}))},
  ${sqlQuote(String(input.errorText || '').trim() || null)},
  ${sqlQuote(createdAt)}
);
`,
    );
    return runSqlJson(dbPath, 'SELECT * FROM sync_audit ORDER BY id DESC LIMIT 1;')[0] || null;
}

function pruneRawEvents(input = {}, options = {}) {
    const dbPath = ensureStorage(options);
    const days = Math.max(1, Number(input.days || DEFAULT_RETAIN_DAYS));
    const cutoff = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();

    const before = runSqlJson(
        dbPath,
        `SELECT COUNT(*) AS count FROM event_inbox WHERE raw_text IS NOT NULL AND created_at < ${sqlQuote(cutoff)};`,
    )[0] || { count: 0 };

    if (input.apply) {
        runSql(
            dbPath,
            `
UPDATE event_inbox
SET raw_text = NULL
WHERE raw_text IS NOT NULL
  AND created_at < ${sqlQuote(cutoff)};
`,
        );
    }

    const after = runSqlJson(
        dbPath,
        `SELECT COUNT(*) AS count FROM event_inbox WHERE raw_text IS NOT NULL AND created_at < ${sqlQuote(cutoff)};`,
    )[0] || { count: 0 };

    return {
        cutoff,
        days,
        candidates: Number(before.count || 0),
        remaining: Number(after.count || 0),
        purged: Number(before.count || 0) - Number(after.count || 0),
        applied: Boolean(input.apply),
    };
}

module.exports = {
    DEFAULT_RETAIN_DAYS,
    DEFAULT_FX_TO_JPY,
    nowIso,
    toIsoDate,
    normalizeSpace,
    normalizeRoute,
    sha256,
    buildEventId,
    getDbPath,
    ensureStorage,
    createEvent,
    markEventFailed,
    getFxRateToJpy,
    convertToJpy,
    insertLedgerEntry,
    summarizeLedger,
    createTask,
    listTasks,
    findTaskByToken,
    updateTaskStatus,
    archiveTask,
    summarizeTasks,
    upsertRoutineTemplate,
    listRoutineTemplates,
    findRoutineTemplate,
    setRoutineTemplateActive,
    logRoutineCheckin,
    summarizeRoutine,
    recordWorkout,
    summarizeWorkout,
    recordVocabLog,
    summarizeVocab,
    recordMediaPlace,
    listMediaPlace,
    summarizeMediaPlace,
    appendSyncAudit,
    pruneRawEvents,
    runSql,
    runSqlJson,
    sqlQuote,
};
