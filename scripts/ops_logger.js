const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.OPS_WORKSPACE_ROOT
    ? path.resolve(String(process.env.OPS_WORKSPACE_ROOT))
    : path.join(__dirname, '..');
const LOGS_ROOT = path.join(ROOT, 'logs');

const BOT_ALIAS_MAP = Object.freeze({
    dev: 'bot-dev',
    anki: 'bot-anki',
    research: 'bot-research',
    daily: 'bot-daily',
    dev_bak: 'bot-dev-bak',
    anki_bak: 'bot-anki-bak',
    research_bak: 'bot-research-bak',
    daily_bak: 'bot-daily-bak',
});

function isoNow(input) {
    const date = input instanceof Date ? input : (input ? new Date(input) : new Date());
    return date.toISOString();
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function hashText(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function normalizeBotId(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw) return null;
    if (raw.startsWith('bot-')) return raw;
    return BOT_ALIAS_MAP[raw] || `bot-${raw.replace(/[^a-z0-9-]/g, '-')}`;
}

function resolveBotIdFromEnv(env = process.env) {
    const direct = normalizeBotId(env.MOLTBOT_BOT_ID || '');
    if (direct) return direct;

    const profile = normalizeBotId(env.MOLTBOT_PROFILE || env.OPENCLAW_PROFILE || '');
    if (profile) return profile;

    const host = String(env.HOSTNAME || '').trim().toLowerCase();
    if (host.startsWith('moltbot-')) {
        return normalizeBotId(host.replace(/^moltbot-/, ''));
    }
    return null;
}

function resolveBotRole(env = process.env) {
    const role = String(env.MOLTBOT_BOT_ROLE || '').trim().toLowerCase();
    if (role === 'worker' || role === 'supervisor') return role;
    const botId = resolveBotIdFromEnv(env);
    if (botId === 'bot-daily' || botId === 'bot-daily-bak') return 'supervisor';
    return 'worker';
}

function shouldWriteLogs(env = process.env) {
    const botId = resolveBotIdFromEnv(env);
    const role = resolveBotRole(env);
    if (!botId) return false;
    if (role !== 'worker') return false;
    return true;
}

function getBotDir(botId) {
    return path.join(LOGS_ROOT, botId);
}

function getEventsDir(botId) {
    return path.join(getBotDir(botId), 'events');
}

function getLatestPath(botId) {
    return path.join(getBotDir(botId), 'latest.json');
}

function getHeartbeatPath(botId) {
    return path.join(getBotDir(botId), 'heartbeat.json');
}

function getEventFilePath(botId, input) {
    const ts = isoNow(input);
    const date = ts.slice(0, 10);
    return path.join(getEventsDir(botId), `${date}.jsonl`);
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

function writeJsonAtomic(filePath, data) {
    ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, event) {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

function redactString(value) {
    let out = String(value || '');
    out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._-]+\b/gi, '$1[REDACTED]');
    out = out.replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]');
    out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (email) => {
        const digest = hashText(email).slice(0, 12);
        return `email_hash:${digest}`;
    });
    return out;
}

function redact(value) {
    if (value == null) return value;
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (typeof value === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            const lowerKey = key.toLowerCase();
            if (
                lowerKey.includes('token') ||
                lowerKey.includes('secret') ||
                lowerKey.includes('password') ||
                lowerKey.includes('cookie') ||
                lowerKey.includes('authorization')
            ) {
                out[key] = '[REDACTED]';
            } else {
                out[key] = redact(val);
            }
        }
        return out;
    }
    return value;
}

function fingerprintError(error, hints = {}) {
    const src = error && typeof error === 'object' ? error : {};
    const type = String(src.type || src.name || hints.type || 'Error');
    const code = String(src.code || hints.code || '');
    const message = redactString(String(src.message || hints.message || ''));
    const component = String(hints.component || '');
    const action = String(hints.action || '');
    const raw = `${type}|${code}|${message}|${component}|${action}`.toLowerCase().replace(/\s+/g, ' ').trim();
    return `fp_${hashText(raw).slice(0, 20)}`;
}

