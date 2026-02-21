const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { STAGING_PATH } = require('./conversation_capture');
const { assertNotionDbWriteAllowed } = require('./notion_guard');
const { loadRuntimeEnv } = require('./env_runtime');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');
const DATA_DIR = process.env.CONVERSATION_DATA_DIR
    ? path.resolve(String(process.env.CONVERSATION_DATA_DIR))
    : path.join(ROOT, 'data', 'conversation');
const PENDING_DIR = path.join(DATA_DIR, 'pending_batches');
const APPLIED_IDS_PATH = path.join(DATA_DIR, 'applied_ids.json');
const STATE_PATH = path.join(DATA_DIR, 'sync_state.json');
const HISTORY_PATH = path.join(ROOT, 'logs', 'notion_conversation_sync_history.jsonl');
const ALERT_HISTORY_PATH = path.join(ROOT, 'logs', 'notion_conversation_alerts.jsonl');
const ALERT_LATEST_PATH = path.join(ROOT, 'logs', 'notion_conversation_alert_latest.json');
const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function ensureDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(ALERT_HISTORY_PATH), { recursive: true });
}

function readJson(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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

function appendHistory(entry) {
    ensureDirs();
    const row = {
        timestamp: new Date().toISOString(),
        ...entry,
    };
    fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(row)}\n`, 'utf8');
}

function appendAlert(entry) {
    ensureDirs();
    const row = {
        timestamp: new Date().toISOString(),
        ...entry,
    };
    fs.appendFileSync(ALERT_HISTORY_PATH, `${JSON.stringify(row)}\n`, 'utf8');
    writeJson(ALERT_LATEST_PATH, row);
    return row;
}

function buildFailureAlert({ code = 'SYNC_FAILED', message = '', action = 'apply' } = {}) {
    const detail = String(message || '').trim();
    if (code === 'APPROVAL_REQUIRED') {
        return {
            code: 'NOTION_CONVERSATION_APPROVAL_REQUIRED',
            severity: 'warning',
            summary: 'Notion conversation apply blocked: approval token is required.',
            action,
            detail,
            remediation: 'Run prepare first, then apply with --approval <nonce>.',
        };
    }
    if (/missing config:\s*NOTION_API_KEY/i.test(detail)) {
        return {
            code: 'NOTION_CONVERSATION_ENV_MISSING',
            severity: 'error',
            summary: 'Notion conversation sync failed: required environment variables are missing.',
            action,
            detail,
            remediation: 'Set NOTION_API_KEY and NOTION_CONVERSATION_DB_ID (or NOTION_LOG_DATABASE_ID).',
        };
    }
    return {
        code: 'NOTION_CONVERSATION_SYNC_FAILED',
        severity: 'error',
        summary: 'Notion conversation sync failed.',
        action,
        detail,
        remediation: 'Check logs/notion_conversation_sync_history.jsonl and retry after fixing root cause.',
    };
}

function maybeQueueAlertMessage(alert) {
    if (String(process.env.NOTION_CONVERSATION_ALERT_TELEGRAM || '1') === '0') return false;
    const lines = [
        '[ALERT] Notion conversation sync',
        `- code: ${alert.code}`,
        `- severity: ${alert.severity}`,
        `- summary: ${alert.summary}`,
        `- remediation: ${alert.remediation}`,
    ];
    if (alert.detail) {
        lines.push(`- detail: ${String(alert.detail).slice(0, 280)}`);
    }
    const message = lines.join('\n');
    try {
        const { enqueueBridgePayload } = require('./bridge_queue');
        enqueueBridgePayload({
            taskId: `notion-conv-alert-${Date.now()}`,
            command: `[NOTIFY] ${message}`,
            timestamp: new Date().toISOString(),
            status: 'pending',
            source: 'notion-conversation-sync',
        });
        return true;
    } catch (_) {
        return false;
    }
}

function sha256(input) {
    return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function parseCliArgs(argv) {
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

function readAppliedIds() {
    const parsed = readJson(APPLIED_IDS_PATH, { ids: [] });
    return new Set(Array.isArray(parsed.ids) ? parsed.ids.map((v) => String(v)) : []);
}

function writeAppliedIds(idSet) {
    writeJson(APPLIED_IDS_PATH, { ids: [...idSet] });
}

function listPendingBatchFiles() {
    ensureDirs();
    return fs.readdirSync(PENDING_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(PENDING_DIR, name));
}

function readPendingBatches() {
    return listPendingBatchFiles().map((filePath) => readJson(filePath, null)).filter(Boolean);
}

function toIsoOrNull(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function inRange(iso, startIso, endIso) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return false;
    if (startIso && t < new Date(startIso).getTime()) return false;
    if (endIso && t > new Date(endIso).getTime()) return false;
    return true;
}

function updateSyncState(patch = {}) {
    const prev = readJson(STATE_PATH, {
        pendingApprovalCount: 0,
        approvedBatchCount: 0,
        blockedByPolicyCount: 0,
        lastPreparedAt: null,
        lastAppliedAt: null,
        lastBatchId: null,
    });
    const next = { ...prev, ...patch };
    writeJson(STATE_PATH, next);
    return next;
}

function computePendingApprovalCount() {
    const batches = readPendingBatches();
    return batches.reduce((acc, batch) => acc + (Array.isArray(batch.records) ? batch.records.length : 0), 0);
}

function buildBatchId() {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `conv-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function createPendingBatch(records, options = {}) {
    const batchId = buildBatchId();
    const from = options.from || null;
    const to = options.to || null;
    const hashInput = records.map((r) => `${r.id}:${r.messageHash || ''}`).join('|');
    const approvalNonce = sha256(`${batchId}:${records.length}:${hashInput}`).slice(0, 24);
    const batch = {
        batchId,
        approvalNonce,
        createdAt: new Date().toISOString(),
        from,
        to,
        count: records.length,
        records,
    };
    const filePath = path.join(PENDING_DIR, `${batchId}.json`);
    writeJson(filePath, batch);
    return batch;
}

function prepareBatch(options = {}) {
    ensureDirs();
    const startIso = toIsoOrNull(options.from);
    const endIso = toIsoOrNull(options.to);
    const limit = Math.max(1, Number(options.limit || 300));
    const appliedIds = readAppliedIds();
    const staged = readJsonl(STAGING_PATH);
    const filtered = staged
        .filter((row) => row && row.id && !appliedIds.has(String(row.id)))
        .filter((row) => inRange(row.timestamp, startIso, endIso))
        .slice(0, limit);
    if (filtered.length === 0) {
        const pendingCount = computePendingApprovalCount();
        const state = updateSyncState({
            pendingApprovalCount: pendingCount,
            lastPreparedAt: new Date().toISOString(),
        });
        const out = {
            ok: true,
            action: 'prepare',
            batchCreated: false,
            count: 0,
            pendingApprovalCount: state.pendingApprovalCount,
        };
        appendHistory(out);
        return out;
    }
    const batch = createPendingBatch(filtered, { from: startIso, to: endIso });
    const pendingCount = computePendingApprovalCount();
    const state = updateSyncState({
        pendingApprovalCount: pendingCount,
        lastPreparedAt: new Date().toISOString(),
        lastBatchId: batch.batchId,
    });
    const out = {
        ok: true,
        action: 'prepare',
        batchCreated: true,
        batchId: batch.batchId,
        count: batch.count,
        requiresApproval: true,
        approvalNonce: batch.approvalNonce,
        pendingApprovalCount: state.pendingApprovalCount,
    };
    appendHistory(out);
    return out;
}

function notionClient(token) {
    return axios.create({
        baseURL: NOTION_BASE,
        timeout: 30000,
        headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
        },
    });
}

