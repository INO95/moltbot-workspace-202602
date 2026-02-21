const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const config = require('../../data/config.json');
const opsLogger = require('../ops_logger');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_ALLOWLIST_PATH = path.join(ROOT, 'data', 'policy', 'exec_allowlist.json');

function resolveAllowlistPath() {
    const section = (config && typeof config.opsUnifiedApprovals === 'object')
        ? config.opsUnifiedApprovals
        : {};
    const raw = String(section.allowlistPath || '').trim();
    if (!raw) return DEFAULT_ALLOWLIST_PATH;
    return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function readPolicy() {
    const filePath = resolveAllowlistPath();
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') throw new Error('invalid_policy');
        return {
            version: Number(parsed.version || 1),
            defaultDecision: String(parsed.defaultDecision || 'approval_required').trim().toLowerCase() || 'approval_required',
            ttlSeconds: Number(parsed.ttlSeconds || 600),
            allow: Array.isArray(parsed.allow) ? parsed.allow : [],
            requireApproval: Array.isArray(parsed.requireApproval) ? parsed.requireApproval : [],
            denylist: Array.isArray(parsed.denylist) ? parsed.denylist : [],
            sourcePath: filePath,
        };
    } catch (_) {
        return {
            version: 1,
            defaultDecision: 'approval_required',
            ttlSeconds: 600,
            allow: [],
            requireApproval: [],
            denylist: [],
            sourcePath: filePath,
        };
    }
}

function toRegex(pattern) {
    try {
        return new RegExp(String(pattern || ''), 'i');
    } catch (_) {
        return null;
    }
}

function normalizeCommand(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    return value;
}

function resolveCommand(payload = {}) {
    return normalizeCommand(
        payload.command
        || payload.task
        || payload.content
        || payload.body
        || payload.script
        || payload.value
        || '',
    );
}

function matchRules(rules, command) {
    const out = [];
    for (const row of (Array.isArray(rules) ? rules : [])) {
        const re = toRegex(row && row.pattern);
        if (!re) continue;
        if (!re.test(command)) continue;
        out.push({
            id: String((row && row.id) || 'rule').trim() || 'rule',
            warning: String((row && row.warning) || '').trim(),
            mode: String((row && row.mode) || '').trim().toLowerCase(),
        });
    }
    return out;
}

function classifyCommand(command, policy) {
    const normalized = normalizeCommand(command);
    if (!normalized) {
        return {
            decision: 'invalid',
            riskTier: 'HIGH',
            requiresApproval: true,
            warnings: ['command is empty'],
            matched: [],
        };
    }

    const denyMatched = matchRules(policy.denylist, normalized);
    if (denyMatched.length > 0) {
        const warnings = denyMatched
            .map((row) => row.warning || `denylist matched: ${row.id}`)
            .filter(Boolean);
        return {
            decision: 'approval_required',
            riskTier: 'HIGH',
            requiresApproval: true,
            warnings,
            matched: denyMatched.map((row) => row.id),
        };
    }

    const requireMatched = matchRules(policy.requireApproval, normalized);
    if (requireMatched.length > 0) {
        return {
            decision: 'approval_required',
            riskTier: 'HIGH',
            requiresApproval: true,
            warnings: [],
            matched: requireMatched.map((row) => row.id),
        };
    }

    const allowMatched = matchRules(policy.allow, normalized);
    if (allowMatched.length > 0) {
        return {
            decision: 'auto_execute',
            riskTier: 'MEDIUM',
            requiresApproval: false,
            warnings: [],
            matched: allowMatched.map((row) => row.id),
        };
    }

    const fallbackRequiresApproval = String(policy.defaultDecision || 'approval_required') !== 'auto_execute';
    return {
        decision: fallbackRequiresApproval ? 'approval_required' : 'auto_execute',
        riskTier: fallbackRequiresApproval ? 'HIGH' : 'MEDIUM',
        requiresApproval: fallbackRequiresApproval,
        warnings: fallbackRequiresApproval ? ['allowlist miss: approval required'] : [],
        matched: [],
    };
}

function plan(input = {}) {
    const action = 'run';
    const payload = (input.payload && typeof input.payload === 'object') ? input.payload : {};
    const command = resolveCommand(payload);
    if (!command) {
        return {
            ok: false,
            error_code: 'COMMAND_REQUIRED',
            error: 'exec run requires command text.',
            plan: null,
        };
    }

    const policy = readPolicy();
    const classified = classifyCommand(command, policy);
    if (classified.decision === 'invalid') {
        return {
            ok: false,
            error_code: 'COMMAND_REQUIRED',
            error: 'exec command is empty.',
            plan: null,
        };
    }

    const requiresApproval = Boolean(classified.requiresApproval);
    return {
        ok: true,
        plan: {
            command_kind: 'capability',
            capability: 'exec',
            action,
            intent_action: 'capability:exec:run',
            payload: {
                ...payload,
                command,
            },
            action_type: 'exec',
            connector: {
                available: true,
                command: 'sh -lc',
            },
            policy_source: policy.sourcePath,
            policy_match: classified.matched,
            blockers: [],
            warnings: classified.warnings,
            risk_tier: classified.riskTier,
            mutating: requiresApproval,
            requires_approval: requiresApproval,
            required_flags: requiresApproval ? ['force'] : [],
            plan_summary: `exec run: ${command.slice(0, 120)}`,
            operations: [{ kind: 'exec', command_preview: command.slice(0, 120) }],
            rollback_instructions: requiresApproval
                ? ['exec command can change host/container state. verify side effects manually.']
                : [],
        },
    };
}

function clampText(value, maxLen = 400) {
    const text = String(value || '');
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}...(truncated)`;
}

function commandHash(command) {
    return crypto.createHash('sha256').update(String(command || ''), 'utf8').digest('hex').slice(0, 24);
}

function execute(input = {}) {
    const planPayload = (input.plan && typeof input.plan === 'object') ? input.plan : {};
    const payload = (planPayload.payload && typeof planPayload.payload === 'object') ? planPayload.payload : {};
    const command = resolveCommand(payload);
    if (!command) {
        return {
            ok: false,
            error_code: 'COMMAND_REQUIRED',
            error: 'exec command is empty.',
        };
    }

    const timeoutMs = Number(process.env.EXEC_CAPABILITY_TIMEOUT_MS || 120000);
    const run = spawnSync('sh', ['-lc', command], {
        encoding: 'utf8',
        timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
        maxBuffer: 1024 * 1024,
    });

    const stdout = opsLogger.redact(String(run.stdout || ''));
    const stderr = opsLogger.redact(String(run.stderr || ''));
    const ok = !run.error && run.status === 0;
    const errorMessage = run.error
        ? String(run.error.message || run.error)
        : (ok ? '' : (stderr || `command failed with exit ${run.status}`));

    return {
        ok,
        action: 'run',
        exit_code: Number.isFinite(run.status) ? run.status : 1,
        command_hash: commandHash(command),
        summary: ok
            ? `exec command completed (exit ${Number.isFinite(run.status) ? run.status : 0})`
            : `exec command failed (exit ${Number.isFinite(run.status) ? run.status : 1})`,
        note: ok ? 'allowlist policy applied' : '',
        stdout_preview: clampText(stdout, 600),
        stderr_preview: clampText(stderr, 600),
        error_code: ok ? null : 'EXEC_COMMAND_FAILED',
        error: ok ? null : clampText(errorMessage, 220),
    };
}

module.exports = {
    capability: 'exec',
    supportedActions: ['run'],
    plan,
    execute,
    classifyCommand,
};
