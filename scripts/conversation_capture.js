const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data', 'conversation');
const DATA_DIR = process.env.CONVERSATION_DATA_DIR
    ? path.resolve(String(process.env.CONVERSATION_DATA_DIR))
    : DEFAULT_DATA_DIR;
const STAGING_PATH = path.join(DATA_DIR, 'staging.jsonl');

function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeSpace(value) {
    return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function sha256(input) {
    return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function redactSensitiveText(raw) {
    let out = String(raw || '');
    const patterns = [
        { re: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_OPENAI_KEY]' },
        { re: /\bntn_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_NOTION_TOKEN]' },
        { re: /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED_TELEGRAM_TOKEN]' },
        { re: /\bghp_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    ];
    for (const p of patterns) {
        out = out.replace(p.re, p.replacement);
    }
    return out;
}

function createRecord(input = {}) {
    const message = normalizeSpace(input.message);
    const redacted = redactSensitiveText(message);
    const timestamp = input.timestamp || new Date().toISOString();
    const id = input.id || `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const route = normalizeSpace(input.route || 'none').toLowerCase();
    const source = normalizeSpace(input.source || 'user').toLowerCase();
    const skillHint = normalizeSpace(input.skillHint || route || '');
    return {
        id,
        timestamp,
        source,
        route,
        message: redacted,
        messageHash: sha256(redacted),
        sensitiveRedacted: redacted !== message,
        skillHint,
        approvalState: normalizeSpace(input.approvalState || 'staged'),
    };
}

function appendRecord(record) {
    ensureDataDir();
    fs.appendFileSync(STAGING_PATH, `${JSON.stringify(record)}\n`, 'utf8');
    return STAGING_PATH;
}

function captureConversation(input = {}) {
    const record = createRecord(input);
    appendRecord(record);
    return record;
}

function parseCliArgs(argv) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    const opts = {};
    const rest = [];
    for (let i = 0; i < args.length; i += 1) {
        const token = String(args[i] || '');
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = args[i + 1];
            if (next != null && !String(next).startsWith('--')) {
                opts[key] = String(next);
                i += 1;
            } else {
                opts[key] = '1';
            }
            continue;
        }
        rest.push(token);
    }
    opts.message = opts.message || rest.join(' ').trim();
    return opts;
}

function main() {
    const opts = parseCliArgs(process.argv.slice(2));
    if (!opts.message) {
        console.error('Usage: node scripts/conversation_capture.js --message "<text>" [--route memo] [--source user] [--skillHint ...]');
        process.exit(1);
    }
    const out = captureConversation({
        source: opts.source || 'user',
        route: opts.route || 'none',
        message: opts.message,
        skillHint: opts.skillHint || '',
        approvalState: opts.approvalState || 'staged',
    });
    console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
    main();
}

module.exports = {
    DATA_DIR,
    STAGING_PATH,
    redactSensitiveText,
    createRecord,
    captureConversation,
    parseCliArgs,
    sha256,
};