function toEvent(context, payload, eventType) {
    const now = isoNow();
    const base = {
        schema_version: '1.0',
        ts: now,
        bot_id: context.bot_id,
        run_id: context.run_id,
        event_type: eventType,
        status: payload.status || 'ok',
        severity: payload.severity || (payload.status === 'error' ? 'P2' : 'P3'),
        message: redactString(payload.message || 'Event recorded.'),
        component: payload.component || 'bridge',
    };
    const merged = {
        ...base,
        ...redact(payload || {}),
    };
    merged.schema_version = '1.0';
    merged.ts = merged.ts || now;
    merged.bot_id = context.bot_id;
    merged.run_id = context.run_id;
    merged.event_type = eventType;
    merged.message = redactString(merged.message);
    merged.component = merged.component || 'bridge';
    return merged;
}

function ensureBotLayout(botId) {
    ensureDir(getEventsDir(botId));
    if (!fs.existsSync(getLatestPath(botId))) {
        writeJsonAtomic(getLatestPath(botId), {
            schema_version: '1.0',
            bot_id: botId,
            run_id: null,
            last_event_ts: null,
            status: 'ok',
            severity: 'P3',
            last_success_ts: null,
            consecutive_failures_by_issue: {},
        });
    }
    if (!fs.existsSync(getHeartbeatPath(botId))) {
        writeJsonAtomic(getHeartbeatPath(botId), {
            schema_version: '1.0',
            bot_id: botId,
            run_id: null,
            ts: null,
            state: 'idle',
        });
    }
}

function createContext(overrides = {}) {
    const env = overrides.env || process.env;
    const botId = normalizeBotId(overrides.bot_id || resolveBotIdFromEnv(env));
    const role = String(overrides.role || resolveBotRole(env) || 'worker');
    const enabled = Boolean(botId) && role === 'worker' && shouldWriteLogs(env);
    return {
        enabled,
        bot_id: botId,
        role,
        run_id: crypto.randomUUID(),
        started_at: Date.now(),
        had_retry: false,
    };
}

function writeEvent(context, eventType, payload = {}) {
    if (!context || !context.enabled) return null;
    ensureBotLayout(context.bot_id);
    const event = toEvent(context, payload, eventType);
    const eventPath = getEventFilePath(context.bot_id, event.ts);
    appendJsonl(eventPath, event);
    return {
        event,
        eventPath,
    };
}

function updateLatest(context, payload = {}) {
    if (!context || !context.enabled) return null;
    ensureBotLayout(context.bot_id);
    const latestPath = getLatestPath(context.bot_id);
    const current = readJson(latestPath, {
        schema_version: '1.0',
        bot_id: context.bot_id,
        run_id: null,
        last_event_ts: null,
        status: 'ok',
        severity: 'P3',
        last_success_ts: null,
        consecutive_failures_by_issue: {},
    });
    const next = {
        ...current,
        ...redact(payload),
        schema_version: '1.0',
        bot_id: context.bot_id,
        run_id: context.run_id,
        last_event_ts: payload.last_event_ts || isoNow(),
    };
    writeJsonAtomic(latestPath, next);
    return next;
}

function touchHeartbeat(context, payload = {}) {
    if (!context || !context.enabled) return null;
    ensureBotLayout(context.bot_id);
    const heartbeat = {
        schema_version: '1.0',
        bot_id: context.bot_id,
        run_id: context.run_id,
        ts: payload.ts || isoNow(),
        state: payload.state || 'running',
    };
    writeJsonAtomic(getHeartbeatPath(context.bot_id), heartbeat);
    if (payload.emitEvent) {
        writeEvent(context, 'heartbeat', {
            status: 'ok',
            severity: 'P3',
            component: payload.component || 'heartbeat',
            action: payload.action || 'heartbeat_tick',
            message: payload.message || 'Heartbeat updated.',
        });
    }
    return heartbeat;
}

