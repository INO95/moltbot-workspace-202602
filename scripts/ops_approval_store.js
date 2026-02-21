const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../data/config.json');
const approvalAuditLog = require('./approval_audit_log');

const ROOT = process.env.OPS_WORKSPACE_ROOT
    ? path.resolve(String(process.env.OPS_WORKSPACE_ROOT))
    : path.join(__dirname, '..');
const OPS_COMMANDS_ROOT = process.env.OPS_COMMANDS_ROOT
    ? path.resolve(String(process.env.OPS_COMMANDS_ROOT))
    : path.join(ROOT, 'ops', 'commands');
const COMMANDS_STATE_ROOT = process.env.OPS_COMMANDS_STATE_ROOT
    ? path.resolve(String(process.env.OPS_COMMANDS_STATE_ROOT))
    : path.join(OPS_COMMANDS_ROOT, 'state');
const APPROVAL_PENDING_DIR = path.join(COMMANDS_STATE_ROOT, 'pending');
const APPROVAL_CONSUMED_DIR = path.join(COMMANDS_STATE_ROOT, 'consumed');
const APPROVAL_GRANTS_DIR = path.join(COMMANDS_STATE_ROOT, 'grants');
const DEFAULT_PENDING_APPROVALS_STATE_PATH = process.env.OPS_PENDING_APPROVALS_STATE_PATH
    ? path.resolve(String(process.env.OPS_PENDING_APPROVALS_STATE_PATH))
    : path.join(ROOT, 'data', 'state', 'pending_approvals.json');

function nowIso() {
    return new Date().toISOString();
}

function makeError(code, message, extra = {}) {
    const error = new Error(message);
    error.code = code;
    for (const [key, value] of Object.entries(extra)) {
        error[key] = value;
    }
    return error;
}

function ensureLayout() {
    fs.mkdirSync(APPROVAL_PENDING_DIR, { recursive: true });
    fs.mkdirSync(APPROVAL_CONSUMED_DIR, { recursive: true });
    fs.mkdirSync(APPROVAL_GRANTS_DIR, { recursive: true });
}

function stableStringify(value) {
    if (value == null) return 'null';
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',');
        return `{${body}}`;
    }
    return JSON.stringify(value);
}

function buildPlanHashPayload(plan) {
    const src = (plan && typeof plan === 'object') ? plan : {};
    return {
        intent_action: src.intent_action || null,
        requested_by: src.requested_by || null,
        payload: (src.payload && typeof src.payload === 'object') ? src.payload : {},
        source_candidates: Array.isArray(src.source_candidates) ? src.source_candidates : [],
        target_path: src.target_path || null,
        risk_tier: src.risk_tier || null,
        mutating: Boolean(src.mutating),
        required_flags: normalizeFlags(src.required_flags || []),
        exact_paths: Array.isArray(src.exact_paths) ? src.exact_paths : [],
        operations: Array.isArray(src.operations) ? src.operations : [],
        rollback_instructions: Array.isArray(src.rollback_instructions) ? src.rollback_instructions : [],
    };
}

