#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const storage = require('./personal_storage');
const { assertNotionDbWriteAllowed } = require('./notion_guard');
const { loadRuntimeEnv } = require('./env_runtime');

loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: false });

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'personal_sync');
const PENDING_DIR = path.join(DATA_DIR, 'pending_batches');
const APPLIED_DIR = path.join(DATA_DIR, 'applied_batches');
const HISTORY_PATH = path.join(ROOT, 'logs', 'notion_personal_sync_history.jsonl');
const ALERT_LATEST_PATH = path.join(ROOT, 'logs', 'notion_personal_sync_alert_latest.json');

function ensureDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.mkdirSync(APPLIED_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
}

function nowIso() {
    return new Date().toISOString();
}

function readJson(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function appendHistory(entry) {
    ensureDirs();
    const row = {
        timestamp: nowIso(),
        ...entry,
    };
    fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(row)}\n`, 'utf8');
}

function updateAlertLatest(entry) {
    writeJson(ALERT_LATEST_PATH, {
        timestamp: nowIso(),
        ...entry,
    });
}

function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    const out = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
        const token = String(args[i] || '');
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = args[i + 1];
            if (next != null && !String(next).startsWith('--')) {
                out[key] = String(next);
                i += 1;
            } else {
                out[key] = '1';
            }
            continue;
        }
        out._.push(token);
    }
    return out;
}

function buildBatchId() {
    const stamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `psync-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function createApprovalToken(batchId, records) {
    const payload = `${batchId}:${records.length}:${JSON.stringify(records).slice(0, 1000)}`;
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 24);
}

function summarizeSnapshot() {
    const now = nowIso();
    const month = now.slice(0, 7);

    const ledger = storage.summarizeLedger({ month });
    const tasks = storage.summarizeTasks();
    const routines = storage.summarizeRoutine({ month });
    const workouts = storage.summarizeWorkout({ month });
    const vocab = storage.summarizeVocab();
    const media = storage.summarizeMediaPlace('media');
    const places = storage.summarizeMediaPlace('place');

    return [
        {
            key: 'ledger_month',
            month,
            count: Number(ledger.totals && ledger.totals.count || 0),
            expense_jpy: Number(ledger.totals && ledger.totals.expense_jpy || 0),
            income_jpy: Number(ledger.totals && ledger.totals.income_jpy || 0),
            net_jpy: Number(ledger.totals && ledger.totals.net_jpy || 0),
        },
        {
            key: 'todo',
            open: Number(tasks.totals && tasks.totals.open || 0),
            done: Number(tasks.totals && tasks.totals.done || 0),
        },
        {
            key: 'routine_month',
            month,
            checkins: Number(routines.totals && routines.totals.checkins || 0),
            active_days: Number(routines.totals && routines.totals.active_days || 0),
        },
        {
            key: 'workout_month',
            month,
            sessions: Number(workouts.totals && workouts.totals.sessions || 0),
            total_duration_min: Number(workouts.totals && workouts.totals.total_duration_min || 0),
        },
        {
            key: 'vocab',
            total: Number(vocab.total || 0),
            saved: Number(vocab.saved || 0),
            failed: Number(vocab.failed || 0),
        },
        {
            key: 'media',
            count: Number(media.totals && media.totals.count || 0),
            avg_rating: media.totals && media.totals.avg_rating == null ? null : Number(media.totals.avg_rating),
        },
        {
            key: 'place',
            count: Number(places.totals && places.totals.count || 0),
            avg_rating: places.totals && places.totals.avg_rating == null ? null : Number(places.totals.avg_rating),
        },
    ];
}

function buildPrepareResult() {
    ensureDirs();
    const records = summarizeSnapshot();
    const batchId = buildBatchId();
    const approvalToken = createApprovalToken(batchId, records);
    const batch = {
        batchId,
        approvalToken,
        createdAt: nowIso(),
        records,
    };
    const filePath = path.join(PENDING_DIR, `${batchId}.json`);
    writeJson(filePath, batch);

    storage.appendSyncAudit({
        eventId: null,
        syncTarget: 'notion_personal',
        syncAction: 'prepare',
        status: 'ok',
        payload: { batchId, count: records.length },
    });

    const result = {
        ok: true,
        action: 'prepare',
        batchId,
        approvalToken,
        count: records.length,
        pendingPath: filePath,
        telegramReply: [
            'Notion personal sync 준비 완료',
            `- batch: ${batchId}`,
            `- count: ${records.length}`,
            `- apply: node scripts/notion_personal_sync.js apply --batch ${batchId} --approval ${approvalToken}`,
        ].join('\n'),
    };

    appendHistory(result);
    return result;
}

function listPendingBatchFiles() {
    ensureDirs();
    return fs.readdirSync(PENDING_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(PENDING_DIR, name))
        .sort();
}

function findBatch(batchId = '') {
    const files = listPendingBatchFiles();
    if (!files.length) return null;

    if (batchId) {
        const target = files.find((filePath) => path.basename(filePath, '.json') === batchId);
        if (!target) return null;
        return readJson(target, null);
    }

    return readJson(files[files.length - 1], null);
}

function renderBatchMarkdown(batch) {
    const lines = [];
    lines.push(`# Personal Sync Snapshot`);
    lines.push(`- batch: ${batch.batchId}`);
    lines.push(`- createdAt: ${batch.createdAt}`);
    lines.push('');
    for (const record of batch.records || []) {
        lines.push(`- ${record.key}: ${JSON.stringify(record)}`);
    }
    return lines.join('\n');
}