function startRun(payload = {}) {
    const context = createContext(payload);
    if (!context.enabled) return context;
    writeEvent(context, 'start', {
        status: 'ok',
        severity: 'P3',
        component: payload.component || 'bridge',
        action: payload.action || 'run',
        attempt: payload.attempt || 1,
        max_attempts: payload.max_attempts || 3,
        message: payload.message || 'Run started.',
        metrics: payload.metrics || {},
    });
    touchHeartbeat(context, {
        state: 'running',
        emitEvent: false,
    });
    updateLatest(context, {
        status: 'ok',
        severity: 'P3',
    });
    return context;
}

function logStep(context, payload = {}) {
    return writeEvent(context, 'step', {
        status: payload.status || 'ok',
        severity: payload.severity || 'P3',
        component: payload.component || 'bridge',
        action: payload.action || 'step',
        message: payload.message || 'Step completed.',
        duration_ms: payload.duration_ms,
        metrics: payload.metrics,
    });
}

function logRetry(context, payload = {}) {
    if (context && context.enabled) {
        context.had_retry = true;
    }
    const err = payload.error && typeof payload.error === 'object' ? payload.error : {};
    const fingerprint = String(
        (err && err.fingerprint) ||
        fingerprintError(err, { component: payload.component, action: payload.action }),
    );
    return writeEvent(context, 'retry', {
        status: 'warn',
        severity: 'P3',
        component: payload.component || 'bridge',
        action: payload.action || 'retry',
        attempt: payload.attempt || 1,
        max_attempts: payload.max_attempts || 3,
        message: payload.message || 'Retrying after transient error.',
        error: {
            type: String(err.type || err.name || 'Error'),
            code: String(err.code || ''),
            message: redactString(String(err.message || '')),
            stack: redactString(String(err.stack || '')).slice(0, 4096),
            fingerprint,
            retriable: true,
        },
    });
}

function logEnd(context, payload = {}) {
    const status = payload.status || 'ok';
    const severity = payload.severity || (status === 'error' ? 'P2' : 'P3');
    const duration = payload.duration_ms != null
        ? payload.duration_ms
        : (context && context.started_at ? Date.now() - context.started_at : undefined);
    const err = payload.error && typeof payload.error === 'object' ? payload.error : null;
    const errorPayload = err
        ? {
            type: String(err.type || err.name || 'Error'),
            code: String(err.code || ''),
            message: redactString(String(err.message || '')),
            stack: redactString(String(err.stack || '')).slice(0, 4096),
            fingerprint: String(err.fingerprint || fingerprintError(err, {
                component: payload.component,
                action: payload.action,
            })),
            retriable: Boolean(payload.retriable),
        }
        : undefined;

    const writeResult = writeEvent(context, 'end', {
        status,
        severity,
        component: payload.component || 'bridge',
        action: payload.action || 'run',
        message: payload.message || (status === 'error' ? 'Run failed.' : 'Run completed.'),
        duration_ms: duration,
        attempt: payload.attempt || 1,
        max_attempts: payload.max_attempts || 3,
        error: errorPayload,
        metrics: payload.metrics || {},
    });
    updateLatest(context, {
        status,
        severity,
        last_event_ts: writeResult && writeResult.event ? writeResult.event.ts : isoNow(),
        last_success_ts: status === 'error' ? undefined : isoNow(),
    });
    touchHeartbeat(context, {
        state: status === 'error' ? 'stalled' : 'idle',
        emitEvent: false,
    });
    return writeResult;
}

function startHeartbeatTicker(context, options = {}) {
    if (!context || !context.enabled) return () => {};
    const intervalMs = Number(options.interval_ms || (5 * 60 * 1000));
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
    const timer = setInterval(() => {
        touchHeartbeat(context, {
            state: 'running',
            emitEvent: true,
            component: options.component || 'heartbeat',
            action: options.action || 'heartbeat_tick',
            message: options.message || 'Run heartbeat.',
        });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
}

module.exports = {
    ROOT,
    LOGS_ROOT,
    normalizeBotId,
    resolveBotIdFromEnv,
    resolveBotRole,
    shouldWriteLogs,
    redact,
    fingerprintError,
    createContext,
    startRun,
    logStep,
    logRetry,
    logEnd,
    touchHeartbeat,
    updateLatest,
    startHeartbeatTicker,
};