function hashPlanSnapshot(plan) {
    const payload = buildPlanHashPayload(plan);
    return crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function normalizeFlags(flags) {
    const out = [];
    const seen = new Set();
    for (const item of (Array.isArray(flags) ? flags : [])) {
        const key = String(item || '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

function makeToken() {
    const raw = crypto.randomBytes(8).toString('hex');
    return `apv_${raw}`;
}

function makeGrantId() {
    const raw = crypto.randomBytes(8).toString('hex');
    return `grt_${raw}`;
}

function resolveUnifiedApprovalsConfig() {
    const section = (config && typeof config.opsUnifiedApprovals === 'object')
        ? config.opsUnifiedApprovals
        : {};
    const pendingStateRaw = String(
        process.env.OPS_PENDING_APPROVALS_STATE_PATH
        || section.pendingStatePath
        || '',
    ).trim();
    const pendingStatePath = pendingStateRaw
        ? (path.isAbsolute(pendingStateRaw) ? pendingStateRaw : path.join(ROOT, pendingStateRaw))
        : DEFAULT_PENDING_APPROVALS_STATE_PATH;
    const ttlPolicy = (section.ttlPolicy && typeof section.ttlPolicy === 'object')
        ? section.ttlPolicy
        : {};
    const normalizeIdentityMode = (value) => {
        const key = String(value || '').trim().toLowerCase();
        if (key === 'strict_user_bot' || key === 'same_user_any_bot' || key === 'any_user_any_bot') {
            return key;
        }
        return 'strict_user_bot';
    };
    const identityMode = normalizeIdentityMode(
        process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE
        || section.identityMode
        || 'strict_user_bot',
    );
    return {
        enabled: section.enabled !== false,
        pendingStatePath,
        ttlPolicy,
        identityMode,
    };
}

function hashValue(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function redactValue(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
        return value
            .replace(/\b(Bearer\s+)[A-Za-z0-9._-]+\b/gi, '$1[REDACTED]')
            .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]');
    }
    if (Array.isArray(value)) return value.map((item) => redactValue(item));
    if (typeof value === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            const lower = String(key || '').toLowerCase();
            if (
                lower.includes('token')
                || lower.includes('secret')
                || lower.includes('password')
                || lower.includes('authorization')
                || lower.includes('cookie')
            ) {
                out[key] = '[REDACTED]';
                continue;
            }
            out[key] = redactValue(val);
        }
        return out;
    }
    return value;
}

function listApprovalFiles(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) return [];
        return fs.readdirSync(dirPath)
            .filter((name) => name.endsWith('.json'))
            .sort()
            .map((name) => path.join(dirPath, name));
    } catch (_) {
        return [];
    }
}

function parseTokenFromPath(filePath) {
    const base = path.basename(String(filePath || ''));
    const m = base.match(/^(apv_[a-f0-9]{16})\.json$/i);
    return m ? String(m[1]).trim() : '';
}

function deriveActionType(record) {
    const direct = String(record && (record.action_type || record.actionType) || '').trim().toLowerCase();
    if (direct) return direct;
    const plan = (record && record.plan && typeof record.plan === 'object') ? record.plan : {};
    if (String(plan.command_kind || '').trim().toLowerCase() === 'capability') {
        return String(plan.capability || 'capability').trim().toLowerCase() || 'capability';
    }
    return 'file_control';
}

function deriveRiskLevel(record) {
    const direct = String(record && (record.risk_level || record.riskLevel) || '').trim().toUpperCase();
    if (direct) return direct;
    const plan = (record && record.plan && typeof record.plan === 'object') ? record.plan : {};
    return String(plan.risk_tier || 'MEDIUM').trim().toUpperCase() || 'MEDIUM';
}

function deriveBotId(record) {
    const direct = String(record && (record.bot_id || record.botId) || '').trim();
    if (direct) return direct;
    return String(process.env.MOLTBOT_BOT_ID || 'unknown').trim() || 'unknown';
}

function derivePayload(record) {
    const plan = (record && record.plan && typeof record.plan === 'object') ? record.plan : {};
    const payload = (plan.payload && typeof plan.payload === 'object') ? plan.payload : {};
    return redactValue(payload);
}

function deriveStatus(record) {
    const key = String(record && record.status || '').trim().toLowerCase();
    if (key === 'pending' || key === 'consumed' || key === 'denied' || key === 'expired') return key;
    if (record && record.consumed_at) return 'consumed';
    return 'pending';
}

function deriveTtlSeconds(record) {
    const direct = Number(record && record.ttl_seconds);
    if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
    const createdMs = Date.parse(String(record && record.created_at || ''));
    const expiresMs = Date.parse(String(record && record.expires_at || ''));
    if (Number.isFinite(createdMs) && Number.isFinite(expiresMs) && expiresMs > createdMs) {
        return Math.floor((expiresMs - createdMs) / 1000);
    }
    return 0;
}

