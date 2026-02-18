const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { enqueueBridgePayload } = require('./bridge_queue');
const { loadRuntimeEnv } = require('./env_runtime');

const ROOT = path.join(__dirname, '..');
const LOG_PATH = path.join(ROOT, 'logs/cron_guard_latest.json');
const ALERT_STATE_PATH = path.join(ROOT, 'logs/cron_guard_alert_state.json');

function parseArgs(argv) {
    const args = { job: 'unknown-job', command: '' };
    const sep = argv.indexOf('--');
    const head = sep >= 0 ? argv.slice(2, sep) : argv.slice(2);
    const tail = sep >= 0 ? argv.slice(sep + 1) : [];

    for (let i = 0; i < head.length; i += 1) {
        const a = head[i];
        if ((a === '--job' || a === '-j') && head[i + 1]) {
            args.job = head[i + 1];
            i += 1;
        }
    }
    args.command = tail.join(' ').trim();
    return args;
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
    return new Date().toISOString();
}

function truncate(text, limit = 1500) {
    const s = String(text || '');
    return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

function oneLine(text, limit = 220) {
    const raw = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    return truncate(raw || '(empty)', limit);
}

function detectMode() {
    const mode = String(process.env.CRON_GUARD_ALERT_MODE || 'short').trim().toLowerCase();
    return mode === 'detailed' ? 'detailed' : 'short';
}

function shouldDeliverNoiseAlerts() {
    return String(process.env.CRON_GUARD_DELIVER_NOISE_ALERTS || '').trim() === '1';
}

function formatAlertMessage({ job, command, code, stderr, at, mode, severity = 'core' }) {
    const levelTag = severity === 'noise' ? '[CRON WARN]' : '[CRON FAIL]';
    const short = [
        `${levelTag} ${job}`,
        `code=${code}`,
        `time=${at}`,
        `err=${oneLine(stderr)}`,
    ].join(' | ');

    if (mode !== 'detailed') return short;

    return [
        '[ALERT] cron job failed',
        `job: ${job}`,
        `exitCode: ${code}`,
        `command: ${command}`,
        `stderr: ${truncate(stderr || '(empty)')}`,
        `time: ${at}`,
    ].join('\n');
}

function appendLog(entry) {
    ensureDir(LOG_PATH);
    fs.writeFileSync(LOG_PATH, JSON.stringify(entry, null, 2), 'utf8');
}

function appendAlertDeliveryLog(status, detail) {
    const line = `[${nowIso()}] telegram_${status}: ${detail}\n`;
    const logPath = path.join(ROOT, 'logs/cron_guard_telegram.log');
    ensureDir(logPath);
    fs.appendFileSync(logPath, line, 'utf8');
}

function loadAlertState() {
    try {
        const raw = fs.readFileSync(ALERT_STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.signatures && typeof parsed.signatures === 'object') {
            return parsed;
        }
    } catch (_) {
        // ignore
    }
    return { signatures: {} };
}

function saveAlertState(state) {
    ensureDir(ALERT_STATE_PATH);
    fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function buildErrorSignature({ job, code, stderr }) {
    const normalized = oneLine(stderr, 500).toLowerCase();
    const digest = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
    return `${job}|${code}|${digest}`;
}

function classifyJobAlertPolicy(job) {
    const key = String(job || '').trim().toLowerCase();
    if (/^private-sync/.test(key)) {
        return {
            severity: 'noise',
            minCountBeforeAlert: Number(process.env.CRON_GUARD_PRIVATE_SYNC_MIN_COUNT || 3),
            cooldownMs: Number(process.env.CRON_GUARD_PRIVATE_SYNC_COOLDOWN_MS || 6 * 60 * 60 * 1000),
        };
    }
    if (/^prompt-web-health/.test(key)) {
        return {
            severity: 'noise',
            minCountBeforeAlert: Number(process.env.CRON_GUARD_HEALTH_MIN_COUNT || 2),
            cooldownMs: Number(process.env.CRON_GUARD_HEALTH_COOLDOWN_MS || 2 * 60 * 60 * 1000),
        };
    }
    return {
        severity: 'core',
        minCountBeforeAlert: 1,
        cooldownMs: Number(process.env.CRON_GUARD_ALERT_COOLDOWN_MS || 60 * 60 * 1000),
    };
}

function pruneAlertState(state, nowMs) {
    const keepMs = Number(process.env.CRON_GUARD_ALERT_KEEP_MS || 7 * 24 * 60 * 60 * 1000);
    for (const [sig, value] of Object.entries(state.signatures || {})) {
        const lastAtMs = Date.parse(value.lastAt || 0);
        if (!Number.isFinite(lastAtMs) || (nowMs - lastAtMs) > keepMs) {
            delete state.signatures[sig];
        }
    }
}

function shouldSendAlert({ job, code, stderr, atIso }) {
    const nowMs = Date.parse(atIso);
    const policy = classifyJobAlertPolicy(job);
    const cooldownMs = Number(policy.cooldownMs || Number(process.env.CRON_GUARD_ALERT_COOLDOWN_MS || 60 * 60 * 1000));
    const minCountBeforeAlert = Math.max(1, Number(policy.minCountBeforeAlert || 1));
    const signature = buildErrorSignature({ job, code, stderr });
    const state = loadAlertState();
    pruneAlertState(state, nowMs);

    const row = state.signatures[signature] || {
        count: 0,
        firstAt: atIso,
        lastAt: atIso,
        lastSentAt: null,
        job,
        code,
    };
    row.count += 1;
    row.lastAt = atIso;
    row.job = job;
    row.code = code;

    const lastSentMs = row.lastSentAt ? Date.parse(row.lastSentAt) : 0;
    const elapsed = Number.isFinite(lastSentMs) && lastSentMs > 0 ? (nowMs - lastSentMs) : Number.POSITIVE_INFINITY;
    const send = row.count >= minCountBeforeAlert && elapsed >= cooldownMs;
    if (send) row.lastSentAt = atIso;

    state.signatures[signature] = row;
    saveAlertState(state);
    return {
        send,
        signature,
        count: row.count,
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        cooldownMs,
        minCountBeforeAlert,
        severity: policy.severity || 'core',
    };
}

function sendAlert({ job, command, code, stderr }) {
    const at = nowIso();
    const dedupe = shouldSendAlert({ job, code, stderr, atIso: at });
    if (!dedupe.send) {
        appendAlertDeliveryLog('suppressed', `${job} sig=${dedupe.signature} count=${dedupe.count}`);
        return {
            sent: false,
            suppressed: true,
            ...dedupe,
        };
    }
    const mode = detectMode();
    const messageCore = formatAlertMessage({
        job, command, code, stderr, at, mode,
        severity: dedupe.severity,
    });
    const summary = dedupe.count > 1
        ? `\nrepeat=${dedupe.count}, first=${dedupe.firstAt}, last=${dedupe.lastAt}`
        : '';
    const message = `${messageCore}${summary}`.trim();

    // Noise-classified jobs (for example private-sync) stay in local logs by default.
    // Set CRON_GUARD_DELIVER_NOISE_ALERTS=1 to forward them to bridge/Telegram again.
    if (dedupe.severity === 'noise' && !shouldDeliverNoiseAlerts()) {
        appendAlertDeliveryLog('suppressed', `${job} sig=${dedupe.signature} count=${dedupe.count} reason=noise_policy`);
        return {
            sent: false,
            suppressed: true,
            mutedByPolicy: true,
            ...dedupe,
        };
    }

    try {
        enqueueBridgePayload({
            taskId: `cron-fail-${Date.now()}`,
            command: message,
            timestamp: at,
            status: 'pending',
            route: 'report',
            source: 'cron-guard',
        });
    } catch {
        // Alert delivery must not crash cron guard itself.
    }
    sendTelegramAlert(message);
    return {
        sent: true,
        suppressed: false,
        ...dedupe,
    };
}

function sendTelegramAlert(message) {
    if (String(process.env.CRON_GUARD_DISABLE_TELEGRAM || '') === '1') return;
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    const chatId = process.env.TELEGRAM_USER_ID || '';
    if (!token || !chatId) return;

    const body = JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
    });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
        timeout: 7000,
    }, res => {
        if (!(res.statusCode >= 200 && res.statusCode < 300)) {
            appendAlertDeliveryLog('failed', `http_${res.statusCode}`);
        } else {
            appendAlertDeliveryLog('ok', `http_${res.statusCode}`);
        }
        res.resume();
    });
    req.on('error', (e) => {
        appendAlertDeliveryLog('failed', e.message || 'request_error');
    });
    req.write(body);
    req.end();
}

function runCommand(command) {
    const started = Date.now();
    try {
        const stdout = execSync(command, {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: '/bin/zsh',
        }).toString('utf8');
        return {
            ok: true,
            code: 0,
            durationMs: Date.now() - started,
            stdout,
            stderr: '',
        };
    } catch (error) {
        return {
            ok: false,
            code: typeof error.status === 'number' ? error.status : 1,
            durationMs: Date.now() - started,
            stdout: String(error.stdout || ''),
            stderr: String(error.stderr || error.message || ''),
        };
    }
}

function main() {
    loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true });
    const { job, command } = parseArgs(process.argv);
    if (!command) {
        console.error('Usage: node scripts/cron_guard.js --job "<name>" -- <command>');
        process.exit(2);
    }

    const result = runCommand(command);
    const entry = {
        at: nowIso(),
        job,
        command,
        ...result,
    };
    appendLog(entry);

    if (!result.ok) {
        sendAlert({
            job,
            command,
            code: result.code,
            stderr: result.stderr,
        });
        console.error(result.stderr || `cron job failed: ${job}`);
        process.exit(result.code || 1);
    }

    if (result.stdout) process.stdout.write(result.stdout);
}

if (require.main === module) {
    main();
}
