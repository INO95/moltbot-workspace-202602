const fs = require('fs');
const path = require('path');

const BRIDGE_DIR = path.join(__dirname, '../data/bridge');
const INBOX_PATH = path.join(BRIDGE_DIR, 'inbox.json');
const INBOX_LOG_PATH = path.join(BRIDGE_DIR, 'inbox.jsonl');

function ensureBridgeDir() {
    if (!fs.existsSync(BRIDGE_DIR)) {
        fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    }
}

function writeLatestInbox(payload) {
    const tmpPath = `${INBOX_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, INBOX_PATH);
}

function appendInboxLog(payload) {
    fs.appendFileSync(INBOX_LOG_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
}

function enqueueBridgePayload(payload) {
    ensureBridgeDir();
    const normalized = {
        ...payload,
        ackId: payload.ackId || makeAckId(payload.taskId),
    };
    appendInboxLog(normalized);
    // Keep legacy single-file consumer compatibility.
    writeLatestInbox(normalized);
    return normalized;
}

function makeTaskId(prefix = 'task') {
    const t = Date.now();
    const r = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${t}-${r}`;
}

function makeAckId(seed = '') {
    const t = Date.now().toString(36).slice(-4);
    const s = String(seed || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4).toLowerCase();
    const r = Math.random().toString(36).slice(2, 4);
    return `${t}${s}${r}`.slice(0, 10);
}

function enqueueBridgeCommand(command, options = {}) {
    const payload = {
        taskId: options.taskId || makeTaskId(options.prefix || 'task'),
        command,
        timestamp: options.timestamp || new Date().toISOString(),
        status: options.status || 'pending',
    };
    return enqueueBridgePayload(payload);
}

module.exports = {
    BRIDGE_DIR,
    INBOX_PATH,
    INBOX_LOG_PATH,
    enqueueBridgePayload,
    enqueueBridgeCommand,
    makeTaskId,
    makeAckId,
};