async function withRetry(label, fn, { retries = 2, baseDelayMs = 300 } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastErr = error;
            const status = error && error.response && error.response.status;
            const retryable = !status || status === 429 || status >= 500;
            if (!retryable || attempt > retries) break;
            const delay = Math.min(baseDelayMs * (2 ** (attempt - 1)), 4000);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw new Error(`${label}_failed: ${lastErr ? lastErr.message : 'unknown'}`);
}

function truncate(value, max = 1900) {
    return String(value || '').slice(0, max);
}

function titleRichText(value) {
    return [{ type: 'text', text: { content: truncate(value, 2000) } }];
}

function findPropertyName(properties, candidates = [], expectedType = '') {
    const entries = Object.entries(properties || {});
    const names = candidates.map((x) => String(x || '').toLowerCase());
    for (const [name, info] of entries) {
        const lname = String(name || '').toLowerCase();
        if (!names.includes(lname)) continue;
        if (expectedType && String(info.type || '').toLowerCase() !== expectedType.toLowerCase()) continue;
        return name;
    }
    return null;
}

function findTitlePropertyName(properties = {}) {
    for (const [name, info] of Object.entries(properties)) {
        if (String(info.type || '').toLowerCase() === 'title') return name;
    }
    return null;
}

function setPropertyIfPresent(out, properties, candidates, value, type) {
    const name = findPropertyName(properties, candidates, type);
    if (!name || value == null || value === '') return;
    const text = truncate(value, 1800);
    if (type === 'rich_text') {
        out[name] = { rich_text: titleRichText(text) };
        return;
    }
    if (type === 'select') {
        out[name] = { select: { name: truncate(text, 100) } };
        return;
    }
    if (type === 'date') {
        out[name] = { date: { start: String(value) } };
        return;
    }
    if (type === 'checkbox') {
        out[name] = { checkbox: Boolean(value) };
    }
}

