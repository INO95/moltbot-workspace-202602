const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');

const DEFAULT_GOVERNANCE = Object.freeze({
    requireApprovalForAllNotionWrites: true,
    allowDbMetaMutation: false,
    timezone: 'Asia/Tokyo',
});

function readJson(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function readGovernance() {
    const config = readJson(CONFIG_PATH, {});
    const source = config && typeof config === 'object' ? (config.governance || {}) : {};
    return {
        requireApprovalForAllNotionWrites: source.requireApprovalForAllNotionWrites !== false,
        allowDbMetaMutation: source.allowDbMetaMutation === true,
        timezone: source.timezone || DEFAULT_GOVERNANCE.timezone,
    };
}

function makeError(code, message, extra = {}) {
    const error = new Error(message);
    error.code = code;
    for (const [k, v] of Object.entries(extra)) {
        error[k] = v;
    }
    return error;
}

function assertNotionDbWriteAllowed({ approvalToken = '', action = 'db_write' } = {}) {
    const governance = readGovernance();
    if (!governance.requireApprovalForAllNotionWrites) return governance;
    const token = String(approvalToken || '').trim();
    if (token) return governance;
    throw makeError(
        'APPROVAL_REQUIRED',
        `Notion ${action} requires explicit approval token`,
        { governance },
    );
}

function assertDbMetaMutationAllowed({ action = 'db_meta_mutation' } = {}) {
    const governance = readGovernance();
    if (governance.allowDbMetaMutation) return governance;
    throw makeError(
        'DB_META_MUTATION_BLOCKED',
        `Notion ${action} is blocked by governance policy`,
        { governance },
    );
}

module.exports = {
    CONFIG_PATH,
    readGovernance,
    assertNotionDbWriteAllowed,
    assertDbMetaMutationAllowed,
};
