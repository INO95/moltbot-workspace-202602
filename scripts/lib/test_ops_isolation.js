const fs = require('fs');
const os = require('os');
const path = require('path');

function sanitizeTag(tag) {
    const raw = String(tag || 'ops-test').trim().toLowerCase();
    const normalized = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-');
    return normalized || 'ops-test';
}

function ensureTestOpsIsolation(tag = 'ops-test') {
    const existingCommandsRoot = String(process.env.OPS_COMMANDS_ROOT || '').trim();
    const existingPendingState = String(process.env.OPS_PENDING_APPROVALS_STATE_PATH || '').trim();
    const existingHintsPath = String(process.env.OPS_LAST_APPROVAL_HINTS_PATH || '').trim();
    if (existingCommandsRoot && existingPendingState) {
        return {
            opsCommandsRoot: existingCommandsRoot,
            pendingStatePath: existingPendingState,
            lastApprovalHintsPath: existingHintsPath || '',
        };
    }

    const safeTag = sanitizeTag(tag);
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), `moltbot-${safeTag}-`));
    const opsCommandsRoot = path.join(baseRoot, 'ops', 'commands');
    const pendingStatePath = path.join(baseRoot, 'data', 'state', 'pending_approvals.json');
    const lastApprovalHintsPath = path.join(baseRoot, 'data', 'runtime', 'ops_last_approval_hints.json');

    fs.mkdirSync(path.dirname(pendingStatePath), { recursive: true });
    fs.mkdirSync(path.dirname(lastApprovalHintsPath), { recursive: true });
    process.env.OPS_COMMANDS_ROOT = opsCommandsRoot;
    process.env.OPS_PENDING_APPROVALS_STATE_PATH = pendingStatePath;
    process.env.OPS_LAST_APPROVAL_HINTS_PATH = lastApprovalHintsPath;

    return {
        baseRoot,
        opsCommandsRoot,
        pendingStatePath,
        lastApprovalHintsPath,
    };
}

module.exports = {
    ensureTestOpsIsolation,
};