function buildPagePayload(record, database) {
    const props = {};
    const schemaProps = database.properties || {};
    const titlePropertyName = findTitlePropertyName(schemaProps);
    if (!titlePropertyName) {
        throw new Error('database has no title property');
    }
    const title = truncate(record.message || record.route || 'conversation-log', 120);
    props[titlePropertyName] = { title: titleRichText(title) };
    setPropertyIfPresent(props, schemaProps, ['timestamp', 'time', 'createdat', 'created_at'], record.timestamp, 'date');
    setPropertyIfPresent(props, schemaProps, ['source'], record.source, 'select');
    setPropertyIfPresent(props, schemaProps, ['source'], record.source, 'rich_text');
    setPropertyIfPresent(props, schemaProps, ['route'], record.route, 'select');
    setPropertyIfPresent(props, schemaProps, ['route'], record.route, 'rich_text');
    setPropertyIfPresent(props, schemaProps, ['message', 'content'], record.message, 'rich_text');
    setPropertyIfPresent(props, schemaProps, ['messagehash', 'message_hash', 'hash'], record.messageHash, 'rich_text');
    setPropertyIfPresent(props, schemaProps, ['skillhint', 'skill_hint'], record.skillHint, 'rich_text');
    setPropertyIfPresent(props, schemaProps, ['approvalstate', 'approval_state'], 'approved', 'select');
    setPropertyIfPresent(props, schemaProps, ['approvalstate', 'approval_state'], 'approved', 'rich_text');
    setPropertyIfPresent(props, schemaProps, ['batchid', 'batch_id'], record.batchId, 'rich_text');
    setPropertyIfPresent(props, schemaProps, ['portfoliocandidate', 'portfolio_candidate'], false, 'checkbox');
    return {
        parent: { database_id: database.id },
        properties: props,
        children: [
            {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: titleRichText(record.message || ''),
                },
            },
        ],
    };
}

function resolveBatchForApply({ batchId = '', approval = '' }) {
    const batches = readPendingBatches();
    if (batchId) {
        const found = batches.find((batch) => String(batch.batchId) === String(batchId));
        if (!found) throw new Error(`batch not found: ${batchId}`);
        return found;
    }
    const found = batches.find((batch) => String(batch.approvalNonce) === String(approval));
    if (!found) throw new Error('no pending batch for approval token');
    return found;
}

