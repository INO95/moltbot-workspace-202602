const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function commandExists(command) {
    const res = spawnSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
    return !res.error && res.status === 0;
}

function normalizeAction(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return 'list';
    if (key === 'capture') return 'capture';
    if (key === 'list') return 'list';
    if (key === 'cleanup') return 'cleanup';
    return null;
}

function resolvePhotoRoot(payload = {}) {
    const raw = String(payload.path || payload.target_path || '').trim();
    return raw ? path.resolve(raw) : path.join(os.homedir(), 'Pictures');
}

function listPhotoFiles(dirPath) {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
    const allowedExt = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);
    return fs.readdirSync(dirPath)
        .filter((name) => allowedExt.has(path.extname(name).toLowerCase()))
        .sort()
        .map((name) => {
            const abs = path.join(dirPath, name);
            const stat = fs.statSync(abs);
            return {
                path: abs,
                size: stat.size,
                mtime: stat.mtime.toISOString(),
            };
        });
}

function plan(input = {}) {
    const action = normalizeAction(input.action);
    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported photo action: ${input.action || ''}`,
            plan: null,
        };
    }

    const payload = (input.payload && typeof input.payload === 'object') ? input.payload : {};
    const rootPath = resolvePhotoRoot(payload);
    const connectorAvailable = commandExists('camsnap');

    const blockers = [];
    if (action === 'capture' && !connectorAvailable) {
        blockers.push({
            code: 'CONNECTOR_UNAVAILABLE',
            message: 'photo capture connector unavailable: install `camsnap` before using capture action.',
        });
    }

    return {
        ok: true,
        plan: {
            command_kind: 'capability',
            capability: 'photo',
            action,
            intent_action: `capability:photo:${action}`,
            payload,
            root_path: rootPath,
            connector: {
                available: connectorAvailable,
                command: 'camsnap',
            },
            blockers,
            risk_tier: action === 'cleanup' ? 'HIGH' : 'MEDIUM',
            mutating: action === 'cleanup',
            requires_approval: action === 'cleanup',
            required_flags: action === 'cleanup' ? ['force'] : [],
            plan_summary: `photo ${action} @ ${rootPath}`,
            operations: [{ kind: action, root_path: rootPath }],
            rollback_instructions: action === 'cleanup'
                ? ['cleanup deletes files permanently; restore from backup if needed.']
                : [],
        },
    };
}

function execute(input = {}) {
    const planPayload = input.plan && typeof input.plan === 'object' ? input.plan : {};
    const action = normalizeAction(input.action || planPayload.action);
    const payload = (planPayload.payload && typeof planPayload.payload === 'object') ? planPayload.payload : {};
    const rootPath = String(planPayload.root_path || resolvePhotoRoot(payload));

    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported photo action: ${input.action || ''}`,
        };
    }

    if (action === 'list') {
        const rows = listPhotoFiles(rootPath);
        return {
            ok: true,
            action,
            root_path: rootPath,
            files: rows.slice(0, 50),
            total: rows.length,
        };
    }

    if (action === 'capture') {
        if (!commandExists('camsnap')) {
            return {
                ok: false,
                error_code: 'CONNECTOR_UNAVAILABLE',
                error: 'photo capture connector unavailable: install `camsnap` before using capture action.',
            };
        }
        fs.mkdirSync(rootPath, { recursive: true });
        const outPath = path.join(rootPath, `capture_${Date.now()}.jpg`);
        const res = spawnSync('camsnap', ['-o', outPath], { encoding: 'utf8' });
        if (res.error || res.status !== 0) {
            return {
                ok: false,
                error_code: 'CAPTURE_FAILED',
                error: String(res.stderr || (res.error && res.error.message) || 'capture failed').trim(),
                action,
            };
        }
        return {
            ok: true,
            action,
            path: outPath,
        };
    }

    if (action === 'cleanup') {
        if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
            return {
                ok: false,
                error_code: 'PHOTO_DIR_MISSING',
                error: `Photo directory not found: ${rootPath}`,
                action,
            };
        }
        const olderThanHours = Math.max(1, Number(payload.older_than_hours || 24 * 30));
        const cutoff = Date.now() - (olderThanHours * 60 * 60 * 1000);
        const all = listPhotoFiles(rootPath);
        const targets = all.filter((row) => Date.parse(row.mtime) < cutoff);
        const limit = Math.max(1, Math.min(1000, Number(payload.limit || 50)));
        const removed = [];
        for (const row of targets.slice(0, limit)) {
            fs.rmSync(row.path, { force: false });
            removed.push(row.path);
        }
        return {
            ok: true,
            action,
            root_path: rootPath,
            removed_count: removed.length,
            removed,
            older_than_hours: olderThanHours,
        };
    }

    return {
        ok: false,
        error_code: 'UNSUPPORTED_ACTION',
        error: `Unsupported photo action: ${action}`,
    };
}

module.exports = {
    capability: 'photo',
    supportedActions: ['capture', 'list', 'cleanup'],
    plan,
    execute,
};
