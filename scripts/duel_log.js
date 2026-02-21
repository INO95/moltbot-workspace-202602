const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BRIDGE_DIR = path.join(__dirname, '../data/bridge');
const LOCK_DIR = path.join(__dirname, '../data/locks');

const DUEL_LOG_PATH = process.env.DUEL_LOG_PATH || path.join(BRIDGE_DIR, 'model_duel.jsonl');
const DUEL_LOCK_PATH = process.env.DUEL_LOCK_PATH || path.join(LOCK_DIR, 'model_duel.lock');

const SPEAKERS = ['codex', 'antigravity', 'system'];
const TYPES = ['request', 'draft', 'critique', 'revision', 'final', 'error'];
const REVISION_DECISIONS = ['accepted', 'rejected', 'partially_accepted'];
const RUBRIC_KEYS = ['correctness', 'feasibility', 'risk', 'clarity', 'testability'];

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function ensureDirFor(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function sleep(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        // Lightweight busy wait; this utility is short lived and lock windows are tiny.
    }
}

function makeId(prefix = 'evt') {
    const t = Date.now();
    const r = Math.random().toString(36).slice(2, 9);
    return `${prefix}-${t}-${r}`;
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function redactSensitiveText(raw) {
    let text = String(raw || '');
    const rules = [
        { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
        { re: /\b(?:sk|rk)-[A-Za-z0-9_\-]{20,}\b/g, replacement: '[REDACTED_API_KEY]' },
        { re: /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED_TELEGRAM_TOKEN]' },
        {
            re: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
            replacement: '[REDACTED_PRIVATE_KEY]',
        },
        { re: /\b(Bearer\s+)[A-Za-z0-9._\-]{20,}\b/g, replacement: '$1[REDACTED_BEARER]' },
    ];

    for (const rule of rules) {
        text = text.replace(rule.re, rule.replacement);
    }
    return text;
}

function normalizeIssue(issue) {
    return {
        claim: redactSensitiveText(issue && issue.claim),
        evidence: redactSensitiveText(issue && issue.evidence),
        suggestedFix: redactSensitiveText(issue && issue.suggestedFix),
    };
}

function normalizeResponse(response) {
    return {
        issueRef: response && hasOwn(response, 'issueRef') ? response.issueRef : null,
        decision: String((response && response.decision) || '').trim(),
        rationale: redactSensitiveText(response && response.rationale),
    };
}

function normalizeRubric(rubric) {
    const out = {};
    for (const key of RUBRIC_KEYS) {
        const value = Number(rubric && rubric[key]);
        out[key] = Number.isFinite(value) ? Math.trunc(value) : NaN;
    }
    return out;
}

function defaultStatusForType(type) {
    if (type === 'error') return 'error';
    if (type === 'final') return 'completed';
    return 'ok';
}

function prepareEvent(inputEvent) {
    const event = { ...inputEvent };

    event.eventId = isNonEmptyString(event.eventId) ? String(event.eventId).trim() : makeId('evt');
    event.timestamp = isNonEmptyString(event.timestamp)
        ? String(event.timestamp).trim()
        : new Date().toISOString();
    event.round = Number(event.round);
    event.content = redactSensitiveText(event.content);
    event.replyToEventId = hasOwn(event, 'replyToEventId') ? event.replyToEventId : null;
    event.status = isNonEmptyString(event.status)
        ? String(event.status).trim()
        : defaultStatusForType(event.type);
    event.contentHash = sha256(event.content);

    if (event.rubric != null) {
        event.rubric = normalizeRubric(event.rubric);
    }
    if (Array.isArray(event.issues)) {
        event.issues = event.issues.map(normalizeIssue);
    }
    if (Array.isArray(event.responses)) {
        event.responses = event.responses.map(normalizeResponse);
    }

    return event;
}

function validateRubric(rubric, errors) {
    if (!rubric || typeof rubric !== 'object') {
        errors.push('rubric is required for critique/revision events');
        return;
    }
    for (const key of RUBRIC_KEYS) {
        const score = Number(rubric[key]);
        if (!Number.isFinite(score) || Math.trunc(score) !== score || score < 1 || score > 5) {
            errors.push(`rubric.${key} must be an integer between 1 and 5`);
        }
    }
}

function validateIssues(issues, errors) {
    if (!Array.isArray(issues) || issues.length === 0) {
        errors.push('issues must be a non-empty array for critique/revision events');
        return;
    }
    for (let i = 0; i < issues.length; i += 1) {
        const issue = issues[i] || {};
        if (!isNonEmptyString(issue.claim)) errors.push(`issues[${i}].claim is required`);
        if (!isNonEmptyString(issue.evidence)) errors.push(`issues[${i}].evidence is required`);
        if (!isNonEmptyString(issue.suggestedFix)) {
            errors.push(`issues[${i}].suggestedFix is required`);
        }
    }
}

function validateResponses(event, errors) {
    if (event.type !== 'revision') return;
    if (!REVISION_DECISIONS.includes(String(event.decision || '').trim())) {
        errors.push('revision decision must be one of accepted|rejected|partially_accepted');
    }
    if (!Array.isArray(event.responses) || event.responses.length === 0) {
        errors.push('revision responses must be a non-empty array');
        return;
    }
    if (Array.isArray(event.issues) && event.responses.length !== event.issues.length) {
        errors.push('revision responses length must match issues length');
    }
    for (let i = 0; i < event.responses.length; i += 1) {
        const response = event.responses[i] || {};
        const d = String(response.decision || '').trim();
        if (!REVISION_DECISIONS.includes(d)) {
            errors.push(`responses[${i}].decision must be accepted|rejected|partially_accepted`);
        }
        if (!isNonEmptyString(response.rationale)) {
            errors.push(`responses[${i}].rationale is required`);
        }
    }
}

function validateEvent(event) {
    const errors = [];

    const required = [
        'eventId',
        'debateId',
        'taskId',
        'ackId',
        'timestamp',
        'round',
        'speaker',
        'type',
        'content',
        'contentHash',
        'replyToEventId',
        'status',
    ];

    for (const key of required) {
        if (!hasOwn(event, key)) {
            errors.push(`missing field: ${key}`);
        }
    }

    if (!isNonEmptyString(event.eventId)) errors.push('eventId is required');
    if (!isNonEmptyString(event.debateId)) errors.push('debateId is required');
    if (!isNonEmptyString(event.taskId)) errors.push('taskId is required');
    if (!isNonEmptyString(event.ackId)) errors.push('ackId is required');
    if (!isNonEmptyString(event.timestamp)) errors.push('timestamp is required');
    if (!Number.isInteger(event.round) || event.round < 0) errors.push('round must be an integer >= 0');
    if (!SPEAKERS.includes(String(event.speaker || '').trim())) {
        errors.push(`speaker must be one of: ${SPEAKERS.join(', ')}`);
    }
    if (!TYPES.includes(String(event.type || '').trim())) {
        errors.push(`type must be one of: ${TYPES.join(', ')}`);
    }
    if (!isNonEmptyString(event.content)) errors.push('content is required');
    if (!isNonEmptyString(event.contentHash)) errors.push('contentHash is required');
    if (!(event.replyToEventId === null || isNonEmptyString(event.replyToEventId))) {
        errors.push('replyToEventId must be null or non-empty string');
    }
    if (!isNonEmptyString(event.status)) errors.push('status is required');

    const expectedHash = sha256(event.content);
    if (event.contentHash && event.contentHash !== expectedHash) {
        errors.push('contentHash does not match content');
    }

    const type = String(event.type || '').trim();
    if (type === 'critique' || type === 'revision') {
        validateRubric(event.rubric, errors);
        validateIssues(event.issues, errors);

        // Quality gate:
        // - opposition is represented as issue.claim + issue.evidence
        // - alternative is represented as issue.suggestedFix
        const hasOpposition = Array.isArray(event.issues)
            && event.issues.some((issue) => isNonEmptyString(issue.claim) && isNonEmptyString(issue.evidence));
        const hasAlternative = Array.isArray(event.issues)
            && event.issues.some((issue) => isNonEmptyString(issue.suggestedFix));
        if (!hasOpposition) errors.push('critique/revision requires at least one opposing point');
        if (!hasAlternative) errors.push('critique/revision requires at least one alternative fix');
    }

    validateResponses(event, errors);

    return {
        ok: errors.length === 0,
        errors,
    };
}

function acquireLock(lockPath, { timeoutMs = 5000, staleMs = 30000 } = {}) {
    ensureDirFor(lockPath);
    const start = Date.now();

    while (true) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            const payload = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
            fs.writeFileSync(fd, payload, 'utf8');
            return fd;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;

            try {
                const st = fs.statSync(lockPath);
                const lockAgeMs = Date.now() - Number(st.mtimeMs || 0);
                if (Number.isFinite(lockAgeMs) && lockAgeMs > staleMs) {
                    fs.unlinkSync(lockPath);
                    continue;
                }
            } catch {
                // Another process may have removed/rotated the lock.
            }

            if (Date.now() - start > timeoutMs) {
                throw new Error(`Failed to acquire duel log lock: ${lockPath}`);
            }
            sleep(25);
        }
    }
}