function toMirrorRecord(record, tokenOverride = '') {
    if (!record || typeof record !== 'object') return null;
    const token = String(tokenOverride || record.token || '').trim();
    if (!token) return null;
    return {
        id: token,
        created_at: String(record.created_at || '').trim() || null,
        expires_at: String(record.expires_at || '').trim() || null,
        ttl_seconds: deriveTtlSeconds(record),
        bot_id: deriveBotId(record),
        action_type: deriveActionType(record),
        payload: derivePayload(record),
        risk_level: deriveRiskLevel(record),
        requested_by: String(record.requested_by || '').trim() || 'unknown',
        status: deriveStatus(record),
        request_id: String(record.request_id || '').trim() || null,
        consumed_at: String(record.consumed_at || '').trim() || null,
        denied_at: String(record.denied_at || '').trim() || null,
        approved_by: String(record.approved_by || '').trim() || null,
        approved_bot_id: String(record.approved_bot_id || '').trim() || null,
        denied_by: String(record.denied_by || '').trim() || null,
        denied_bot_id: String(record.denied_bot_id || '').trim() || null,
    };
}

function buildPendingApprovalsSnapshot() {
    const pending = [];
    const history = [];
    const seen = new Set();

    for (const filePath of listApprovalFiles(APPROVAL_PENDING_DIR)) {
        const token = parseTokenFromPath(filePath);
        if (!token) continue;
        const record = readJson(filePath, null);
        const mirror = toMirrorRecord(record, token);
        if (!mirror) continue;
        seen.add(token);
        if (mirror.status === 'pending') {
            pending.push(mirror);
        } else {
            history.push(mirror);
        }
    }

    for (const filePath of listApprovalFiles(APPROVAL_CONSUMED_DIR)) {
        const token = parseTokenFromPath(filePath);
        if (!token || seen.has(token)) continue;
        const record = readJson(filePath, null);
        const mirror = toMirrorRecord(record, token);
        if (!mirror) continue;
        history.push(mirror);
    }

    history.sort((a, b) => String(b.consumed_at || b.created_at || '').localeCompare(String(a.consumed_at || a.created_at || '')));
    return {
        schema_version: '1.0',
        updated_at: nowIso(),
        pending,
        history: history.slice(0, 500),
    };
}

function syncPendingApprovalsMirror() {
    const unified = resolveUnifiedApprovalsConfig();
    if (!unified.enabled) return null;
    const snapshot = buildPendingApprovalsSnapshot();
    const current = readJson(unified.pendingStatePath, null);
    if (current && stableStringify(current) === stableStringify(snapshot)) {
        return snapshot;
    }
    writeJsonAtomic(unified.pendingStatePath, snapshot);
    return snapshot;
}

