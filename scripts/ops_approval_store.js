const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const COMMANDS_STATE_ROOT = path.join(ROOT, 'ops', 'commands', 'state');
const APPROVAL_PENDING_DIR = path.join(COMMANDS_STATE_ROOT, 'pending');
const APPROVAL_CONSUMED_DIR = path.join(COMMANDS_STATE_ROOT, 'consumed');
const APPROVAL_GRANTS_DIR = path.join(COMMANDS_STATE_ROOT, 'grants');

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

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function writeJsonAtomic(filePath, payload) {
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
    const defaults = {
        defaultTtlSeconds: 180,
        minTtlSeconds: 120,
        maxTtlSeconds: 300,
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
    const token = makeToken();
    const createdAtMs = Date.now();
    const ttlSeconds = resolveTtlSeconds(options.ttlPolicy || {}, options.ttlSeconds);
    const expiresAt = new Date(createdAtMs + (ttlSeconds * 1000)).toISOString();

    const plan = options.plan || {};
    const planSnapshotHash = String(options.planSnapshotHash || hashPlanSnapshot(plan));
    const requiredFlags = normalizeFlags(options.requiredFlags || []);
    const record = {
        schema_version: '1.0',
        token,
        created_at: new Date(createdAtMs).toISOString(),
        expires_at: expiresAt,
        required_flags: requiredFlags,
        requested_by: String(options.requestedBy || '').trim() || 'unknown',
        request_id: String(options.requestId || '').trim() || null,
        plan_snapshot_hash: planSnapshotHash,
        plan,
        plan_summary: options.planSummary || {},
        consumed_at: null,
        consumed_by: null,
        execution_request_id: null,
    };
    writeJsonAtomic(tokenPath(token), record);
    return record;
}

function readPendingToken(token) {
    ensureLayout();
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
            throw makeError('TOKEN_CONSUMED', 'Approval token was already consumed.', { token, consumed_at: consumed.consumed_at || null });
        }
        throw makeError('TOKEN_NOT_FOUND', 'Approval token was not found.', { token });
    }

    if (record.consumed_at) {
        throw makeError('TOKEN_CONSUMED', 'Approval token was already consumed.', { token, consumed_at: record.consumed_at });
    }

    const nowMs = Date.now();
    const expiresAtMs = Date.parse(String(record.expires_at || ''));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        throw makeError('TOKEN_EXPIRED', 'Approval token expired.', { token, expires_at: record.expires_at || null });
    }

    const requestedBy = String(options.requestedBy || '').trim() || 'unknown';
    const expectedRequester = String(record.requested_by || '').trim() || 'unknown';
    if (requestedBy !== expectedRequester) {
        throw makeError('REQUESTER_MISMATCH', 'Approval requester does not match the plan requester.', {
            token,
            requested_by: requestedBy,
            expected_by: expectedRequester,
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
        provided_flags: providedFlags,
    };
}

function consumeApproval(options = {}) {
    const token = String(options.token || '').trim();
    const pendingPath = tokenPath(token);
    const record = readJson(pendingPath, null);
    if (!record) {
        throw makeError('TOKEN_NOT_FOUND', 'Approval token was not found.', { token });
    }
    if (record.consumed_at) {
        throw makeError('TOKEN_CONSUMED', 'Approval token was already consumed.', { token, consumed_at: record.consumed_at });
    }

    const now = nowIso();
    const updated = {
        ...record,
        consumed_at: now,
        consumed_by: String(options.consumedBy || '').trim() || 'unknown',
        execution_request_id: String(options.executionRequestId || '').trim() || null,
    };
    writeJsonAtomic(pendingPath, updated);
    writeJsonAtomic(consumedTokenPath(token), updated);
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
    ensureLayout,
    createApprovalToken,
    validateApproval,
    consumeApproval,
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
};
