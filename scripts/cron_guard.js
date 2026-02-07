const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { enqueueBridgePayload } = require('./bridge_queue');

const ROOT = path.join(__dirname, '..');
const LOG_PATH = path.join(ROOT, 'logs/cron_guard_latest.json');

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

function appendLog(entry) {
    ensureDir(LOG_PATH);
    fs.writeFileSync(LOG_PATH, JSON.stringify(entry, null, 2), 'utf8');
}

function sendAlert({ job, command, code, stderr }) {
    const message = [
        '[ALERT] cron job failed',
        `job: ${job}`,
        `exitCode: ${code}`,
        `command: ${command}`,
        `stderr: ${truncate(stderr || '(empty)')}`,
        `time: ${nowIso()}`,
    ].join('\n');
    enqueueBridgePayload({
        taskId: `cron-fail-${Date.now()}`,
        command: message,
        timestamp: nowIso(),
        status: 'pending',
        route: 'report',
        source: 'cron-guard',
    });
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

