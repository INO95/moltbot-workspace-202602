const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OPENCLAW_CONFIG_SECRETS_SCRIPT = path.join(ROOT, 'scripts', 'openclaw_config_secrets.js');

const KNOWN_TARGETS = Object.freeze({
    dev: 'moltbot-dev',
    anki: 'moltbot-anki',
    research: 'moltbot-research',
    daily: 'moltbot-daily',
    dev_bak: 'moltbot-dev-bak',
    anki_bak: 'moltbot-anki-bak',
    research_bak: 'moltbot-research-bak',
    daily_bak: 'moltbot-daily-bak',
    proxy: 'moltbot-proxy',
    webproxy: 'moltbot-web-proxy',
    tunnel: 'moltbot-dev-tunnel',
    prompt: 'moltbot-prompt-web',
});

const ALL_TARGETS = Object.freeze([
    'moltbot-dev',
    'moltbot-anki',
    'moltbot-research',
    'moltbot-daily',
    'moltbot-dev-bak',
    'moltbot-anki-bak',
    'moltbot-research-bak',
    'moltbot-daily-bak',
    'moltbot-prompt-web',
    'moltbot-proxy',
    'moltbot-web-proxy',
    'moltbot-dev-tunnel',
]);
const CONTAINER_TO_PROFILE = Object.freeze({
    'moltbot-dev': 'dev',
    'moltbot-anki': 'anki',
    'moltbot-research': 'research',
    'moltbot-daily': 'daily',
    'moltbot-dev-bak': 'dev_bak',
    'moltbot-anki-bak': 'anki_bak',
    'moltbot-research-bak': 'research_bak',
    'moltbot-daily-bak': 'daily_bak',
});
const DISPATCH_WORKDIR = '/home/node/.openclaw/workspace';

function parseLastJsonLine(stdout) {
    const lines = String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
            return JSON.parse(lines[i]);
        } catch (_) {
            // Ignore non-JSON lines.
        }
    }
    return null;
}

function runDocker(args) {
    const res = spawnSync('docker', args, { encoding: 'utf8' });
    return {
        ok: !res.error && res.status === 0,
        code: res.status == null ? 1 : res.status,
        stdout: String(res.stdout || '').trim(),
        stderr: String(res.stderr || '').trim(),
        error: res.error ? String(res.error.message || res.error) : '',
    };
}

function runNode(args) {
    const res = spawnSync('node', args, {
        encoding: 'utf8',
        cwd: ROOT,
    });
    return {
        ok: !res.error && res.status === 0,
        code: res.status == null ? 1 : res.status,
        stdout: String(res.stdout || '').trim(),
        stderr: String(res.stderr || '').trim(),
        error: res.error ? String(res.error.message || res.error) : '',
    };
}

function ensureProfileSecrets(profile) {
    const key = String(profile || '').trim();
    if (!key) {
        return {
            ok: false,
            code: 1,
            error: 'profile missing',
        };
    }
    return runNode([OPENCLAW_CONFIG_SECRETS_SCRIPT, 'inject', key]);
}

function normalizeAction(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return 'status';
    if (key === 'list') return 'list';
    if (key === 'status') return 'status';
    if (key === 'restart') return 'restart';
    if (key === 'dispatch') return 'dispatch';
    return null;
}

function resolveTargets(rawTarget) {
    const key = String(rawTarget || 'all').trim().toLowerCase();
    if (!key || key === 'all' || key === '전체') return [...ALL_TARGETS];
    if (KNOWN_TARGETS[key]) return [KNOWN_TARGETS[key]];
    if (key.startsWith('moltbot-')) return [key];
    return [];
}

function resolveDispatchTarget(payload = {}) {
    const profileKey = String(payload.target_profile || payload.target || payload.container || '').trim().toLowerCase();
    if (!profileKey) {
        return {
            ok: false,
            error_code: 'TARGET_REQUIRED',
            error: 'dispatch requires target_profile or target',
        };
    }

    let container = '';
    let profile = '';
    if (KNOWN_TARGETS[profileKey]) {
        container = KNOWN_TARGETS[profileKey];
        profile = profileKey;
    } else if (profileKey.startsWith('moltbot-')) {
        container = profileKey;
        profile = CONTAINER_TO_PROFILE[container] || '';
    }

    if (!container) {
        return {
            ok: false,
            error_code: 'TARGET_REQUIRED',
            error: `unknown dispatch target: ${profileKey}`,
        };
    }

    if (profile === 'daily' || profile === 'daily_bak') {
        return {
            ok: false,
            error_code: 'TARGET_NOT_ALLOWED',
            error: 'dispatch target must be a worker profile (dev/anki/research)',
        };
    }

    return {
        ok: true,
        container,
        profile: profile || null,
    };
}