function expirePendingTokens() {
    ensureLayout();
    const now = Date.now();
    let changed = false;
    let scanned = 0;
    let expired = 0;
    let normalizedTerminal = 0;
    let movedToConsumed = 0;
    for (const filePath of listApprovalFiles(APPROVAL_PENDING_DIR)) {
        scanned += 1;
        const token = parseTokenFromPath(filePath);
        if (!token) continue;
        const record = readJson(filePath, null);
        if (!record || typeof record !== 'object') continue;
        const statusKey = String(record.status || '').trim().toLowerCase();
        const hasConsumedAt = Boolean(record.consumed_at);
        const hasDeniedAt = Boolean(record.denied_at);
        const terminalByStatus = statusKey === 'consumed' || statusKey === 'denied' || statusKey === 'expired';
        const terminalByFields = hasConsumedAt || hasDeniedAt;
        if (terminalByStatus || terminalByFields) {
            let normalizedStatus = statusKey;
            if (!terminalByStatus) {
                normalizedStatus = hasDeniedAt ? 'denied' : 'consumed';
            }
            const normalized = {
                ...record,
                status: normalizedStatus,
            };
            writeJsonAtomic(consumedTokenPath(token), normalized);
            fs.rmSync(filePath, { force: true });
            changed = true;
            movedToConsumed += 1;
            if (statusKey !== normalizedStatus) {
                normalizedTerminal += 1;
            }
            continue;
        }
        const expiresAtMs = Date.parse(String(record.expires_at || ''));
        if (!Number.isFinite(expiresAtMs) || expiresAtMs > now) continue;
        const expiredAt = nowIso();
        const updated = {
            ...record,
            status: 'expired',
            consumed_at: expiredAt,
            consumed_by: 'system:ttl',
            execution_request_id: record.execution_request_id || null,
        };
        writeJsonAtomic(consumedTokenPath(token), updated);
        fs.rmSync(filePath, { force: true });
        changed = true;
        expired += 1;
        approvalAuditLog.append('approval_decision', {
            decision: 'expired',
            token,
            token_hash: `tok_${hashValue(token).slice(0, 16)}`,
            action_type: deriveActionType(updated),
            risk_level: deriveRiskLevel(updated),
            requested_by: updated.requested_by || 'unknown',
            request_id: updated.request_id || null,
            actor_requested_by: 'system:ttl',
            actor_bot_id: 'system:ttl',
            token_owner_requested_by: updated.requested_by || 'unknown',
            token_owner_bot_id: updated.bot_id || 'unknown',
        });
    }
    if (changed) {
        syncPendingApprovalsMirror();
    }
    return {
        scanned,
        expired,
        normalizedTerminal,
        movedToConsumed,
        changed,
    };
}

