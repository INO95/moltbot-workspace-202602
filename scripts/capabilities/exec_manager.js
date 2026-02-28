const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const config = require('../../data/config.json');
const opsLogger = require('../ops_logger');
const envRuntime = require('../env_runtime');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_ALLOWLIST_PATH = path.join(ROOT, 'data', 'policy', 'exec_allowlist.json');
const BOT_CONTAINER_MAP = Object.freeze({
    'bot-dev': 'moltbot-dev',
    'bot-anki': 'moltbot-anki',
    'bot-research': 'moltbot-research',
    'bot-daily': 'moltbot-daily',
    'bot-dev-bak': 'moltbot-dev-bak',
    'bot-anki-bak': 'moltbot-anki-bak',
    'bot-research-bak': 'moltbot-research-bak',
    'bot-daily-bak': 'moltbot-daily-bak',
});
const GOG_DEFAULT_CONTAINERS = Object.freeze([
    'moltbot-daily',
    'moltbot-dev',
    'moltbot-research',
    'moltbot-anki',
]);
const DEFAULT_EXEC_CWD = String(process.env.EXEC_CAPABILITY_DEFAULT_CWD || '/Users/inho-baek/Projects').trim() || '/Users/inho-baek/Projects';

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

function isUnifiedApprovalsEnabled() {
    const envRaw = String(process.env.MOLTBOT_DISABLE_APPROVAL_TOKENS || '').trim().toLowerCase();
    if (envRaw === '1' || envRaw === 'true' || envRaw === 'on') return false;
    if (envRaw === '0' || envRaw === 'false' || envRaw === 'off') return true;
    const section = (config && typeof config.opsUnifiedApprovals === 'object')
        ? config.opsUnifiedApprovals
        : {};
    return section.enabled !== false;
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

function hasShellMetaChain(command) {
    const raw = String(command || '');
    if (!raw.trim()) return false;
    if (/\n/.test(raw)) return true;
    if (/[;`]/.test(raw)) return true;
    if (/&&/.test(raw) || /\|\|/.test(raw)) return true;
    if (/\$\(/.test(raw)) return true;
    if (/>/.test(raw) || /</.test(raw)) return true;
    if (/\|/.test(raw)) return true;
    return false;
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

    if (!isUnifiedApprovalsEnabled()) {
        return {
            decision: 'auto_execute',
            riskTier: 'MEDIUM',
            requiresApproval: false,
            warnings: ['unified approvals disabled: auto execute'],
            matched: ['unified_approvals_disabled'],
        };
    }

    if (hasShellMetaChain(normalized)) {
        return {
            decision: 'approval_required',
            riskTier: 'HIGH',
            requiresApproval: true,
            warnings: ['shell meta/chain detected: approval required'],
            matched: ['meta_chain_guard'],
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

function stripOuterQuotes(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (
        (text.startsWith('"') && text.endsWith('"'))
        || (text.startsWith('\'') && text.endsWith('\''))
    ) {
        return text.slice(1, -1);
    }
    return text;
}

function pushUnique(list, value) {
    const key = String(value || '').trim();
    if (!key) return;
    if (!list.includes(key)) list.push(key);
}

function resolveRuntimeEnvValue(key) {
    const envKey = String(key || '').trim();
    if (!envKey) return '';
    const direct = stripOuterQuotes(process.env[envKey] || '');
    if (direct) return direct;
    try {
        envRuntime.loadRuntimeEnv({
            allowLegacyFallback: true,
            required: false,
            override: false,
            silent: true,
        });
    } catch (_) {
        // no-op: fallback to existing process env only
    }
    return stripOuterQuotes(process.env[envKey] || '');
}

function isGogCommand(command) {
    return /^\s*gog(?:\s|$)/i.test(String(command || ''));
}

function resolveGogContainers(payload = {}) {
    const out = [];
    const source = payload && typeof payload === 'object' ? payload : {};
    const explicit = [
        source.container,
        source.exec_container,
        source.target_container,
        source.runtime_container,
    ];
    for (const value of explicit) {
        pushUnique(out, value);
    }

    const botId = String(
        source.origin_bot_id
        || source.bot_id
        || source.runtime_bot_id
        || process.env.MOLTBOT_BOT_ID
        || '',
    ).trim().toLowerCase();
    if (botId && BOT_CONTAINER_MAP[botId]) {
        pushUnique(out, BOT_CONTAINER_MAP[botId]);
    }

    pushUnique(out, process.env.EXEC_CAPABILITY_GOG_CONTAINER || process.env.GOG_EXEC_CONTAINER || '');
    for (const name of GOG_DEFAULT_CONTAINERS) {
        pushUnique(out, name);
    }
    return out;
}

function resolveExecCwd(payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const raw = String(source.cwd || source.workdir || source.dir || '').trim();
    if (raw) return raw;
    return DEFAULT_EXEC_CWD;
}

function runShellCommand(command, timeoutMs, cwd) {
    return spawnSync('sh', ['-lc', command], {
        encoding: 'utf8',
        cwd: String(cwd || DEFAULT_EXEC_CWD),
        timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
        maxBuffer: 1024 * 1024,
    });
}

function runCommand(command, timeoutMs, payload = {}) {
    const cwd = resolveExecCwd(payload);
    if (!isGogCommand(command)) {
        return {
            run: runShellCommand(command, timeoutMs, cwd),
            mode: 'shell',
            container: '',
            cwd,
        };
    }

    const candidates = resolveGogContainers(payload);
    const keyringPassword = resolveRuntimeEnvValue('GOG_KEYRING_PASSWORD');
    for (const containerName of candidates) {
        const args = ['exec'];
        if (keyringPassword) {
            args.push('-e', `GOG_KEYRING_PASSWORD=${keyringPassword}`);
        }
        args.push('-w', cwd, containerName, 'sh', '-lc', command);
        const attempt = spawnSync('docker', args, {
            encoding: 'utf8',
            timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
            maxBuffer: 1024 * 1024,
        });
        const stderrText = String(attempt.stderr || '');
        const missingContainer = !attempt.error && attempt.status !== 0 && /No such container/i.test(stderrText);
        if (missingContainer) continue;
        return {
            run: attempt,
            mode: 'docker',
            container: containerName,
            cwd,
        };
    }

    return {
        run: runShellCommand(command, timeoutMs, cwd),
        mode: 'shell_fallback',
        container: '',
        cwd,
    };
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
    const execution = runCommand(command, timeoutMs, payload);
    const run = execution.run;

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
        note: ok
            ? (execution.mode === 'docker'
                ? `allowlist policy applied (docker:${execution.container})`
                : 'allowlist policy applied')
            : '',
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