function buildStatusRows(targets, psOutput) {
    const lines = String(psOutput || '').split('\n').filter(Boolean);
    const map = new Map();
    for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 2) continue;
        const name = String(parts[0] || '').trim();
        const state = String(parts[1] || '').trim();
        const statusText = String(parts.slice(2).join('\t') || '').trim() || state || 'unknown';
        if (!name) continue;
        map.set(name, { name, state, statusText });
    }
    return targets.map((name) => {
        const row = map.get(name);
        if (!row) {
            return {
                name,
                state: 'missing',
                statusText: 'not-found',
            };
        }
        return row;
    });
}

function plan(input = {}) {
    const action = normalizeAction(input.action);
    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported bot action: ${input.action || ''}`,
            plan: null,
        };
    }

    const payload = (input.payload && typeof input.payload === 'object') ? input.payload : {};
    if (action === 'dispatch') {
        const dispatchTarget = resolveDispatchTarget(payload);
        if (!dispatchTarget.ok) {
            return {
                ok: false,
                error_code: dispatchTarget.error_code,
                error: dispatchTarget.error,
                plan: null,
            };
        }
        const originalMessage = String(payload.original_message || '').trim();
        if (!originalMessage) {
            return {
                ok: false,
                error_code: 'ORIGINAL_MESSAGE_REQUIRED',
                error: 'dispatch requires payload.original_message',
                plan: null,
            };
        }
        const route = String(payload.route || '').trim().toLowerCase() || 'none';
        const targets = [dispatchTarget.container];
        const targetLabel = dispatchTarget.profile || dispatchTarget.container;
        return {
            ok: true,
            plan: {
                command_kind: 'capability',
                capability: 'bot',
                action,
                intent_action: `capability:bot:${action}`,
                payload: {
                    ...payload,
                    route,
                    target: dispatchTarget.container,
                    target_profile: dispatchTarget.profile,
                    targets,
                    original_message: originalMessage,
                },
                targets,
                risk_tier: 'MEDIUM',
                mutating: false,
                requires_approval: false,
                required_flags: [],
                plan_summary: `bot dispatch: ${route} -> ${targetLabel}`,
                operations: [{
                    kind: 'dispatch',
                    target: dispatchTarget.container,
                    target_profile: dispatchTarget.profile,
                    route,
                }],
                rollback_instructions: [],
            },
        };
    }

    const target = String(payload.target || payload.container || 'all').trim();
    const targets = resolveTargets(target);
    if (!targets.length) {
        return {
            ok: false,
            error_code: 'TARGET_REQUIRED',
            error: `No valid target for bot action: ${target || '(empty)'}`,
            plan: null,
        };
    }

    return {
        ok: true,
        plan: {
            command_kind: 'capability',
            capability: 'bot',
            action,
            intent_action: `capability:bot:${action}`,
            payload: {
                ...payload,
                target,
                targets,
            },
            targets,
            risk_tier: 'MEDIUM',
            mutating: action === 'restart',
            requires_approval: false,
            required_flags: [],
            plan_summary: `bot ${action}: ${targets.join(', ')}`,
            operations: [{ kind: action, targets }],
            rollback_instructions: [],
        },
    };
}

function execute(input = {}) {
    const planPayload = (input.plan && input.plan.payload && typeof input.plan.payload === 'object')
        ? input.plan.payload
        : {};
    const action = normalizeAction(input.action || input.plan && input.plan.action);
    const targets = Array.isArray(planPayload.targets)
        ? planPayload.targets
        : resolveTargets(planPayload.target || 'all');

    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported bot action: ${input.action || ''}`,
        };
    }

    if (action === 'dispatch') {
        const dispatchTarget = resolveDispatchTarget(planPayload);
        if (!dispatchTarget.ok) {
            return {
                ok: false,
                action,
                error_code: dispatchTarget.error_code,
                error: dispatchTarget.error,
            };
        }
        const originalMessage = String(planPayload.original_message || '').trim();
        if (!originalMessage) {
            return {
                ok: false,
                action,
                error_code: 'ORIGINAL_MESSAGE_REQUIRED',
                error: 'dispatch requires payload.original_message',
            };
        }
        const delegatedRoute = String(planPayload.route || '').trim().toLowerCase() || 'none';
        const delegated = runDocker([
            'exec',
            '-w',
            DISPATCH_WORKDIR,
            dispatchTarget.container,
            'node',
            'scripts/bridge.js',
            'auto',
            originalMessage,
        ]);
        if (!delegated.ok) {
            return {
                ok: false,
                action,
                error_code: 'DISPATCH_EXEC_FAILED',
                error: delegated.stderr || delegated.error || 'docker exec bridge auto failed',
                target_container: dispatchTarget.container,
                target_profile: dispatchTarget.profile,
                route: delegatedRoute,
            };
        }

        const delegatedParsed = parseLastJsonLine(delegated.stdout);
        const delegatedFailed = Boolean(
            delegatedParsed
            && typeof delegatedParsed === 'object'
            && (delegatedParsed.ok === false || delegatedParsed.success === false),
        );
        if (delegatedFailed) {
            return {
                ok: false,
                action,
                error_code: 'DISPATCH_DELEGATED_FAILED',
                error: String(delegatedParsed.error || delegatedParsed.errorCode || 'delegated bridge returned failure'),
                route: delegatedRoute,
                delegated_route: delegatedParsed.route || null,
                target_container: dispatchTarget.container,
                target_profile: dispatchTarget.profile,
                delegated: delegatedParsed,
                telegramReply: String(delegatedParsed.telegramReply || '').trim() || null,
            };
        }

        const delegatedReply = delegatedParsed && typeof delegatedParsed === 'object'
            ? String(delegatedParsed.telegramReply || '').trim()
            : '';
        const targetLabel = dispatchTarget.profile || dispatchTarget.container;
        return {
            ok: true,
            action,
            route: delegatedRoute,
            delegated_route: delegatedParsed && delegatedParsed.route ? String(delegatedParsed.route) : null,
            target_container: dispatchTarget.container,
            target_profile: dispatchTarget.profile,
            delegated: delegatedParsed || null,
            summary: `dispatch ${delegatedRoute} -> ${targetLabel}`,
            telegramReply: delegatedReply || `위임 처리 완료: ${delegatedRoute} -> ${targetLabel}`,
            executed_steps: [{
                step: `dispatch:${dispatchTarget.container}`,
                ok: true,
            }],
        };
    }

    if (action === 'list' || action === 'status') {
        const ps = runDocker(['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}']);
        if (!ps.ok) {
            return {
                ok: false,
                error_code: 'DOCKER_PS_FAILED',
                error: ps.stderr || ps.error || 'docker ps failed',
                action,
            };
        }
        const rows = buildStatusRows(targets, ps.stdout);
        return {
            ok: true,
            action,
            targets,
            rows,
            summary: `status rows=${rows.length}`,
        };
    }

    if (action === 'restart') {
        const items = [];
        const preflightCache = new Map();
        for (const container of targets) {
            const profile = CONTAINER_TO_PROFILE[container] || '';
            let preflight = null;
            if (profile) {
                if (!preflightCache.has(profile)) {
                    preflightCache.set(profile, ensureProfileSecrets(profile));
                }
                preflight = preflightCache.get(profile);
            }
            if (preflight && !preflight.ok) {
                items.push({
                    container,
                    profile: profile || null,
                    ok: false,
                    code: preflight.code,
                    stderr: preflight.stderr,
                    error: preflight.error || 'openclaw_config_secrets inject failed',
                    preflight: {
                        action: 'inject_secrets',
                        profile,
                        ok: false,
                    },
                });
                continue;
            }
            const res = runDocker(['restart', container]);
            items.push({
                container,
                profile: profile || null,
                ok: res.ok,
                code: res.code,
                stderr: res.stderr,
                error: res.error,
                preflight: profile
                    ? {
                        action: 'inject_secrets',
                        profile,
                        ok: true,
                    }
                    : null,
            });
        }
        return {
            ok: items.every((item) => item.ok),
            action,
            targets,
            items,
            error_code: items.every((item) => item.ok) ? null : 'DOCKER_RESTART_FAILED',
            error: items.every((item) => item.ok)
                ? ''
                : items.filter((item) => !item.ok).map((item) => `${item.container}: ${item.stderr || item.error || 'failed'}`).join(' | '),
        };
    }

    return {
        ok: false,
        error_code: 'UNSUPPORTED_ACTION',
        error: `Unsupported bot action: ${action}`,
    };
}

module.exports = {
    capability: 'bot',
    supportedActions: ['list', 'status', 'restart', 'dispatch'],
    plan,
    execute,
};