function resolveConsumedTokenError(token, consumed) {
    const status = String(consumed && consumed.status || '').trim().toLowerCase();
    if (status === 'denied') {
        throw makeError('TOKEN_DENIED', 'Approval token was denied.', {
            token,
            denied_at: consumed.denied_at || consumed.consumed_at || null,
        });
    }
    if (status === 'expired') {
        throw makeError('TOKEN_EXPIRED', 'Approval token expired.', {
            token,
            expires_at: consumed.expires_at || null,
        });
    }
    throw makeError('TOKEN_CONSUMED', 'Approval token was already consumed.', {
        token,
        consumed_at: consumed && consumed.consumed_at ? consumed.consumed_at : null,
    });
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function writeJsonAtomic(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function tokenPath(token) {
    const key = String(token || '').trim();
    if (!/^apv_[a-f0-9]{16}$/i.test(key)) {
        throw makeError('TOKEN_INVALID_FORMAT', 'Invalid approval token format.');
    }
    return path.join(APPROVAL_PENDING_DIR, `${key}.json`);
}

function consumedTokenPath(token) {
    const key = String(token || '').trim();
    return path.join(APPROVAL_CONSUMED_DIR, `${key}.json`);
}

function normalizeRequester(value) {
    return String(value || '').trim();
}

function grantRecordPath(requestedBy) {
    const requester = normalizeRequester(requestedBy);
    if (!requester || requester === 'unknown') {
        throw makeError('REQUESTER_REQUIRED', 'Approval grant requester is required.');
    }
    const digest = crypto.createHash('sha256').update(requester, 'utf8').digest('hex');
    return path.join(APPROVAL_GRANTS_DIR, `${digest}.json`);
}

function resolveTtlSeconds(policy = {}, requested = null) {
    const unified = resolveUnifiedApprovalsConfig();
    const unifiedTtl = (unified.ttlPolicy && typeof unified.ttlPolicy === 'object')
        ? unified.ttlPolicy
        : {};
    const asPositive = (value, fallback) => {
        const num = Number(value);
        return Number.isFinite(num) && num > 0 ? num : fallback;
    };
    const defaults = {
        defaultTtlSeconds: asPositive(unifiedTtl.defaultTtlSeconds, 600),
        minTtlSeconds: asPositive(unifiedTtl.minTtlSeconds, 120),
        maxTtlSeconds: asPositive(unifiedTtl.maxTtlSeconds, 1800),
    };
    defaults.maxTtlSeconds = Math.max(defaults.minTtlSeconds, defaults.maxTtlSeconds);
    defaults.defaultTtlSeconds = Math.max(defaults.minTtlSeconds, Math.min(defaults.defaultTtlSeconds, defaults.maxTtlSeconds));
    const cfg = {
        ...defaults,
        ...((policy && typeof policy === 'object') ? policy : {}),
    };
    const wanted = requested != null
        ? Number(requested)
        : Number(cfg.defaultTtlSeconds || defaults.defaultTtlSeconds);
    if (!Number.isFinite(wanted) || wanted <= 0) {
        return defaults.defaultTtlSeconds;
    }
    return Math.max(Number(cfg.minTtlSeconds || defaults.minTtlSeconds), Math.min(wanted, Number(cfg.maxTtlSeconds || defaults.maxTtlSeconds)));
}

function resolveGrantTtlSeconds(policy = {}, requested = null) {
    const defaults = {
        defaultTtlSeconds: 1800,
        minTtlSeconds: 300,
        maxTtlSeconds: 7200,
    };
    const cfg = {
        ...defaults,
        ...((policy && typeof policy === 'object') ? policy : {}),
    };
    const wanted = requested != null
        ? Number(requested)
        : Number(cfg.defaultTtlSeconds || defaults.defaultTtlSeconds);
    if (!Number.isFinite(wanted) || wanted <= 0) {
        return defaults.defaultTtlSeconds;
    }
    return Math.max(
        Number(cfg.minTtlSeconds || defaults.minTtlSeconds),
        Math.min(wanted, Number(cfg.maxTtlSeconds || defaults.maxTtlSeconds)),
    );
}

function createApprovalToken(options = {}) {
    ensureLayout();
    expirePendingTokens();
    const token = makeToken();
    const createdAtMs = Date.now();
    const ttlSeconds = resolveTtlSeconds(options.ttlPolicy || {}, options.ttlSeconds);
    const expiresAt = new Date(createdAtMs + (ttlSeconds * 1000)).toISOString();

    const plan = options.plan || {};
    const planSnapshotHash = String(options.planSnapshotHash || hashPlanSnapshot(plan));
    const requiredFlags = normalizeFlags(options.requiredFlags || []);
    const actionType = String(options.actionType || options.action_type || deriveActionType({ plan }) || 'file_control').trim().toLowerCase() || 'file_control';
    const riskLevel = String(options.riskLevel || options.risk_level || plan.risk_tier || 'MEDIUM').trim().toUpperCase() || 'MEDIUM';
    const botId = String(options.botId || options.bot_id || process.env.MOLTBOT_BOT_ID || 'unknown').trim() || 'unknown';
    const requestedBy = String(options.requestedBy || options.requested_by || '').trim() || 'unknown';
    const record = {
        schema_version: '1.0',
        token,
        created_at: new Date(createdAtMs).toISOString(),
        expires_at: expiresAt,
        ttl_seconds: ttlSeconds,
        bot_id: botId,
        action_type: actionType,
        risk_level: riskLevel,
        required_flags: requiredFlags,
        requested_by: requestedBy,
        request_id: String(options.requestId || '').trim() || null,
        plan_snapshot_hash: planSnapshotHash,
        plan,
        plan_summary: options.planSummary || {},
        status: 'pending',
        denied_at: null,
        denied_by: null,
        denied_bot_id: null,
        consumed_at: null,
        consumed_by: null,
        approved_by: null,
        approved_bot_id: null,
        execution_request_id: null,
    };
    writeJsonAtomic(tokenPath(token), record);
    syncPendingApprovalsMirror();
    approvalAuditLog.append('approval_request_created', {
        token,
        action_type: actionType,
        risk_level: riskLevel,
        requested_by: record.requested_by,
        request_id: record.request_id,
        expires_at: record.expires_at,
        ttl_seconds: ttlSeconds,
        payload: derivePayload(record),
        actor_requested_by: record.requested_by,
        actor_bot_id: record.bot_id || 'unknown',
        token_owner_requested_by: record.requested_by,
        token_owner_bot_id: record.bot_id || 'unknown',
    });
    return record;
}

function readPendingToken(token) {
    ensureLayout();
    expirePendingTokens();
    return readJson(tokenPath(token), null);
}

function readConsumedToken(token) {
    ensureLayout();
    return readJson(consumedTokenPath(token), null);
}

function validateApproval(options = {}) {
    ensureLayout();
    const token = String(options.token || '').trim();
    if (!token) {
        throw makeError('TOKEN_REQUIRED', 'Approval token is required.');
    }
    expirePendingTokens();

    let record = null;
    try {
        record = readPendingToken(token);
    } catch (error) {
        if (error && error.code) throw error;
        throw makeError('TOKEN_INVALID_FORMAT', 'Invalid approval token format.');
    }
    if (!record) {
        const consumed = readConsumedToken(token);
        if (consumed) {
            resolveConsumedTokenError(token, consumed);
        }
        throw makeError('TOKEN_NOT_FOUND', 'Approval token was not found.', { token });
    }

    if (String(record.status || '').trim().toLowerCase() === 'denied') {
        throw makeError('TOKEN_DENIED', 'Approval token was denied.', {
            token,
            denied_at: record.denied_at || record.consumed_at || null,
        });
    }

    if (record.consumed_at) {
        resolveConsumedTokenError(token, record);
    }

    const nowMs = Date.now();
    const expiresAtMs = Date.parse(String(record.expires_at || ''));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        expirePendingTokens();
        throw makeError('TOKEN_EXPIRED', 'Approval token expired.', { token, expires_at: record.expires_at || null });
    }

    const requestedBy = String(options.requestedBy || options.requested_by || '').trim() || 'unknown';
    const actorBotId = String(options.botId || options.bot_id || process.env.MOLTBOT_BOT_ID || '').trim() || 'unknown';
    const expectedBotId = String(record.bot_id || '').trim() || 'unknown';
    const unified = resolveUnifiedApprovalsConfig();
    const identityMode = String(unified.identityMode || 'strict_user_bot').trim().toLowerCase();
    const expectedRequester = String(record.requested_by || '').trim() || 'unknown';
    if (identityMode !== 'any_user_any_bot' && requestedBy !== expectedRequester) {
        throw makeError('REQUESTER_MISMATCH', 'Approval requester does not match the plan requester.', {
            token,
            requested_by: requestedBy,
            expected_by: expectedRequester,
        });
    }
    if (identityMode === 'strict_user_bot' && actorBotId !== expectedBotId) {
        throw makeError('BOT_MISMATCH', 'Approval bot does not match the token owner bot.', {
            token,
            bot_id: actorBotId,
            expected_bot_id: expectedBotId,
        });
    }

    const providedFlags = normalizeFlags(options.providedFlags || []);
    const requiredFlags = normalizeFlags(record.required_flags || []);
    const missing = requiredFlags.filter((flag) => !providedFlags.includes(flag));
    if (missing.length > 0) {
        throw makeError('APPROVAL_FLAGS_REQUIRED', 'Approval is missing required flags.', {
            token,
            missing_flags: missing,
            required_flags: requiredFlags,
            provided_flags: providedFlags,
        });
    }

    return {
        token,
        record,
        identity_mode: identityMode,
        provided_flags: providedFlags,
    };
}

function consumeApproval(options = {}) {
    ensureLayout();
    expirePendingTokens();
    const token = String(options.token || '').trim();
    const pendingPath = tokenPath(token);
    const record = readJson(pendingPath, null);
    if (!record) {
        const consumed = readConsumedToken(token);
        if (consumed) resolveConsumedTokenError(token, consumed);
        throw makeError('TOKEN_NOT_FOUND', 'Approval token was not found.', { token });
    }
    if (String(record.status || '').trim().toLowerCase() === 'denied') {
        throw makeError('TOKEN_DENIED', 'Approval token was denied.', { token, denied_at: record.denied_at || record.consumed_at || null });
    }
    if (record.consumed_at) {
        resolveConsumedTokenError(token, record);
    }

    const now = nowIso();
    const consumedBy = String(options.consumedBy || options.consumed_by || '').trim() || 'unknown';
    const consumedBotId = String(options.consumedBotId || options.consumed_bot_id || process.env.MOLTBOT_BOT_ID || '').trim() || 'unknown';
    const updated = {
        ...record,
        status: 'consumed',
        consumed_at: now,
        consumed_by: consumedBy,
        approved_by: consumedBy,
        approved_bot_id: consumedBotId,
        execution_request_id: String(options.executionRequestId || '').trim() || null,
    };
    writeJsonAtomic(consumedTokenPath(token), updated);
    fs.rmSync(pendingPath, { force: true });
    syncPendingApprovalsMirror();
    approvalAuditLog.append('approval_decision', {
        decision: 'approved',
        token,
        action_type: deriveActionType(updated),
        risk_level: deriveRiskLevel(updated),
        requested_by: updated.requested_by || 'unknown',
        request_id: updated.request_id || null,
        execution_request_id: updated.execution_request_id || null,
        actor_requested_by: consumedBy,
        actor_bot_id: consumedBotId,
        token_owner_requested_by: updated.requested_by || 'unknown',
        token_owner_bot_id: updated.bot_id || 'unknown',
    });
    return updated;
}

function denyApproval(options = {}) {
    ensureLayout();
    expirePendingTokens();
    const token = String(options.token || '').trim();
    if (!token) {
        throw makeError('TOKEN_REQUIRED', 'Approval token is required.');
    }
    const pendingPath = tokenPath(token);
    const record = readJson(pendingPath, null);
    if (!record) {
        const consumed = readConsumedToken(token);
        if (consumed) resolveConsumedTokenError(token, consumed);
        throw makeError('TOKEN_NOT_FOUND', 'Approval token was not found.', { token });
    }
    if (String(record.status || '').trim().toLowerCase() === 'denied') {
        throw makeError('TOKEN_DENIED', 'Approval token was denied.', {
            token,
            denied_at: record.denied_at || record.consumed_at || null,
        });
    }
    if (record.consumed_at) {
        resolveConsumedTokenError(token, record);
    }

    const now = nowIso();
    const deniedBy = String(options.deniedBy || options.consumedBy || '').trim() || 'unknown';
    const deniedBotId = String(options.deniedBotId || options.denied_bot_id || process.env.MOLTBOT_BOT_ID || '').trim() || 'unknown';
    const updated = {
        ...record,
        status: 'denied',
        denied_at: now,
        denied_by: deniedBy,
        denied_bot_id: deniedBotId,
        consumed_at: now,
        consumed_by: deniedBy,
        execution_request_id: String(options.executionRequestId || '').trim() || null,
    };
    fs.rmSync(pendingPath, { force: true });
    writeJsonAtomic(consumedTokenPath(token), updated);
    syncPendingApprovalsMirror();
    approvalAuditLog.append('approval_decision', {
        decision: 'denied',
        token,
        action_type: deriveActionType(updated),
        risk_level: deriveRiskLevel(updated),
        requested_by: updated.requested_by || 'unknown',
        request_id: updated.request_id || null,
        execution_request_id: updated.execution_request_id || null,
        actor_requested_by: deniedBy,
        actor_bot_id: deniedBotId,
        token_owner_requested_by: updated.requested_by || 'unknown',
        token_owner_bot_id: updated.bot_id || 'unknown',
    });
    return updated;
}

function createApprovalGrant(options = {}) {
    ensureLayout();
    const requestedBy = normalizeRequester(options.requestedBy || options.requested_by);
    if (!requestedBy || requestedBy === 'unknown') {
        throw makeError('REQUESTER_REQUIRED', 'Approval grant requester is required.');
    }

    const createdAtMs = Date.now();
    const ttlSeconds = resolveGrantTtlSeconds(options.grantPolicy || {}, options.ttlSeconds);
    const expiresAt = new Date(createdAtMs + (ttlSeconds * 1000)).toISOString();
    const scopeRaw = String(options.scope || 'all').trim().toLowerCase();
    const scope = scopeRaw || 'all';
    const record = {
        schema_version: '1.0',
        grant_id: makeGrantId(),
        requested_by: requestedBy,
        scope,
        created_at: new Date(createdAtMs).toISOString(),
        expires_at: expiresAt,
        source_token: String(options.sourceToken || options.source_token || '').trim() || null,
        source_request_id: String(options.sourceRequestId || options.source_request_id || '').trim() || null,
        granted_by: String(options.grantedBy || options.granted_by || requestedBy).trim() || requestedBy,
    };
    writeJsonAtomic(grantRecordPath(requestedBy), record);
    return record;
}

function readApprovalGrant(requestedBy) {
    ensureLayout();
    try {
        return readJson(grantRecordPath(requestedBy), null);
    } catch (_) {
        return null;
    }
}

function clearApprovalGrant(requestedBy) {
    ensureLayout();
    let filePath = '';
    try {
        filePath = grantRecordPath(requestedBy);
    } catch (_) {
        return false;
    }
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath, { force: true });
    return true;
}

