const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OPS_COMMANDS_ROOT = path.join(ROOT, 'ops', 'commands');
const OUTBOX_DIR = path.join(OPS_COMMANDS_ROOT, 'outbox');
const STATE_DIR = path.join(OPS_COMMANDS_ROOT, 'state');
const PROCESSING_DIR = path.join(STATE_DIR, 'processing');
const COMPLETED_DIR = path.join(STATE_DIR, 'completed');
const RESULTS_PATH = path.join(OPS_COMMANDS_ROOT, 'results.jsonl');

function nowIso() {
    return new Date().toISOString();
}

function makeRequestId(prefix = 'opsfc') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureLayout() {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(PROCESSING_DIR, { recursive: true });
    fs.mkdirSync(COMPLETED_DIR, { recursive: true });
    if (!fs.existsSync(RESULTS_PATH)) {
        fs.writeFileSync(RESULTS_PATH, '', 'utf8');
    }
}

function writeJsonAtomic(filePath, payload) {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function enqueueCommand(command) {
    ensureLayout();
    const requestId = String(command && command.request_id ? command.request_id : makeRequestId()).trim();
    const payload = {
        schema_version: '1.0',
        request_id: requestId,
        created_at: nowIso(),
        ...((command && typeof command === 'object') ? command : {}),
        request_id: requestId,
    };
    const safeId = requestId.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const filePath = path.join(OUTBOX_DIR, `${Date.now()}_${safeId}.json`);
    writeJsonAtomic(filePath, payload);
    return {
        requestId,
        filePath,
        payload,
    };
}

function listOutboxFiles() {
    ensureLayout();
    return fs.readdirSync(OUTBOX_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => path.join(OUTBOX_DIR, name));
}

function claimNextCommand() {
    ensureLayout();
    const files = listOutboxFiles();
    for (const filePath of files) {
        const base = path.basename(filePath);
        const claimPath = path.join(PROCESSING_DIR, `${base}.processing`);
        try {
            fs.renameSync(filePath, claimPath);
        } catch (_) {
            continue;
        }

        const payload = readJson(claimPath, null);
        if (!payload) {
            const brokenPath = path.join(COMPLETED_DIR, `${base}.invalid`);
            try {
                fs.renameSync(claimPath, brokenPath);
            } catch (_) {
                // no-op
            }
            continue;
        }

        return {
            payload,
            claimPath,
            base,
        };
    }
    return null;
}

function appendResult(entry) {
    ensureLayout();
    const row = {
        finished_at: nowIso(),
        ...((entry && typeof entry === 'object') ? entry : {}),
    };
    fs.appendFileSync(RESULTS_PATH, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
}

function completeClaim(claim, result = {}) {
    if (!claim || !claim.claimPath) return null;
    const row = appendResult(result);
    const base = claim.base || path.basename(claim.claimPath).replace(/\.processing$/, '');
    const suffix = row && row.ok === false ? '.failed.done' : '.done';
    const donePath = path.join(COMPLETED_DIR, `${base}${suffix}`);
    try {
        fs.renameSync(claim.claimPath, donePath);
    } catch (_) {
        // no-op: result append succeeded already
    }
    return row;
}

module.exports = {
    OPS_COMMANDS_ROOT,
    OUTBOX_DIR,
    STATE_DIR,
    PROCESSING_DIR,
    COMPLETED_DIR,
    RESULTS_PATH,
    ensureLayout,
    enqueueCommand,
    listOutboxFiles,
    claimNextCommand,
    appendResult,
    completeClaim,
    makeRequestId,
};
