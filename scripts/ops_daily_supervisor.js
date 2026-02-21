#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadRuntimeEnv } = require('./env_runtime');
const { enqueueBridgePayload } = require('./bridge_queue');
const rules = require('./ops_rules');
const store = require('./ops_state_store');
const opsCommandQueue = require('./ops_command_queue');

const ROOT = process.env.OPS_WORKSPACE_ROOT
    ? path.resolve(String(process.env.OPS_WORKSPACE_ROOT))
    : path.join(__dirname, '..');
const LOGS_ROOT = path.join(ROOT, 'logs');
const SANDBOXES_ROOT = path.join(ROOT, '.openclaw-sandboxes');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'ops', 'config', 'daily_ops_mvp.json');
const DEFAULT_REMEDIATION_POLICY_PATH = path.join(ROOT, 'ops', 'config', 'remediation_policy.json');
const SANDBOX_EXPORT_LOG_FILES = Object.freeze([
    path.join('logs', 'nightly_autopilot_latest.json'),
    path.join('logs', 'cron_guard_latest.json'),
    path.join('logs', 'notion_sync_dashboard_latest.json'),
    path.join('logs', 'model_cost_latency_dashboard_latest.json'),
    path.join('logs', 'system_healthcheck_latest.json'),
]);
const TELEGRAM_LOG_SCAN_WINDOW_MINUTES = Math.max(5, Number(process.env.OPS_DAILY_TELEGRAM_LOG_SCAN_WINDOW_MINUTES || 20));
const TELEGRAM_LOG_SCAN_TAIL_LINES = Math.max(50, Number(process.env.OPS_DAILY_TELEGRAM_LOG_SCAN_TAIL_LINES || 300));
const TELEGRAM_LOG_ERROR_LINE_LIMIT = Math.max(1, Number(process.env.OPS_DAILY_TELEGRAM_LOG_ERROR_LINE_LIMIT || 5));
const DEFAULT_HEALTH_POLICY = Object.freeze({
    heartbeat_stall_minutes: 15,
    stale_warn_minutes: 45,
    down_heartbeat_minutes: 6 * 60,
    down_requires_telegram_failure_when_container_running: true,
    no_signal_status: 'UNKNOWN',
    idle_stale_status: 'WARN',
});

const DEFAULT_CONFIG = Object.freeze({
    schema_version: '1.0',
    timezone: 'Asia/Tokyo',
    scan_interval_minutes: 30,
    alerting: {
        enabled: false,
        transport: 'bridge_queue',
        p2_consecutive_failures_threshold: 3,
        cooldown_hours: 2,
        quiet_hours: {
            start: '23:00',
            end: '07:00',
        },
    },
    briefings: {
        morning_time: '08:30',
        evening_time: '18:30',
        send: false,
    },
    health_policy: {
        ...DEFAULT_HEALTH_POLICY,
    },
    workers: {
        'bot-dev': { active: true, logical_bot_id: 'bot-a', profile: 'dev', container: 'moltbot-dev' },
        'bot-anki': { active: true, logical_bot_id: 'bot-b', profile: 'anki', container: 'moltbot-anki' },
        'bot-research': { active: true, logical_bot_id: 'bot-c', profile: 'research', container: 'moltbot-research' },
        'bot-d': { active: false, logical_bot_id: 'bot-d', profile: 'reserved', container: '' },
    },
});

const DEFAULT_REMEDIATION_POLICY = Object.freeze({
    schema_version: '1.0',
    mode: 'low_risk_auto',
    defaults: {
        cooldown_minutes: 30,
        max_attempts: 1,
        rearm_on_recovery: true,
    },
    rules: [
        {
            issue_pattern: ':heartbeat_stall$',
            enabled: true,
            auto_actions: [{ capability: 'bot', action: 'restart', target: 'worker_container' }],
            cooldown_minutes: 30,
            max_attempts: 1,
            escalation_rule: 'alert_if_repeated',
        },
        {
            issue_pattern: ':bot_down$',
            enabled: true,
            auto_actions: [{ capability: 'bot', action: 'restart', target: 'worker_container' }],
            cooldown_minutes: 15,
            max_attempts: 2,
            escalation_rule: 'immediate_alert',
        },
        {
            issue_pattern: ':telegram_auth_invalid$',
            enabled: true,
            auto_actions: [
                { capability: 'bot', action: 'restart', target: 'worker_container' },
                { capability: 'bot', action: 'status', target: 'worker_container' },
            ],
            cooldown_minutes: 15,
            max_attempts: 2,
            escalation_rule: 'immediate_alert',
        },
        {
            issue_pattern: ':telegram_channel_exited$',
            enabled: true,
            auto_actions: [{ capability: 'bot', action: 'restart', target: 'worker_container' }],
            cooldown_minutes: 20,
            max_attempts: 2,
            escalation_rule: 'alert_if_repeated',
        },
        {
            issue_pattern: ':schema_violation$',
            enabled: true,
            auto_actions: [],
            cooldown_minutes: 60,
            max_attempts: 0,
            escalation_rule: 'alert_only',
        },
    ],
});

function isoNow(input) {
    const date = input instanceof Date ? input : (input ? new Date(input) : new Date());
    return date.toISOString();
}

function safeReadJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function writeTextAtomic(filePath, text) {
    ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, String(text || ''), 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function writeJsonAtomic(filePath, data) {
    writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function parseCsvList(raw) {
    return String(raw || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function listSandboxExportDirs() {
    const explicit = parseCsvList(process.env.OPS_DAILY_SANDBOX_EXPORT_DIRS);
    if (explicit.length > 0) {
        return explicit
            .map((item) => (path.isAbsolute(item) ? item : path.join(ROOT, item)))
            .filter((dirPath) => fs.existsSync(dirPath));
    }
    if (!fs.existsSync(SANDBOXES_ROOT)) return [];
    return fs.readdirSync(SANDBOXES_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^agent-main(?:-|$)/.test(entry.name))
        .map((entry) => path.join(SANDBOXES_ROOT, entry.name));
}

function copyJsonFile(sourcePath, targetPath) {
    if (!fs.existsSync(sourcePath)) {
        return { sourcePath, targetPath, status: 'missing' };
    }
    const parsed = safeReadJson(sourcePath, null);
    if (!parsed || typeof parsed !== 'object') {
        return { sourcePath, targetPath, status: 'invalid_json' };
    }
    writeJsonAtomic(targetPath, parsed);
    return { sourcePath, targetPath, status: 'ok' };
}

function buildLeaderSnapshot({ nowIso, config, state, issuesDoc, findings, remediations, rearmedRemediationCount = 0 }) {
    const activeBots = listActiveBots(config).map((worker) => worker.botId);
    const botHealth = {};
    for (const botId of activeBots) {
        botHealth[botId] = {
            ...defaultHealth(botId),
            ...((state && state.bot_health && state.bot_health[botId]) || {}),
        };
    }
    const openIssues = Object.values((issuesDoc && issuesDoc.issues) || {})
        .filter((issue) => issue && issue.status === 'open')
        .map((issue) => ({
            issue_id: issue.issue_id,
            bot_id: issue.bot_id,
            severity: issue.severity,
            summary: issue.summary || '',
            consecutive_failures: Number(issue.consecutive_failures || 0),
            last_seen_ts: issue.last_seen_ts || null,
            first_seen_ts: issue.first_seen_ts || null,
        }))
        .sort((a, b) => {
            const aTs = Date.parse(String(a.last_seen_ts || ''));
            const bTs = Date.parse(String(b.last_seen_ts || ''));
            return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
        })
        .slice(0, 50);

    return {
        schema_version: '1.0',
        generated_at: nowIso,
        timezone: String((config && config.timezone) || 'Asia/Tokyo'),
        active_bots: activeBots,
        bot_health: botHealth,
        open_issue_count: openIssues.length,
        open_issues: openIssues,
        latest_findings: Array.isArray(findings) ? findings.slice(-100) : [],
        latest_remediations: Array.isArray(remediations) ? remediations.slice(-100) : [],
        rearmed_remediation_count: Number(rearmedRemediationCount || 0),
    };
}

function exportSandboxVisibility({
    nowIso,
    config,
    state,
    issuesDoc,
    findings,
    remediations,
    rearmedRemediationCount = 0,
}) {
    const sandboxDirs = listSandboxExportDirs();
    if (!sandboxDirs.length) {
        return {
            exported: false,
            reason: 'no_sandbox_dirs',
            sandbox_count: 0,
            copied_files: 0,
        };
    }

    const copiedRelPaths = [
        ...SANDBOX_EXPORT_LOG_FILES,
        path.join('ops', 'state', 'state.json'),
        path.join('ops', 'state', 'issues.json'),
    ];
    const activeBots = listActiveBots(config).map((worker) => worker.botId);
    for (const botId of activeBots) {
        copiedRelPaths.push(path.join('logs', botId, 'latest.json'));
        copiedRelPaths.push(path.join('logs', botId, 'heartbeat.json'));
    }

    const perSandbox = [];
    let totalCopied = 0;
    for (const sandboxDir of sandboxDirs) {
        const detail = {
            sandbox_dir: sandboxDir,
            copied: 0,
            missing_sources: [],
            invalid_sources: [],
        };
        for (const relPath of copiedRelPaths) {
            const sourcePath = path.join(ROOT, relPath);
            const targetPath = path.join(sandboxDir, relPath);
            const result = copyJsonFile(sourcePath, targetPath);
            if (result.status === 'ok') {
                detail.copied += 1;
                totalCopied += 1;
            } else if (result.status === 'missing') {
                detail.missing_sources.push(relPath);
            } else if (result.status === 'invalid_json') {
                detail.invalid_sources.push(relPath);
            }
        }

        const snapshotPath = path.join(sandboxDir, 'ops', 'state', 'leader_snapshot_latest.json');
        const snapshot = buildLeaderSnapshot({
            nowIso,
            config,
            state,
            issuesDoc,
            findings,
            remediations,
            rearmedRemediationCount,
        });
        writeJsonAtomic(snapshotPath, snapshot);
        detail.copied += 1;
        totalCopied += 1;
        perSandbox.push(detail);
    }

    return {
        exported: true,
        sandbox_count: sandboxDirs.length,
        copied_files: totalCopied,
        per_sandbox: perSandbox,
    };
}

function mergeDeep(base, patch) {
    if (!patch || typeof patch !== 'object') return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
            out[key] = mergeDeep(out[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
    const loaded = safeReadJson(configPath, null);
    return mergeDeep(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), loaded || {});
}

function loadRemediationPolicy(policyPath = DEFAULT_REMEDIATION_POLICY_PATH) {
    const loaded = safeReadJson(policyPath, null);
    return mergeDeep(JSON.parse(JSON.stringify(DEFAULT_REMEDIATION_POLICY)), loaded || {});
}

function normalizeRemediationMode(rawMode) {
    const key = String(rawMode || '').trim().toLowerCase();
    if (key === 'shadow' || key === 'low_risk_auto' || key === 'full_guardrailed') return key;
    return 'low_risk_auto';
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileIssuePattern(pattern) {
    const raw = String(pattern || '').trim();
    if (!raw) return null;
    try {
        return new RegExp(raw);
    } catch (_) {
        return new RegExp(escapeRegExp(raw));
    }
}

function resolveRuleForIssue(issue, remediationPolicy) {
    const rulesList = Array.isArray(remediationPolicy && remediationPolicy.rules) ? remediationPolicy.rules : [];
    for (const rule of rulesList) {
        if (!rule || rule.enabled === false) continue;
        const re = compileIssuePattern(rule.issue_pattern);
        if (!re) continue;
        if (re.test(String(issue && issue.issue_id ? issue.issue_id : ''))) {
            return rule;
        }
    }
    return null;
}

function resolveWorkerContainerMap(config) {
    const map = {};
    for (const [botId, meta] of Object.entries((config && config.workers) || {})) {
        if (!meta || !meta.active) continue;
        if (meta.container) {
            map[botId] = String(meta.container).trim();
        }
    }
    return map;
}

function getRemediationHistory(state) {
    state.remediation_history = state.remediation_history && typeof state.remediation_history === 'object'
        ? state.remediation_history
        : {};
    return state.remediation_history;
}

function parseNumberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeStatusEnum(value, fallback, allowed) {
    const key = String(value || '').trim().toUpperCase();
    if (allowed.includes(key)) return key;
    return fallback;
}

function resolveHealthPolicy(config) {
    const source = (config && config.health_policy && typeof config.health_policy === 'object')
        ? config.health_policy
        : {};
    return {
        heartbeat_stall_minutes: Math.max(5, parseNumberOr(source.heartbeat_stall_minutes, DEFAULT_HEALTH_POLICY.heartbeat_stall_minutes)),
        stale_warn_minutes: Math.max(15, parseNumberOr(source.stale_warn_minutes, DEFAULT_HEALTH_POLICY.stale_warn_minutes)),
        down_heartbeat_minutes: Math.max(60, parseNumberOr(source.down_heartbeat_minutes, DEFAULT_HEALTH_POLICY.down_heartbeat_minutes)),
        down_requires_telegram_failure_when_container_running: source.down_requires_telegram_failure_when_container_running == null
            ? DEFAULT_HEALTH_POLICY.down_requires_telegram_failure_when_container_running
            : Boolean(source.down_requires_telegram_failure_when_container_running),
        no_signal_status: normalizeStatusEnum(source.no_signal_status, DEFAULT_HEALTH_POLICY.no_signal_status, ['UNKNOWN', 'WARN', 'ERROR']),
        idle_stale_status: normalizeStatusEnum(source.idle_stale_status, DEFAULT_HEALTH_POLICY.idle_stale_status, ['UNKNOWN', 'WARN']),
    };
}

function runDocker(args) {
    const res = spawnSync('docker', args, { encoding: 'utf8' });
    return {
        ok: !res.error && res.status === 0,
        code: res.status == null ? 1 : res.status,
        stdout: String(res.stdout || ''),
        stderr: String(res.stderr || ''),
        error: res.error ? String(res.error.message || res.error) : '',
    };
}

function inspectContainerState(containerName) {
    const container = String(containerName || '').trim();
    if (!container) {
        return {
            supported: false,
            container: null,
            running: null,
            state: null,
            reason: 'no_container',
        };
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(container)) {
        return {
            supported: false,
            container,
            running: null,
            state: null,
            reason: 'invalid_container_name',
        };
    }

    const inspected = runDocker(['inspect', '-f', '{{.State.Status}}\t{{.State.Running}}', container]);
    if (!inspected.ok) {
        return {
            supported: false,
            container,
            running: null,
            state: null,
            reason: 'docker_inspect_failed',
            error: String(inspected.stderr || inspected.error || '').trim() || null,
        };
    }

    const [stateRaw = '', runningRaw = ''] = String(inspected.stdout || '').trim().split('\t');
    const state = String(stateRaw || '').trim().toLowerCase() || null;
    let running = null;
    const runningKey = String(runningRaw || '').trim().toLowerCase();
    if (runningKey === 'true') running = true;
    if (runningKey === 'false') running = false;
    return {
        supported: true,
        container,
        running,
        state,
        reason: null,
        error: null,
    };
}

function shellQuote(value) {
    return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function parseTelegramLogHealth(logText, options = {}) {
    const lineLimit = parseNumberOr(options.errorLineLimit, TELEGRAM_LOG_ERROR_LINE_LIMIT);
    const lines = String(logText || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    let providerStarts = 0;
    let lastStartIdx = -1;
    const channelExitEvents = [];
    const authInvalidEvents = [];

    const authPatterns = [
        /channel exited: .*getMe.*404: Not Found/i,
        /getMe'\s+failed!\s+\(404:\s*Not Found\)/i,
        /deleteMyCommands failed: .*404:\s*Not Found/i,
        /setMyCommands failed: .*404:\s*Not Found/i,
    ];

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/\[telegram\].*\[default\]\s+starting provider/i.test(line)) {
            providerStarts += 1;
            lastStartIdx = i;
        }
        if (/\[telegram\].*\[default\]\s+channel exited:/i.test(line)) {
            channelExitEvents.push({ idx: i, line });
        }
        if (authPatterns.some((re) => re.test(line))) {
            authInvalidEvents.push({ idx: i, line });
        }
    }

    const activeChannelExitEvents = channelExitEvents.filter((item) => item.idx > lastStartIdx);
    const activeAuthEvents = authInvalidEvents.filter((item) => item.idx > lastStartIdx);
    const errorLines = [];
    for (const item of [...activeAuthEvents, ...activeChannelExitEvents]) {
        if (errorLines.length >= lineLimit) break;
        if (!errorLines.includes(item.line)) {
            errorLines.push(item.line);
        }
    }

    return {
        provider_starts: providerStarts,
        channel_exits: activeChannelExitEvents.length,
        auth_invalids: activeAuthEvents.length,
        has_failure: activeChannelExitEvents.length > 0 || activeAuthEvents.length > 0,
        has_auth_invalid: activeAuthEvents.length > 0,
        error_lines: errorLines,
    };
}

function inspectTelegramChannelHealth(containerName, now, sinceTs = null) {
    const container = String(containerName || '').trim();
    if (!container) {
        return {
            supported: false,
            reason: 'no_container',
        };
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(container)) {
        return {
            supported: false,
            reason: 'invalid_container_name',
            container,
        };
    }

    const fallbackSince = new Date(now.getTime() - (TELEGRAM_LOG_SCAN_WINDOW_MINUTES * 60 * 1000)).toISOString();
    const sinceIso = sinceTs && Number.isFinite(Date.parse(String(sinceTs))) ? String(sinceTs) : fallbackSince;
    const cmd = `docker logs --since ${shellQuote(sinceIso)} --tail ${Number(TELEGRAM_LOG_SCAN_TAIL_LINES)} ${shellQuote(container)} 2>&1`;
    const logs = spawnSync('sh', ['-lc', cmd], { encoding: 'utf8' });
    const ok = !logs.error && logs.status === 0;
    if (!ok) {
        return {
            supported: false,
            reason: 'docker_logs_failed',
            container,
            since: sinceIso,
            error: String(logs.stderr || logs.error || `exit_code=${logs.status}`),
        };
    }

    const parsed = parseTelegramLogHealth(String(logs.stdout || ''));
    return {
        supported: true,
        container,
        since: sinceIso,
        ...parsed,
    };
}

function resolveIssueById(issuesDoc, issueId, ts, summary) {
    const key = String(issueId || '').trim();
    if (!key) return null;
    const issue = issuesDoc && issuesDoc.issues ? issuesDoc.issues[key] : null;
    if (!issue || issue.status !== 'open') return issue || null;
    issue.status = 'resolved';
    issue.last_seen_ts = ts || issue.last_seen_ts;
    issue.summary = summary || issue.summary;
    issue.resolved_at = ts || isoNow();
    issue.consecutive_failures = 0;
    return issue;
}

function queueCapabilityRemediation(actionPlan) {
    const normalized = {
        schema_version: '1.0',
        request_id: opsCommandQueue.makeRequestId('opsc'),
        command_kind: 'capability',
        phase: 'plan',
        capability: String(actionPlan.capability || '').trim().toLowerCase(),
        action: String(actionPlan.action || '').trim().toLowerCase(),
        intent_action: `capability:${String(actionPlan.capability || '').trim().toLowerCase()}:${String(actionPlan.action || '').trim().toLowerCase()}`,
        risk_tier: String(actionPlan.risk_tier || 'MEDIUM').trim().toUpperCase(),
        requires_approval: Boolean(actionPlan.requires_approval),
        required_flags: Array.isArray(actionPlan.required_flags) ? actionPlan.required_flags : [],
        requested_by: String(actionPlan.requested_by || 'ops-daily-supervisor').trim() || 'ops-daily-supervisor',
        telegram_context: null,
        reason: String(actionPlan.reason || '').trim(),
        payload: (actionPlan.payload && typeof actionPlan.payload === 'object') ? actionPlan.payload : {},
        created_at: isoNow(),
    };
    return opsCommandQueue.enqueueCommand(normalized);
}

function evaluateAutoRemediation({ now, config, state, issuesDoc, remediationPolicy }) {
    const mode = normalizeRemediationMode(remediationPolicy && remediationPolicy.mode);
    const out = [];
    const history = getRemediationHistory(state);
    const defaults = remediationPolicy && remediationPolicy.defaults ? remediationPolicy.defaults : {};
    const workerContainerMap = resolveWorkerContainerMap(config);
    opsCommandQueue.ensureLayout();

    if (mode === 'shadow') {
        return out;
    }

    for (const issue of Object.values((issuesDoc && issuesDoc.issues) || {})) {
        if (!issue || issue.status !== 'open') continue;
        const rule = resolveRuleForIssue(issue, remediationPolicy);
        if (!rule) continue;
        const autoActions = Array.isArray(rule.auto_actions) ? rule.auto_actions : [];
        if (autoActions.length === 0) continue;

        const issueKey = String(issue.issue_id || '');
        const entry = history[issueKey] && typeof history[issueKey] === 'object'
            ? history[issueKey]
            : {
                attempts: 0,
                last_attempt_ts: null,
                last_request_ids: [],
                last_status: 'none',
            };

        const cooldownMinutes = parseNumberOr(rule.cooldown_minutes, parseNumberOr(defaults.cooldown_minutes, 30));
        const maxAttempts = parseNumberOr(rule.max_attempts, parseNumberOr(defaults.max_attempts, 1));
        const nowMs = now.getTime();
        const lastAttemptMs = Date.parse(String(entry.last_attempt_ts || ''));
        if (Number.isFinite(lastAttemptMs) && (nowMs - lastAttemptMs) < (cooldownMinutes * 60 * 1000)) {
            entry.last_status = 'cooldown';
            out.push({
                issue_id: issueKey,
                status: 'skipped',
                reason: 'cooldown',
                cooldown_minutes: cooldownMinutes,
            });
            history[issueKey] = entry;
            continue;
        }
        if (maxAttempts >= 0 && Number(entry.attempts || 0) >= maxAttempts) {
            entry.last_status = 'max_attempts_reached';
            out.push({
                issue_id: issueKey,
                status: 'skipped',
                reason: 'max_attempts_reached',
                attempts: Number(entry.attempts || 0),
                max_attempts: maxAttempts,
            });
            history[issueKey] = entry;
            continue;
        }

        const requestIds = [];
        for (const act of autoActions) {
            const capability = String((act && act.capability) || '').trim().toLowerCase();
            const action = String((act && act.action) || '').trim().toLowerCase();
            if (!capability || !action) continue;

            let target = String((act && act.target) || '').trim();
            if (target === 'worker_container') {
                target = workerContainerMap[issue.bot_id] || '';
            }

            const payload = {
                target,
                issue_id: issueKey,
                bot_id: issue.bot_id,
                escalation_rule: String(rule.escalation_rule || '').trim() || null,
                reason: `auto-remediation:${issueKey}`,
            };
            const queued = queueCapabilityRemediation({
                capability,
                action,
                payload,
                requested_by: 'ops-daily-supervisor',
                reason: `issue=${issueKey}; rule=${String(rule.issue_pattern || '')}`,
                risk_tier: String((act && act.risk_tier) || 'MEDIUM').trim().toUpperCase(),
                requires_approval: Boolean(act && act.requires_approval),
                required_flags: Array.isArray(act && act.required_flags) ? act.required_flags : [],
            });
            requestIds.push(queued.requestId);
        }

        entry.attempts = Number(entry.attempts || 0) + 1;
        entry.last_attempt_ts = isoNow(now);
        entry.last_request_ids = requestIds;
        entry.last_status = requestIds.length > 0 ? 'queued' : 'noop';
        history[issueKey] = entry;
        out.push({
            issue_id: issueKey,
            status: requestIds.length > 0 ? 'queued' : 'noop',
            request_ids: requestIds,
            attempts: entry.attempts,
            cooldown_minutes: cooldownMinutes,
            max_attempts: maxAttempts,
        });
    }

    return out;
}

function rearmRemediationHistory({ state, issuesDoc, remediationPolicy, nowIso }) {
    const defaults = remediationPolicy && remediationPolicy.defaults ? remediationPolicy.defaults : {};
    const enabled = defaults.rearm_on_recovery == null ? true : Boolean(defaults.rearm_on_recovery);
    if (!enabled) return 0;
    const history = getRemediationHistory(state);
    let changed = 0;
    for (const [issueId, entry] of Object.entries(history)) {
        if (!entry || typeof entry !== 'object') continue;
        const issue = issuesDoc && issuesDoc.issues ? issuesDoc.issues[issueId] : null;
        if (issue && issue.status === 'open') continue;
        const attempts = Number(entry.attempts || 0);
        const shouldReset = attempts > 0 || String(entry.last_status || '') === 'max_attempts_reached';
        if (!shouldReset) continue;
        history[issueId] = {
            ...entry,
            attempts: 0,
            last_attempt_ts: null,
            last_request_ids: [],
            last_status: 'rearmed_after_recovery',
            rearmed_at: nowIso,
        };
        changed += 1;
    }
    return changed;
}

function listActiveBots(config) {
    return Object.entries((config && config.workers) || {})
        .filter(([, meta]) => meta && meta.active)
        .map(([botId, meta]) => ({ botId, ...meta }));
}

function listEventFiles(botId) {
    const eventsDir = path.join(LOGS_ROOT, botId, 'events');
    if (!fs.existsSync(eventsDir)) return [];
    return fs.readdirSync(eventsDir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => path.join(eventsDir, name));
}

function collectEventsSince(botId, sinceTs) {
    const files = listEventFiles(botId);
    const events = [];
    const violations = [];
    let maxTs = sinceTs || null;
    const sinceMs = sinceTs ? Date.parse(String(sinceTs)) : null;

    for (const filePath of files) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
            let event = null;
            try {
                event = JSON.parse(line);
            } catch (_) {
                violations.push({
                    file_path: filePath,
                    error: 'invalid_json_line',
                });
                continue;
            }
            const tsMs = Date.parse(String(event.ts || ''));
            if (sinceMs != null && Number.isFinite(tsMs) && tsMs <= sinceMs) {
                continue;
            }
            const validation = rules.validateEventSchema(event);
            if (!validation.valid) {
                violations.push({
                    file_path: filePath,
                    run_id: event && event.run_id ? String(event.run_id) : null,
                    missing: validation.missing,
                });
            }
            const withMeta = {
                ...event,
                __file_path: filePath,
            };
            events.push(withMeta);
            if (event && event.ts) {
                if (!maxTs || Date.parse(String(event.ts)) > Date.parse(String(maxTs))) {
                    maxTs = String(event.ts);
                }
            }
        }
    }

    events.sort((a, b) => Date.parse(String(a.ts || '0')) - Date.parse(String(b.ts || '0')));
    return { events, violations, maxTs };
}

function parseAgeMinutes(ts, now) {
    const at = Date.parse(String(ts || ''));
    if (!Number.isFinite(at)) return null;
    return (now.getTime() - at) / (60 * 1000);
}

function ensureIssue(issuesDoc, seed) {
    const issueId = String(seed.issue_id);
    if (!issuesDoc.issues[issueId]) {
        issuesDoc.issues[issueId] = {
            issue_id: issueId,
            bot_id: seed.bot_id,
            fingerprint: seed.fingerprint,
            status: 'open',
            severity: seed.severity || 'P2',
            first_seen_ts: seed.ts,
            last_seen_ts: seed.ts,
            consecutive_failures: 0,
            last_alert_ts: null,
            quiet_hours_suppressed_count: 0,
            evidence: {
                run_ids: [],
                log_paths: [],
            },
            summary: seed.summary || 'Issue detected.',
            resolved_at: null,
        };
    }
    return issuesDoc.issues[issueId];
}

function appendUnique(list, value, maxItems = 20) {
    const v = String(value || '').trim();
    if (!v) return;
    if (!list.includes(v)) list.push(v);
    if (list.length > maxItems) {
        list.splice(0, list.length - maxItems);
    }
}

function touchIssueOpen(issuesDoc, seed, options = {}) {
    const issue = ensureIssue(issuesDoc, seed);
    issue.status = 'open';
    issue.severity = seed.severity || issue.severity;
    issue.last_seen_ts = seed.ts || issue.last_seen_ts;
    issue.summary = seed.summary || issue.summary;
    issue.resolved_at = null;
    if (options.incrementFailure) {
        issue.consecutive_failures = Number(issue.consecutive_failures || 0) + 1;
    }
    if (seed.run_id) appendUnique(issue.evidence.run_ids, seed.run_id);
    if (seed.log_path) appendUnique(issue.evidence.log_paths, seed.log_path);
    return issue;
}

function resolveIssuesForBot(issuesDoc, botId, ts, summary) {
    for (const issue of Object.values(issuesDoc.issues || {})) {
        if (!issue || issue.bot_id !== botId || issue.status !== 'open') continue;
        issue.status = 'resolved';
        issue.last_seen_ts = ts || issue.last_seen_ts;
        issue.summary = summary || issue.summary;
        issue.resolved_at = ts || isoNow();
        issue.consecutive_failures = 0;
    }
}

function severityRank(severity) {
    const v = String(severity || '').toUpperCase();
    if (v === 'P1') return 3;
    if (v === 'P2') return 2;
    return 1;
}

function chooseHigherSeverity(a, b) {
    return severityRank(a) >= severityRank(b) ? a : b;
}

function buildAlertMessage(issue, nowIso, timezone) {
    const evidence = issue.evidence || { run_ids: [], log_paths: [] };
    const logLines = (evidence.log_paths || []).slice(-2).map((p) => `  - ${p}`).join('\n');
    const runId = (evidence.run_ids || []).slice(-1)[0] || '-';
    return [
        `[${issue.severity}] Incident — ${issue.bot_id} — ${issue.issue_id}`,
        '',
        'Impact:',
        `- ${issue.summary || 'Operational degradation detected.'}`,
        '',
        'Evidence:',
        `- First seen: ${issue.first_seen_ts || '-'}`,
        `- Last seen: ${issue.last_seen_ts || '-'}`,
        `- Run ID: ${runId}`,
        `- Error fingerprint: ${issue.fingerprint || '-'}`,
        '- Log paths:',
        logLines || '  - (none)',
        '',
        'Likely cause (log-based):',
        `- ${issue.summary || 'Investigating based on recent error fingerprint and component.'}`,
        '',
        'Immediate mitigation checklist:',
        '1) Verify upstream/service dependency health and recent config changes.',
        '2) Trigger one controlled rerun and compare run_id/evidence delta.',
        '3) If failure repeats, escalate with runbook and keep issue open.',
        '',
        `Next update:`,
        `- I will re-check at the next 30-minute scan. (${timezone}, generated ${nowIso})`,
    ].join('\n');
}

function writeIssueAlert(issue, decision, nowIso, config, sendEnabled) {
    const alertRecord = {
        alert_id: `alert_${crypto.randomUUID()}`,
        issue_id: issue.issue_id,
        severity: issue.severity,
        created_at: nowIso,
        suppressed: !sendEnabled,
        suppression_reason: sendEnabled ? null : 'send_disabled',
        message_markdown: buildAlertMessage(issue, nowIso, config.timezone || 'Asia/Tokyo'),
        evidence: issue.evidence || { run_ids: [], log_paths: [] },
        decision_rule: decision.decision_rule,
    };

    const outboxPath = store.writeAlertOutbox(alertRecord);
    let sentPath = null;
    let delivered = false;

    if (sendEnabled) {
        enqueueBridgePayload({
            taskId: `ops-alert-${Date.now()}`,
            command: `[NOTIFY] ${alertRecord.message_markdown}`,
            timestamp: nowIso,
            status: 'pending',
            route: 'report',
            source: 'ops-daily-supervisor',
        });
        sentPath = store.markAlertSent(outboxPath);
        delivered = true;
    }

    return {
        alertRecord,
        outboxPath,
        sentPath,
        delivered,
    };
}

function parseTimeToParts(raw, fallbackHour, fallbackMinute = 0) {
    const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { hour: fallbackHour, minute: fallbackMinute };
    return { hour: Number(m[1]), minute: Number(m[2]) };
}

function isScheduledTime(now, timezone, hhmm, fallbackHour) {
    const parts = rules.getTimeParts(now, timezone);
    const target = parseTimeToParts(hhmm, fallbackHour, 30);
    return parts.hour === target.hour && parts.minute === target.minute;
}

function buildBriefing(type, now, config, state, issuesDoc) {
    const timezone = config.timezone || 'Asia/Tokyo';
    const parts = rules.getTimeParts(now, timezone);
    const dateKey = parts.dateKey;
    const title = type === 'morning'
        ? `Morning Briefing — ${dateKey} (${timezone})`
        : `Evening Briefing — ${dateKey} (${timezone})`;
    const botHealth = state.bot_health || {};
    const openIssues = Object.values(issuesDoc.issues || {}).filter((item) => item && item.status === 'open');
    const resolvedSince = Object.values(issuesDoc.issues || {}).filter((item) => {
        if (!item || item.status !== 'resolved' || !item.resolved_at) return false;
        const lastSent = state.last_briefing_sent && state.last_briefing_sent[type];
        if (!lastSent || !lastSent.ts) return true;
        return Date.parse(String(item.resolved_at)) > Date.parse(String(lastSent.ts));
    });

    const lines = [title, ''];
    if (type === 'morning') {
        lines.push('Overall Status:');
        for (const [botId, health] of Object.entries(botHealth)) {
            const status = String((health && health.status) || 'UNKNOWN').toUpperCase();
            lines.push(`- ${botId}: ${status} — last success ${health.last_success_ts || '-'}, last run ${health.last_run_ts || '-'}`);
        }
        lines.push('');
        lines.push('Open Issues:');
        if (!openIssues.length) {
            lines.push('- none');
        } else {
            openIssues.forEach((issue, idx) => {
                lines.push(`${idx + 1}) [${issue.severity}] ${issue.bot_id} — ${issue.issue_id}`);
                lines.push(`   - First seen: ${issue.first_seen_ts || '-'}`);
                lines.push(`   - Last seen: ${issue.last_seen_ts || '-'}`);
                lines.push(`   - Summary: ${issue.summary || '-'}`);
                lines.push('   - Next action: Review runbook and verify dependency health.');
            });
        }
        lines.push('');
        lines.push('Resolved Since Last Briefing:');
        if (!resolvedSince.length) {
            lines.push('- none');
        } else {
            resolvedSince.forEach((issue) => {
                lines.push(`- ${issue.bot_id} — ${issue.issue_id} resolved at ${issue.resolved_at || '-'}`);
            });
        }
        lines.push('');
        lines.push('Operational Notes:');
        const staleBots = Object.entries(botHealth)
            .filter(([, health]) => Number(health && health.staleness_minutes || 0) > 90)
            .map(([botId, health]) => `${botId} stale ${Math.round(health.staleness_minutes)}m`);
        lines.push(`- Missed schedules: ${staleBots.length ? staleBots.join(', ') : 'none'}`);
        const schemaIssue = openIssues.filter((issue) => String(issue.fingerprint || '').includes('schema_violation'));
        lines.push(`- Schema violations: ${schemaIssue.length ? schemaIssue.length : 'none'}`);
        lines.push('- Disk/log growth: pending dedicated metric (MVP baseline)');
        lines.push('');
        lines.push('Today’s Focus:');
        lines.push('- Eliminate recurring fingerprints with highest failure streak.');
        lines.push('- Confirm worker heartbeats remain within expected cadence.');
        lines.push('- Keep alert noise low by enforcing dedupe and thresholds.');
    } else {
        const allIssues = Object.values(issuesDoc.issues || {});
        const counts = { P1: 0, P2: 0, P3: 0 };
        for (const issue of allIssues) {
            if (!issue) continue;
            counts[issue.severity] = Number(counts[issue.severity] || 0) + 1;
        }
        lines.push('Day Summary:');
        lines.push(`- Total runs observed: ${Object.values(botHealth).reduce((acc, x) => acc + Number((x && x.runs_observed) || 0), 0)}`);
        lines.push(`- Errors: ${counts.P1 + counts.P2 + counts.P3} (P1: ${counts.P1}, P2: ${counts.P2}, P3: ${counts.P3})`);
        lines.push(`- Retries recovered: ${Object.values(botHealth).reduce((acc, x) => acc + Number((x && x.retries_recovered) || 0), 0)}`);
        lines.push('');
        lines.push('Current Health:');
        for (const [botId, health] of Object.entries(botHealth)) {
            lines.push(`- ${botId}: ${String((health && health.status) || 'UNKNOWN').toUpperCase()}`);
        }
        lines.push('');
        lines.push('Open Issues Carrying Over:');
        if (!openIssues.length) {
            lines.push('- none');
        } else {
            openIssues.forEach((issue, idx) => {
                lines.push(`${idx + 1}) [${issue.severity}] ${issue.bot_id} — ${issue.issue_id} — last update ${issue.last_seen_ts || '-'}`);
            });
        }
        lines.push('');
        lines.push('Planned Next Checks:');
        lines.push(`- Next automated scan: +30 minutes (${timezone})`);
        lines.push('- Next morning briefing: 08:30');
        lines.push('');
        lines.push('Quick Check-in:');
        lines.push('- Monitoring stayed stable; do you want alerting enabled after dry-run verification?');
    }

    return lines.join('\n');
}

function maybeGenerateBriefing(type, now, config, state, issuesDoc, options = {}) {
    const timezone = config.timezone || 'Asia/Tokyo';
    const sendEnabled = Boolean(options.sendEnabled);
    const force = Boolean(options.force);
    const briefingCfg = config.briefings || {};
    const shouldRun = force || (
        type === 'morning'
            ? isScheduledTime(now, timezone, briefingCfg.morning_time, 8)
            : isScheduledTime(now, timezone, briefingCfg.evening_time, 18)
    );
    if (!shouldRun) return null;

    const parts = rules.getTimeParts(now, timezone);
    const dateKey = parts.dateKey;
    const last = state.last_briefing_sent && state.last_briefing_sent[type];
    if (!force && last && last.date === dateKey) return null;

    const content = buildBriefing(type, now, config, state, issuesDoc);
    const fileName = `${type}_${dateKey}.md`;
    const reportPath = path.join(store.REPORTS_DIR, fileName);
    store.writeReport(reportPath, content);

    let delivered = false;
    if (sendEnabled && briefingCfg.send !== false) {
        enqueueBridgePayload({
            taskId: `ops-briefing-${type}-${Date.now()}`,
            command: `[NOTIFY] ${content}`,
            timestamp: isoNow(now),
            status: 'pending',
            route: 'report',
            source: 'ops-daily-supervisor',
        });
        delivered = true;
    }

    state.last_briefing_sent = state.last_briefing_sent || {};
    state.last_briefing_sent[type] = {
        date: dateKey,
        ts: isoNow(now),
        report_path: reportPath,
        delivered,
    };

    return {
        type,
        reportPath,
        delivered,
    };
}

function defaultHealth(botId) {
    return {
        bot_id: botId,
        status: 'UNKNOWN',
        last_seen_ts: null,
        last_success_ts: null,
        last_run_id: null,
        last_run_ts: null,
        staleness_minutes: null,
        signal_source: 'none',
        container_state: {
            supported: false,
            container: null,
            running: null,
            state: null,
            reason: 'unknown',
        },
        telegram_channel: {
            healthy: null,
            container: null,
            reason: 'unknown',
            error: null,
        },
        runs_observed: 0,
        retries_recovered: 0,
    };
}

function runScan(options = {}) {
    const now = options.now ? new Date(options.now) : new Date();
    const nowIso = isoNow(now);
    const config = options.config || loadConfig(options.configPath || DEFAULT_CONFIG_PATH);
    const remediationPolicy = options.remediationPolicy
        || loadRemediationPolicy(options.remediationPolicyPath || DEFAULT_REMEDIATION_POLICY_PATH);
    const state = store.readState();
    const issuesDoc = store.readIssues();
    const sendEnabled = options.sendEnabled != null
        ? Boolean(options.sendEnabled)
        : (
            String(process.env.OPS_DAILY_SEND || '').trim()
                ? String(process.env.OPS_DAILY_SEND).trim() === '1'
                : Boolean(config.alerting && config.alerting.enabled)
        );

    const activeBots = listActiveBots(config);
    const scanCursor = state.scan_cursor_ts_by_bot || {};
    state.scan_cursor_ts_by_bot = scanCursor;
    state.bot_health = state.bot_health || {};
    const findings = [];
    const healthPolicy = resolveHealthPolicy(config);

    for (const worker of activeBots) {
        const botId = worker.botId;
        const allowTelegramSignalFallback = Boolean(worker && worker.allow_telegram_signal_fallback === true);
        const heartbeatStallIssueId = `${botId}:heartbeat_stall`;
        const downIssueId = `${botId}:bot_down`;
        const noSignalIssueId = `${botId}:no_signal`;
        const telegramIssueId = `${botId}:telegram_channel_exited`;
        const telegramAuthIssueId = `${botId}:telegram_auth_invalid`;
        const health = {
            ...defaultHealth(botId),
            ...((state.bot_health && state.bot_health[botId]) || {}),
        };

        const latestPath = path.join(LOGS_ROOT, botId, 'latest.json');
        const heartbeatPath = path.join(LOGS_ROOT, botId, 'heartbeat.json');
        const botLogPath = path.join(LOGS_ROOT, botId);
        const latest = safeReadJson(latestPath, null);
        const heartbeat = safeReadJson(heartbeatPath, null);
        const containerState = inspectContainerState(worker.container);
        health.container_state = {
            supported: containerState.supported,
            container: containerState.container,
            running: containerState.running,
            state: containerState.state,
            reason: containerState.reason || null,
            error: containerState.error || null,
        };
        const hasLatestSignal = Boolean(
            latest
            && latest.last_event_ts
            && Number.isFinite(Date.parse(String(latest.last_event_ts))),
        );
        const hasHeartbeatSignal = Boolean(
            heartbeat
            && heartbeat.ts
            && Number.isFinite(Date.parse(String(heartbeat.ts))),
        );
        const hasAnyTelemetrySignal = hasLatestSignal || hasHeartbeatSignal;
        const noSignalTelemetry = Boolean(latest && heartbeat && !hasAnyTelemetrySignal);
        let heartbeatAgeMinutes = null;
        let latestAgeMinutes = hasLatestSignal ? parseAgeMinutes(latest.last_event_ts, now) : null;

        const sinceTs = scanCursor[botId] || null;
        const collected = collectEventsSince(botId, sinceTs);
        if (collected.maxTs) {
            scanCursor[botId] = collected.maxTs;
        }

        if (!latest) {
            const issue = touchIssueOpen(issuesDoc, {
                issue_id: `${botId}:missing_latest_json`,
                bot_id: botId,
                fingerprint: 'missing_latest_json',
                severity: 'P2',
                ts: nowIso,
                summary: 'latest.json is missing at scan time.',
                log_path: latestPath,
            }, { incrementFailure: true });
            findings.push({ botId, type: 'missing_latest', issue_id: issue.issue_id });
        } else {
            health.last_run_id = latest.run_id || health.last_run_id;
            health.last_run_ts = latest.last_event_ts || health.last_run_ts;
            health.last_success_ts = latest.last_success_ts || health.last_success_ts;
            health.status = String(latest.status || health.status || 'UNKNOWN').toUpperCase();
        }

        if (heartbeat) {
            const age = parseAgeMinutes(heartbeat.ts, now);
            if (age != null) {
                heartbeatAgeMinutes = age;
                health.last_seen_ts = heartbeat.ts;
                health.staleness_minutes = age;
                const heartbeatIsRunning = String(heartbeat.state || '').toLowerCase() === 'running';
                const heartbeatStalled = heartbeatIsRunning && age > healthPolicy.heartbeat_stall_minutes;
                if (heartbeatStalled) {
                    const issue = touchIssueOpen(issuesDoc, {
                        issue_id: heartbeatStallIssueId,
                        bot_id: botId,
                        fingerprint: 'heartbeat_stall',
                        severity: 'P2',
                        ts: nowIso,
                        summary: `Heartbeat stalled while run is marked in progress (>${healthPolicy.heartbeat_stall_minutes}m).`,
                        log_path: heartbeatPath,
                    }, { incrementFailure: true });
                    findings.push({ botId, type: 'heartbeat_stall', issue_id: issue.issue_id });
                } else {
                    resolveIssueById(issuesDoc, heartbeatStallIssueId, nowIso, 'Heartbeat staleness recovered.');
                }
            }
        }

        const telegramHealth = inspectTelegramChannelHealth(worker.container, now, null);
        if (telegramHealth.supported) {
            const detail = Array.isArray(telegramHealth.error_lines) && telegramHealth.error_lines.length > 0
                ? telegramHealth.error_lines.slice(0, 2).join(' | ')
                : '';
            health.telegram_channel = {
                healthy: !telegramHealth.has_failure,
                container: telegramHealth.container,
                since: telegramHealth.since,
                provider_starts: telegramHealth.provider_starts,
                channel_exits: telegramHealth.channel_exits,
                auth_invalids: telegramHealth.auth_invalids,
                last_error: detail || null,
            };
            if (telegramHealth.has_failure) {
                const authInvalid = Boolean(telegramHealth.has_auth_invalid);
                const issueId = authInvalid ? telegramAuthIssueId : telegramIssueId;
                const summary = authInvalid
                    ? `Telegram auth invalid detected in ${telegramHealth.container}. ${detail}`.trim()
                    : `Telegram channel exited in ${telegramHealth.container}. ${detail}`.trim();
                const issue = touchIssueOpen(issuesDoc, {
                    issue_id: issueId,
                    bot_id: botId,
                    fingerprint: authInvalid ? 'telegram_auth_invalid' : 'telegram_channel_exited',
                    severity: authInvalid ? 'P1' : 'P2',
                    ts: nowIso,
                    summary,
                    log_path: `docker:${telegramHealth.container}`,
                }, { incrementFailure: true });
                findings.push({
                    botId,
                    type: authInvalid ? 'telegram_auth_invalid' : 'telegram_channel_exited',
                    issue_id: issue.issue_id,
                });
                health.status = 'ERROR';
                if (authInvalid) {
                    resolveIssueById(issuesDoc, telegramIssueId, nowIso, 'Telegram auth failure took precedence; channel-exited issue folded.');
                }
            } else {
                resolveIssueById(issuesDoc, telegramIssueId, nowIso, 'Telegram channel healthy in recent logs.');
                resolveIssueById(issuesDoc, telegramAuthIssueId, nowIso, 'Telegram auth healthy in recent logs.');
            }
        } else {
            health.telegram_channel = {
                healthy: null,
                container: String(worker.container || '').trim() || null,
                reason: telegramHealth.reason || 'unsupported',
                error: telegramHealth.error || null,
            };
        }

        const noSignalSuppressedByTelegram = Boolean(
            allowTelegramSignalFallback
            && noSignalTelemetry
            && telegramHealth.supported
            && !telegramHealth.has_failure,
        );
        const effectiveNoSignal = noSignalTelemetry && !noSignalSuppressedByTelegram;
        if (effectiveNoSignal) {
            const issue = touchIssueOpen(issuesDoc, {
                issue_id: noSignalIssueId,
                bot_id: botId,
                fingerprint: 'no_signal',
                severity: 'P3',
                ts: nowIso,
                summary: 'No telemetry signal (latest.last_event_ts and heartbeat.ts are empty).',
                log_path: botLogPath,
            }, { incrementFailure: true });
            findings.push({ botId, type: 'no_signal', issue_id: issue.issue_id });
            health.status = healthPolicy.no_signal_status;
        } else {
            const summary = noSignalSuppressedByTelegram
                ? 'Telemetry signal is empty, but Telegram channel is healthy.'
                : 'Telemetry signal restored.';
            resolveIssueById(issuesDoc, noSignalIssueId, nowIso, summary);
        }

        if (collected.violations.length > 0) {
            const issue = touchIssueOpen(issuesDoc, {
                issue_id: `${botId}:schema_violation`,
                bot_id: botId,
                fingerprint: 'schema_violation',
                severity: collected.violations.length >= 5 ? 'P2' : 'P3',
                ts: nowIso,
                summary: `Schema validation failed for ${collected.violations.length} log line(s).`,
                log_path: collected.violations[0].file_path,
            }, { incrementFailure: true });
            findings.push({ botId, type: 'schema_violation', issue_id: issue.issue_id });
        }

        for (const event of collected.events) {
            const eventType = String(event.event_type || '').toLowerCase();
            const status = String(event.status || '').toLowerCase();
            if (eventType === 'retry') {
                health.retries_recovered = Number(health.retries_recovered || 0) + 1;
            }
            if (eventType === 'end') {
                health.runs_observed = Number(health.runs_observed || 0) + 1;
                health.last_run_id = event.run_id || health.last_run_id;
                health.last_run_ts = event.ts || health.last_run_ts;
            }
            if (status === 'error' && eventType === 'end') {
                const issueId = rules.computeIssueId(botId, event);
                const issue = touchIssueOpen(issuesDoc, {
                    issue_id: issueId,
                    bot_id: botId,
                    fingerprint: rules.buildEventFingerprint(event),
                    severity: chooseHigherSeverity(rules.classifySeverity(event), 'P2'),
                    ts: event.ts || nowIso,
                    summary: String(event.message || 'Run failed with error status.'),
                    run_id: event.run_id,
                    log_path: event.__file_path,
                }, { incrementFailure: true });
                findings.push({ botId, type: 'run_error', issue_id: issue.issue_id });
                health.status = 'ERROR';
                continue;
            }
            if (eventType === 'end' && (status === 'ok' || status === 'warn')) {
                health.last_success_ts = event.ts || health.last_success_ts;
                health.status = status === 'warn' ? 'WARN' : 'OK';
                resolveIssuesForBot(issuesDoc, botId, event.ts || nowIso, `Recovered with status=${status}.`);
            }
        }

        if (latest && latest.last_event_ts) {
            if (latestAgeMinutes == null) {
                latestAgeMinutes = parseAgeMinutes(latest.last_event_ts, now);
            }
            if (latestAgeMinutes != null) {
                health.staleness_minutes = latestAgeMinutes;
                health.last_seen_ts = latest.last_event_ts;
            }
        }

        const staleByHeartbeatForDown = heartbeatAgeMinutes != null && heartbeatAgeMinutes > healthPolicy.down_heartbeat_minutes;
        const staleByLatestForDown = latestAgeMinutes != null && latestAgeMinutes > healthPolicy.down_heartbeat_minutes;
        const telemetryDownSignal = effectiveNoSignal || staleByHeartbeatForDown || staleByLatestForDown;
        const containerRunning = containerState.running;
        const telegramFailed = telegramHealth.supported ? telegramHealth.has_failure : null;
        let shouldMarkDown = false;
        if (telemetryDownSignal) {
            if (containerRunning === false) {
                shouldMarkDown = true;
            } else if (containerRunning === true) {
                shouldMarkDown = healthPolicy.down_requires_telegram_failure_when_container_running
                    ? telegramFailed === true
                    : false;
            } else {
                shouldMarkDown = telegramFailed === true;
            }
        }

        if (shouldMarkDown) {
            const downReasons = [];
            if (containerRunning === false) downReasons.push(`container=${containerState.state || 'stopped'}`);
            if (staleByHeartbeatForDown) downReasons.push(`heartbeat_stale>${healthPolicy.down_heartbeat_minutes}m`);
            if (staleByLatestForDown) downReasons.push(`latest_stale>${healthPolicy.down_heartbeat_minutes}m`);
            if (effectiveNoSignal) downReasons.push('telemetry=no_signal');
            if (telegramFailed === true) downReasons.push('telegram=unhealthy');
            const summary = downReasons.length > 0
                ? `Bot down confirmed (${downReasons.join(', ')}).`
                : 'Bot down confirmed by composite health policy.';
            const issue = touchIssueOpen(issuesDoc, {
                issue_id: downIssueId,
                bot_id: botId,
                fingerprint: 'bot_down',
                severity: 'P1',
                ts: nowIso,
                summary,
                log_path: containerState.container ? `docker:${containerState.container}` : heartbeatPath,
            }, { incrementFailure: true });
            findings.push({ botId, type: 'bot_down', issue_id: issue.issue_id });
        } else {
            resolveIssueById(issuesDoc, downIssueId, nowIso, 'Composite bot_down condition cleared.');
        }

        if (noSignalSuppressedByTelegram) {
            health.signal_source = 'telegram_fallback';
        } else if (hasLatestSignal && hasHeartbeatSignal) {
            health.signal_source = 'latest+heartbeat';
        } else if (hasLatestSignal) {
            health.signal_source = 'latest';
        } else if (hasHeartbeatSignal) {
            health.signal_source = 'heartbeat';
        } else {
            health.signal_source = 'none';
        }

        const hasStaleTelemetry = (
            (heartbeatAgeMinutes != null && heartbeatAgeMinutes > healthPolicy.stale_warn_minutes)
            || (latestAgeMinutes != null && latestAgeMinutes > healthPolicy.stale_warn_minutes)
        );
        if (shouldMarkDown) {
            health.status = 'DOWN';
        } else if (effectiveNoSignal) {
            health.status = healthPolicy.no_signal_status;
        } else if (hasStaleTelemetry && (health.status === 'OK' || health.status === 'UNKNOWN')) {
            health.status = healthPolicy.idle_stale_status;
        }

        state.bot_health[botId] = health;
    }

    const rearmedRemediationCount = rearmRemediationHistory({
        state,
        issuesDoc,
        remediationPolicy,
        nowIso,
    });
    const remediations = evaluateAutoRemediation({
        now,
        config,
        state,
        issuesDoc,
        remediationPolicy,
    });

    const alertDecisions = [];
    for (const issue of Object.values(issuesDoc.issues || {})) {
        if (!issue || issue.status !== 'open') continue;
        const decision = rules.shouldAlertNow(issue, {
            now,
            timezone: config.timezone || 'Asia/Tokyo',
            quiet_hours: config.alerting && config.alerting.quiet_hours,
            cooldown_hours: config.alerting && config.alerting.cooldown_hours,
            p2_consecutive_failures_threshold: config.alerting && config.alerting.p2_consecutive_failures_threshold,
        });
        if (decision.send) {
            const delivery = writeIssueAlert(issue, decision, nowIso, config, sendEnabled);
            issue.last_alert_ts = nowIso;
            alertDecisions.push({
                issue_id: issue.issue_id,
                sent: delivery.delivered,
                outbox: delivery.outboxPath,
                sentPath: delivery.sentPath,
                decision_rule: decision.decision_rule,
            });
            continue;
        }
        if (decision.reason === 'quiet_hours') {
            issue.quiet_hours_suppressed_count = Number(issue.quiet_hours_suppressed_count || 0) + 1;
        }
        alertDecisions.push({
            issue_id: issue.issue_id,
            sent: false,
            reason: decision.reason,
            decision_rule: decision.decision_rule,
        });
    }

    const briefings = [];
    const morning = maybeGenerateBriefing('morning', now, config, state, issuesDoc, { sendEnabled, force: false });
    if (morning) briefings.push(morning);
    const evening = maybeGenerateBriefing('evening', now, config, state, issuesDoc, { sendEnabled, force: false });
    if (evening) briefings.push(evening);

    state.updated_at = nowIso;
    issuesDoc.updated_at = nowIso;
    store.writeState(state);
    store.writeIssues(issuesDoc);
    const sandboxExport = exportSandboxVisibility({
        nowIso,
        config,
        state,
        issuesDoc,
        findings,
        remediations,
        rearmedRemediationCount,
    });

    return {
        ok: true,
        now: nowIso,
        sendEnabled,
        scannedBots: listActiveBots(config).map((x) => x.botId),
        findings,
        remediations,
        rearmedRemediationCount,
        remediationMode: normalizeRemediationMode(remediationPolicy && remediationPolicy.mode),
        alertDecisions,
        briefings,
        sandboxExport,
        statePath: store.STATE_PATH,
        issuesPath: store.ISSUES_PATH,
    };
}

function runBriefing(type, options = {}) {
    const now = options.now ? new Date(options.now) : new Date();
    const config = options.config || loadConfig(options.configPath || DEFAULT_CONFIG_PATH);
    const state = store.readState();
    const issuesDoc = store.readIssues();
    const sendEnabled = options.sendEnabled != null
        ? Boolean(options.sendEnabled)
        : (
            String(process.env.OPS_DAILY_SEND || '').trim()
                ? String(process.env.OPS_DAILY_SEND).trim() === '1'
                : Boolean(config.briefings && config.briefings.send)
        );
    const result = maybeGenerateBriefing(type, now, config, state, issuesDoc, {
        sendEnabled,
        force: true,
    });
    state.updated_at = isoNow(now);
    store.writeState(state);
    return {
        ok: true,
        type,
        result,
    };
}

function runHealth(options = {}) {
    const config = options.config || loadConfig(options.configPath || DEFAULT_CONFIG_PATH);
    const remediationPolicy = options.remediationPolicy
        || loadRemediationPolicy(options.remediationPolicyPath || DEFAULT_REMEDIATION_POLICY_PATH);
    const state = store.readState();
    const issuesDoc = store.readIssues();
    const openIssues = Object.values(issuesDoc.issues || {}).filter((x) => x && x.status === 'open');
    return {
        ok: true,
        timezone: config.timezone || 'Asia/Tokyo',
        updated_at: state.updated_at || null,
        activeBots: listActiveBots(config).map((x) => x.botId),
        openIssueCount: openIssues.length,
        openIssues: openIssues.map((x) => ({
            issue_id: x.issue_id,
            bot_id: x.bot_id,
            severity: x.severity,
            consecutive_failures: x.consecutive_failures,
            last_seen_ts: x.last_seen_ts,
        })),
        remediationMode: normalizeRemediationMode(remediationPolicy && remediationPolicy.mode),
        remediationHistoryCount: Object.keys((state && state.remediation_history) || {}).length,
        statePath: store.STATE_PATH,
        issuesPath: store.ISSUES_PATH,
    };
}

function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    const out = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
        const token = String(args[i] || '');
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = args[i + 1];
            if (next && !String(next).startsWith('--')) {
                out[key] = String(next);
                i += 1;
            } else {
                out[key] = '1';
            }
            continue;
        }
        out._.push(token);
    }
    return out;
}

function runCli() {
    loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true });
    store.ensureOpsLayout();
    const parsed = parseArgs(process.argv.slice(2));
    const command = parsed._[0] || 'scan';
    const configPath = parsed.config || DEFAULT_CONFIG_PATH;
    const remediationPolicyPath = parsed['remediation-config'] || DEFAULT_REMEDIATION_POLICY_PATH;
    const sendEnabled = Object.prototype.hasOwnProperty.call(parsed, 'send')
        ? true
        : Object.prototype.hasOwnProperty.call(parsed, 'no-send')
            ? false
            : undefined;

    if (command === 'scan') {
        const result = runScan({ configPath, remediationPolicyPath, sendEnabled });
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    if (command === 'briefing') {
        const typeRaw = String(parsed.type || parsed._[1] || 'morning').toLowerCase();
        const type = typeRaw === 'evening' ? 'evening' : 'morning';
        const result = runBriefing(type, { configPath, sendEnabled });
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    if (command === 'health') {
        const result = runHealth({ configPath, remediationPolicyPath });
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
    try {
        runCli();
    } catch (error) {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    }
}

module.exports = {
    DEFAULT_CONFIG_PATH,
    DEFAULT_REMEDIATION_POLICY_PATH,
    loadConfig,
    loadRemediationPolicy,
    listActiveBots,
    collectEventsSince,
    parseTelegramLogHealth,
    inspectTelegramChannelHealth,
    inspectContainerState,
    resolveHealthPolicy,
    evaluateAutoRemediation,
    rearmRemediationHistory,
    runScan,
    runBriefing,
    runHealth,
    buildBriefing,
};