function validateApprovalGrant(options = {}) {
    ensureLayout();
    const requestedBy = normalizeRequester(options.requestedBy || options.requested_by);
    if (!requestedBy || requestedBy === 'unknown') {
        throw makeError('REQUESTER_REQUIRED', 'Approval grant requester is required.');
    }
    const record = readApprovalGrant(requestedBy);
    if (!record) {
        throw makeError('GRANT_NOT_FOUND', 'Approval grant was not found.', { requested_by: requestedBy });
    }
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const expiresAtMs = Date.parse(String(record.expires_at || ''));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        clearApprovalGrant(requestedBy);
        throw makeError('GRANT_EXPIRED', 'Approval grant expired.', {
            requested_by: requestedBy,
            expires_at: record.expires_at || null,
        });
    }
    const requestedScope = String(options.scope || '').trim().toLowerCase();
    const grantedScope = String(record.scope || 'all').trim().toLowerCase() || 'all';
    if (requestedScope && grantedScope !== 'all' && grantedScope !== requestedScope) {
        throw makeError('GRANT_SCOPE_MISMATCH', 'Approval grant scope does not cover request.', {
            requested_by: requestedBy,
            granted_scope: grantedScope,
            requested_scope: requestedScope,
        });
    }
    return {
        requested_by: requestedBy,
        record,
    };
}

