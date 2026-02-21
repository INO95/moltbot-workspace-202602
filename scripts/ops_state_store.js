const fs = require('fs');
const path = require('path');

const ROOT = process.env.OPS_WORKSPACE_ROOT
    ? path.resolve(String(process.env.OPS_WORKSPACE_ROOT))
    : path.join(__dirname, '..');
const OPS_ROOT = path.join(ROOT, 'ops');
const LOGS_ROOT = path.join(ROOT, 'logs');
const STATE_DIR = path.join(OPS_ROOT, 'state');
const ALERTS_DIR = path.join(OPS_ROOT, 'alerts');
const OUTBOX_DIR = path.join(ALERTS_DIR, 'outbox');
const SENT_DIR = path.join(ALERTS_DIR, 'sent');
const REPORTS_DIR = path.join(OPS_ROOT, 'reports');
const RUNBOOKS_DIR = path.join(OPS_ROOT, 'runbooks');
const CONFIG_DIR = path.join(OPS_ROOT, 'config');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const ISSUES_PATH = path.join(STATE_DIR, 'issues.json');

const DEFAULT_STATE = Object.freeze({
    schema_version: '1.0',
    updated_at: null,
    timezone: 'Asia/Tokyo',
    scan_cursor_ts_by_bot: {},
    bot_health: {},
    last_briefing_sent: {
        morning: null,
        evening: null,
    },
});

const DEFAULT_ISSUES = Object.freeze({
    schema_version: '1.0',
    updated_at: null,
    issues: {},
});

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function cloneDefault(data) {
    return JSON.parse(JSON.stringify(data));
}

function assertNotLogsWrite(filePath) {
    const target = path.resolve(filePath);
    const rel = path.relative(LOGS_ROOT, target);
    const insideLogs = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (insideLogs) {
        throw new Error(`Daily supervisor write blocked for logs path: ${target}`);
    }
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
    assertNotLogsWrite(filePath);
    ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function ensureOpsLayout() {
    ensureDir(OPS_ROOT);
    ensureDir(STATE_DIR);
    ensureDir(ALERTS_DIR);
    ensureDir(OUTBOX_DIR);
    ensureDir(SENT_DIR);
    ensureDir(REPORTS_DIR);
    ensureDir(RUNBOOKS_DIR);
    ensureDir(CONFIG_DIR);
    if (!fs.existsSync(STATE_PATH)) {
        writeJsonAtomic(STATE_PATH, cloneDefault(DEFAULT_STATE));
    }
    if (!fs.existsSync(ISSUES_PATH)) {
        writeJsonAtomic(ISSUES_PATH, cloneDefault(DEFAULT_ISSUES));
    }
}

function readState() {
    ensureOpsLayout();
    const base = cloneDefault(DEFAULT_STATE);
    const loaded = readJson(STATE_PATH, base);
    return {
        ...base,
        ...(loaded && typeof loaded === 'object' ? loaded : {}),
        scan_cursor_ts_by_bot: {
            ...base.scan_cursor_ts_by_bot,
            ...((loaded && loaded.scan_cursor_ts_by_bot) || {}),
        },
        bot_health: {
            ...base.bot_health,
            ...((loaded && loaded.bot_health) || {}),
        },
        last_briefing_sent: {
            ...base.last_briefing_sent,
            ...((loaded && loaded.last_briefing_sent) || {}),
        },
    };
}

function writeState(state) {
    ensureOpsLayout();
    const payload = {
        ...cloneDefault(DEFAULT_STATE),
        ...(state && typeof state === 'object' ? state : {}),
    };
    writeJsonAtomic(STATE_PATH, payload);
    return payload;
}

function readIssues() {
    ensureOpsLayout();
    const base = cloneDefault(DEFAULT_ISSUES);
    const loaded = readJson(ISSUES_PATH, base);
    return {
        ...base,
        ...(loaded && typeof loaded === 'object' ? loaded : {}),
        issues: {
            ...base.issues,
            ...((loaded && loaded.issues) || {}),
        },
    };
}

function writeIssues(issues) {
    ensureOpsLayout();
    const payload = {
        ...cloneDefault(DEFAULT_ISSUES),
        ...(issues && typeof issues === 'object' ? issues : {}),
        issues: {
            ...cloneDefault(DEFAULT_ISSUES).issues,
            ...((issues && issues.issues) || {}),
        },
    };
    writeJsonAtomic(ISSUES_PATH, payload);
    return payload;
}

function sanitizeFileToken(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '') || 'unknown';
}

function buildAlertFileName(alert) {
    const ts = sanitizeFileToken(String((alert && alert.created_at) || new Date().toISOString()).replace(/[:]/g, '-'));
    const issue = sanitizeFileToken((alert && alert.issue_id) || 'issue');
    return `${ts}_${issue}.json`;
}

function writeAlertOutbox(alert) {
    ensureOpsLayout();
    const filename = buildAlertFileName(alert);
    const outboxPath = path.join(OUTBOX_DIR, filename);
    writeJsonAtomic(outboxPath, alert);
    return outboxPath;
}

function markAlertSent(outboxPath) {
    ensureOpsLayout();
    const source = path.resolve(outboxPath);
    const destination = path.join(SENT_DIR, path.basename(source));
    assertNotLogsWrite(destination);
    fs.renameSync(source, destination);
    return destination;
}

function writeReport(reportPath, content) {
    ensureOpsLayout();
    assertNotLogsWrite(reportPath);
    ensureDir(path.dirname(reportPath));
    fs.writeFileSync(reportPath, String(content || ''), 'utf8');
}

module.exports = {
    ROOT,
    OPS_ROOT,
    LOGS_ROOT,
    STATE_DIR,
    ALERTS_DIR,
    OUTBOX_DIR,
    SENT_DIR,
    REPORTS_DIR,
    RUNBOOKS_DIR,
    CONFIG_DIR,
    STATE_PATH,
    ISSUES_PATH,
    DEFAULT_STATE,
    DEFAULT_ISSUES,
    assertNotLogsWrite,
    ensureOpsLayout,
    readState,
    writeState,
    readIssues,
    writeIssues,
    writeAlertOutbox,
    markAlertSent,
    writeReport,
};