async function optionalNotionWrite(batch) {
    const token = String(process.env.NOTION_PERSONAL_API_KEY || process.env.NOTION_API_KEY || '').trim();
    const dbId = String(process.env.NOTION_PERSONAL_DB_ID || process.env.NOTION_LOG_DATABASE_ID || '').trim();
    if (!token || !dbId) {
        const missing = [];
        if (!token) missing.push('NOTION_PERSONAL_API_KEY');
        if (!dbId) missing.push('NOTION_PERSONAL_DB_ID|NOTION_LOG_DATABASE_ID');
        return {
            attempted: false,
            applied: false,
            reason: `missing_env:${missing.join(',')}`,
        };
    }

    const dbMeta = await axios.get(`https://api.notion.com/v1/databases/${dbId}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
        },
        timeout: 12000,
        validateStatus: () => true,
    });
    if (dbMeta.status < 200 || dbMeta.status >= 300) {
        throw new Error(`notion_db_meta_http_${dbMeta.status}`);
    }
    const properties = (dbMeta.data && typeof dbMeta.data === 'object' && dbMeta.data.properties)
        ? dbMeta.data.properties
        : {};
    const titlePropertyName = Object.entries(properties)
        .find(([, value]) => value && value.type === 'title')?.[0] || 'Name';

    const markdown = renderBatchMarkdown(batch);
    const title = `Personal Sync ${batch.batchId}`;
    const payload = {
        parent: { database_id: dbId },
        properties: {
            [titlePropertyName]: {
                title: [{ text: { content: title } }],
            },
        },
        children: [
            {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{ type: 'text', text: { content: markdown.slice(0, 1900) } }],
                },
            },
        ],
    };

    const res = await axios.post('https://api.notion.com/v1/pages', payload, {
        headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
        },
        timeout: 12000,
        validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
        const reason = res.data && typeof res.data === 'object'
            ? (res.data.message || res.data.code || '')
            : '';
        throw new Error(`notion_http_${res.status}${reason ? `:${reason}` : ''}`);
    }

    return {
        attempted: true,
        applied: true,
        pageId: res.data && res.data.id ? res.data.id : null,
    };
}

async function applyBatch({ batchId = '', approval = '' } = {}) {
    ensureDirs();
    const batch = findBatch(batchId);
    if (!batch) {
        const out = {
            ok: false,
            action: 'apply',
            errorCode: 'BATCH_NOT_FOUND',
            telegramReply: '적용할 personal sync 배치를 찾지 못했어. 먼저 prepare를 실행해줘.',
        };
        appendHistory(out);
        updateAlertLatest(out);
        return out;
    }

    const providedApproval = String(approval || '').trim();
    if (!providedApproval || providedApproval !== String(batch.approvalToken || '').trim()) {
        const out = {
            ok: false,
            action: 'apply',
            batchId: batch.batchId,
            errorCode: 'APPROVAL_REQUIRED',
            telegramReply: '승인 토큰이 없거나 일치하지 않아 apply를 차단했어.',
        };
        appendHistory(out);
        updateAlertLatest(out);
        return out;
    }

    try {
        assertNotionDbWriteAllowed({ approvalToken: providedApproval, action: 'personal_sync_apply' });
    } catch (error) {
        const out = {
            ok: false,
            action: 'apply',
            batchId: batch.batchId,
            errorCode: error.code || 'APPROVAL_REQUIRED',
            telegramReply: `Notion apply 차단: ${error.message || error}`,
        };
        appendHistory(out);
        updateAlertLatest(out);
        return out;
    }

    try {
        const notion = await optionalNotionWrite(batch);
        const srcPath = path.join(PENDING_DIR, `${batch.batchId}.json`);
        const dstPath = path.join(APPLIED_DIR, `${batch.batchId}.json`);
        if (fs.existsSync(srcPath)) fs.renameSync(srcPath, dstPath);

        storage.appendSyncAudit({
            eventId: null,
            syncTarget: 'notion_personal',
            syncAction: 'apply',
            status: 'ok',
            payload: {
                batchId: batch.batchId,
                count: Array.isArray(batch.records) ? batch.records.length : 0,
                notion,
            },
        });

        const out = {
            ok: true,
            action: 'apply',
            batchId: batch.batchId,
            count: Array.isArray(batch.records) ? batch.records.length : 0,
            notion,
            telegramReply: [
                'Notion personal sync 적용 완료',
                `- batch: ${batch.batchId}`,
                `- notion write: ${notion.attempted ? (notion.applied ? 'applied' : 'failed') : 'skipped(missing env)'}`,
            ].join('\n'),
        };

        appendHistory(out);
        return out;
    } catch (error) {
        storage.appendSyncAudit({
            eventId: null,
            syncTarget: 'notion_personal',
            syncAction: 'apply',
            status: 'failed',
            errorText: String(error && error.message ? error.message : error),
            payload: { batchId: batch.batchId },
        });

        const out = {
            ok: false,
            action: 'apply',
            batchId: batch.batchId,
            errorCode: 'APPLY_FAILED',
            telegramReply: `Notion personal sync 적용 실패: ${error && error.message ? error.message : error}`,
        };
        appendHistory(out);
        updateAlertLatest(out);
        return out;
    }
}

async function runCommand(argv = process.argv.slice(2)) {
    const parsed = parseArgs(argv);
    const cmd = String(parsed._[0] || 'prepare').trim().toLowerCase();

    if (cmd === 'prepare') {
        return buildPrepareResult();
    }

    if (cmd === 'apply') {
        return applyBatch({
            batchId: String(parsed.batch || '').trim(),
            approval: String(parsed.approval || '').trim(),
        });
    }

    return {
        ok: false,
        action: 'unknown',
        errorCode: 'UNKNOWN_COMMAND',
        telegramReply: `알 수 없는 명령: ${cmd}. 사용법: prepare | apply --approval <token>`,
    };
}

async function main() {
    const result = await runCommand(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = {
    runCommand,
    buildPrepareResult,
    applyBatch,
};