async function applyBatch(options = {}) {
    loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true });
    const approval = String(options.approval || '').trim();
    if (!approval) {
        const err = new Error('APPROVAL_REQUIRED: pass --approval <nonce>');
        err.code = 'APPROVAL_REQUIRED';
        throw err;
    }

    assertNotionDbWriteAllowed({ approvalToken: approval, action: 'conversation_db_write' });
    const batch = resolveBatchForApply({ batchId: options.batch, approval });
    if (String(batch.approvalNonce) !== approval) {
        const err = new Error('APPROVAL_REQUIRED: approval token does not match batch nonce');
        err.code = 'APPROVAL_REQUIRED';
        throw err;
    }

    const token = String(process.env.NOTION_API_KEY || '').trim();
    const config = readJson(CONFIG_PATH, {});
    const configDatabaseId = String(
        (config && config.governance && config.governance.notionConversationDatabaseId) || '',
    ).trim();
    const databaseId = String(
        process.env.NOTION_CONVERSATION_DB_ID
        || process.env.NOTION_LOG_DATABASE_ID
        || configDatabaseId
        || '',
    ).trim();
    if (!token || !databaseId) {
        throw new Error('missing config: NOTION_API_KEY and NOTION_CONVERSATION_DB_ID (or NOTION_LOG_DATABASE_ID or governance.notionConversationDatabaseId)');
    }

    const client = notionClient(token);
    const dbResponse = await withRetry('fetch_database', () => client.get(`/databases/${databaseId}`));
    const database = dbResponse && dbResponse.data ? dbResponse.data : null;
    if (!database || !database.id) {
        throw new Error('failed to load notion database schema');
    }

    const success = [];
    const failed = [];
    for (const row of batch.records || []) {
        const record = { ...row, batchId: batch.batchId };
        try {
            const payload = buildPagePayload(record, database);
            const created = await withRetry('create_page', () => client.post('/pages', payload));
            success.push({
                id: row.id,
                notionPageId: created && created.data ? created.data.id : null,
            });
        } catch (error) {
            failed.push({
                id: row.id,
                reason: String(error && error.message ? error.message : error),
            });
        }
    }

    const appliedIds = readAppliedIds();
    for (const row of success) appliedIds.add(String(row.id));
    writeAppliedIds(appliedIds);

    const batchPath = path.join(PENDING_DIR, `${batch.batchId}.json`);
    if (failed.length === 0) {
        if (fs.existsSync(batchPath)) fs.unlinkSync(batchPath);
    } else {
        const failedSet = new Set(failed.map((r) => String(r.id)));
        const remaining = (batch.records || []).filter((r) => failedSet.has(String(r.id)));
        writeJson(batchPath, {
            ...batch,
            records: remaining,
            count: remaining.length,
            updatedAt: new Date().toISOString(),
        });
    }

    const pendingApprovalCount = computePendingApprovalCount();
    const prevState = readJson(STATE_PATH, { approvedBatchCount: 0 });
    const state = updateSyncState({
        pendingApprovalCount,
        approvedBatchCount: Number(prevState.approvedBatchCount || 0) + (failed.length === 0 ? 1 : 0),
        lastAppliedAt: new Date().toISOString(),
        lastBatchId: batch.batchId,
    });

    const out = {
        ok: failed.length === 0,
        action: 'apply',
        batchId: batch.batchId,
        attempted: (batch.records || []).length,
        synced: success.length,
        failed: failed.length,
        failedRows: failed,
        pendingApprovalCount: state.pendingApprovalCount,
        approvedBatchCount: state.approvedBatchCount,
    };
    appendHistory(out);
    return out;
}

async function main() {
    try {
        const args = parseCliArgs(process.argv.slice(2));
        const action = String(args._[0] || '').trim().toLowerCase();
        if (!action || !['prepare', 'apply'].includes(action)) {
            console.error('Usage: node scripts/notion_conversation_sync.js <prepare|apply> [--from ISO] [--to ISO] [--approval NONCE] [--batch BATCH_ID]');
            process.exit(1);
        }

        if (action === 'prepare') {
            const out = prepareBatch({
                from: args.from || '',
                to: args.to || '',
                limit: args.limit || '',
            });
            console.log(JSON.stringify(out, null, 2));
            return;
        }

        const out = await applyBatch({
            approval: args.approval || '',
            batch: args.batch || '',
        });
        console.log(JSON.stringify(out, null, 2));
    } catch (error) {
        const message = String(error && error.message ? error.message : error);
        const code = error && error.code ? error.code : 'SYNC_FAILED';
        const state = readJson(STATE_PATH, { blockedByPolicyCount: 0 });
        if (code === 'APPROVAL_REQUIRED' || code === 'DB_META_MUTATION_BLOCKED') {
            updateSyncState({
                blockedByPolicyCount: Number(state.blockedByPolicyCount || 0) + 1,
            });
        }
        const alert = buildFailureAlert({ code, message, action: 'apply' });
        const queued = maybeQueueAlertMessage(alert);
        appendAlert({ ...alert, queued });
        appendHistory({
            ok: false,
            action: 'apply',
            reason: code,
            detail: message,
            alertCode: alert.code,
            remediation: alert.remediation,
            alertQueued: queued,
        });
        console.error(`${code}: ${message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    parseCliArgs,
    prepareBatch,
    applyBatch,
    buildPagePayload,
    updateSyncState,
};