function releaseLock(fd, lockPath) {
    try {
        if (typeof fd === 'number') fs.closeSync(fd);
    } catch {
        // No-op.
    }
    try {
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
        // No-op.
    }
}

function appendEvent(rawEvent, options = {}) {
    const logPath = options.logPath || DUEL_LOG_PATH;
    const lockPath = options.lockPath || DUEL_LOCK_PATH;
    ensureDirFor(logPath);

    const event = prepareEvent(rawEvent || {});
    const result = validateEvent(event);
    if (!result.ok) {
        throw new Error(`Invalid duel event: ${result.errors.join('; ')}`);
    }

    const lockFd = acquireLock(lockPath, options);
    try {
        fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf8');
    } finally {
        releaseLock(lockFd, lockPath);
    }

    return event;
}

function readEvents(options = {}) {
    const logPath = options.logPath || DUEL_LOG_PATH;
    if (!fs.existsSync(logPath)) return [];

    const debateId = options.debateId || null;
    const taskId = options.taskId || null;
    const onlyValid = options.onlyValid !== false;

    const out = [];
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }

        if (debateId && String(event.debateId || '') !== String(debateId)) continue;
        if (taskId && String(event.taskId || '') !== String(taskId)) continue;

        if (onlyValid) {
            const v = validateEvent(event);
            if (!v.ok) continue;
        }
        out.push(event);
    }

    if (Number.isInteger(options.limit) && options.limit > 0 && out.length > options.limit) {
        return out.slice(-options.limit);
    }
    return out;
}

