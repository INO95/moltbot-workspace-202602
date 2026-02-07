const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { enqueueBridgePayload } = require('./bridge_queue');

const ROOT = path.join(__dirname, '..');
const LOG_PATH = path.join(ROOT, 'logs/cron_guard_latest.json');
const ENV_PATH = path.join(ROOT, '.env');

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

function loadDotEnv() {
    if (!fs.existsSync(ENV_PATH)) return;
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    for (const line of lines) {
        const t = String(line || '').trim();
        if (!t || t.startsWith('#')) continue;
        const idx = t.indexOf('=');
        if (idx <= 0) continue;
        const key = t.slice(0, idx).trim();
        const value = t.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = value;
    }
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

function formatAlertMessage({ job, command, code, stderr, at, mode }) {
    const short = [
        `[CRON FAIL] ${job}`,
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

function sendAlert({ job, command, code, stderr }) {
    const at = nowIso();
    const mode = detectMode();
    const message = formatAlertMessage({
        job, command, code, stderr, at, mode,
    });
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
    loadDotEnv();
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