function hasActiveApprovalGrant(options = {}) {
    try {
        const validated = validateApprovalGrant(options);
        return {
            active: true,
            requested_by: validated.requested_by,
            record: validated.record,
            error_code: null,
            error: null,
        };
    } catch (error) {
        return {
            active: false,
            requested_by: normalizeRequester(options.requestedBy || options.requested_by),
            record: null,
            error_code: String(error && error.code ? error.code : 'GRANT_INVALID'),
            error: String(error && error.message ? error.message : error),
        };
    }
}

module.exports = {
    COMMANDS_STATE_ROOT,
    APPROVAL_PENDING_DIR,
    APPROVAL_CONSUMED_DIR,
    APPROVAL_GRANTS_DIR,
    DEFAULT_PENDING_APPROVALS_STATE_PATH,
    ensureLayout,
    createApprovalToken,
    validateApproval,
    consumeApproval,
    denyApproval,
    createApprovalGrant,
    readApprovalGrant,
    clearApprovalGrant,
    validateApprovalGrant,
    hasActiveApprovalGrant,
    readPendingToken,
    readConsumedToken,
    resolveTtlSeconds,
    resolveGrantTtlSeconds,
    hashPlanSnapshot,
    normalizeFlags,
    stableStringify,
    syncPendingApprovalsMirror,
    expirePendingTokens,
};