function getLatestEvent(events, type = null) {
    const source = Array.isArray(events) ? events : [];
    for (let i = source.length - 1; i >= 0; i -= 1) {
        if (!type || source[i].type === type) return source[i];
    }
    return null;
}

function computeDebateMetrics(events) {
    const src = Array.isArray(events) ? events : [];

    const critiqueEvents = src.filter((e) => e.type === 'critique');
    const revisionEvents = src.filter((e) => e.type === 'revision');
    const finalEvent = getLatestEvent(src, 'final');

    let critiqueIssueCount = 0;
    let revisionResponseCount = 0;
    let accepted = 0;
    let rejected = 0;
    let partial = 0;

    const rubricTotals = {};
    for (const key of RUBRIC_KEYS) rubricTotals[key] = 0;
    let rubricCount = 0;

    for (const critique of critiqueEvents) {
        const issues = Array.isArray(critique.issues) ? critique.issues : [];
        critiqueIssueCount += issues.length;

        if (critique.rubric && typeof critique.rubric === 'object') {
            let validRubric = true;
            for (const key of RUBRIC_KEYS) {
                const score = Number(critique.rubric[key]);
                if (!Number.isFinite(score)) {
                    validRubric = false;
                    break;
                }
            }
            if (validRubric) {
                rubricCount += 1;
                for (const key of RUBRIC_KEYS) {
                    rubricTotals[key] += Number(critique.rubric[key]);
                }
            }
        }
    }

    for (const revision of revisionEvents) {
        const responses = Array.isArray(revision.responses) ? revision.responses : [];
        revisionResponseCount += responses.length;
        for (const response of responses) {
            const d = String(response.decision || '').trim();
            if (d === 'accepted') accepted += 1;
            else if (d === 'rejected') rejected += 1;
            else if (d === 'partially_accepted') partial += 1;
        }
    }

    const reviewedCount = accepted + rejected + partial;
    const acceptanceRate = reviewedCount > 0 ? Number((accepted / reviewedCount).toFixed(4)) : null;

    const rubricAverage = {};
    for (const key of RUBRIC_KEYS) {
        rubricAverage[key] = rubricCount > 0 ? Number((rubricTotals[key] / rubricCount).toFixed(2)) : null;
    }

    return {
        eventCount: src.length,
        roundsUsed: src.reduce((m, e) => Math.max(m, Number(e.round || 0)), 0),
        critiqueIssueCount,
        revisionResponseCount,
        reviewedCount,
        accepted,
        rejected,
        partiallyAccepted: partial,
        acceptanceRate,
        rubricAverage,
        finalStatus: finalEvent ? String(finalEvent.status || '') : null,
        degraded: finalEvent ? String(finalEvent.status || '') === 'degraded' : false,
    };
}

module.exports = {
    BRIDGE_DIR,
    DUEL_LOG_PATH,
    DUEL_LOCK_PATH,
    SPEAKERS,
    TYPES,
    REVISION_DECISIONS,
    RUBRIC_KEYS,
    makeId,
    sha256,
    redactSensitiveText,
    prepareEvent,
    validateEvent,
    appendEvent,
    readEvents,
    getLatestEvent,
    computeDebateMetrics,
};
