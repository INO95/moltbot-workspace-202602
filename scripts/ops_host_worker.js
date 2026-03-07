#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const config = require('../data/config.json');
const opsCommandQueue = require('./ops_command_queue');
const opsApprovalStore = require('./ops_approval_store');
const opsFileControl = require('./ops_file_control');
const { enqueueBridgePayload, makeTaskId } = require('./bridge_queue');
const botManager = require('./capabilities/bot_manager');
const fileManager = require('./capabilities/file_manager');
const mailManager = require('./capabilities/mail_manager');
const photoManager = require('./capabilities/photo_manager');
const scheduleManager = require('./capabilities/schedule_manager');
const browserManager = require('./capabilities/browser_manager');
const execManager = require('./capabilities/exec_manager');
const codexManager = require('./capabilities/codex_manager');
const telegramFinalizer = require('./finalizer');
const approvalAuditLog = require('./approval_audit_log');
const botPermissionPolicy = require('./bot_permission_policy');
const {
  rotateMainSessionIfNeeded,
} = require('./lib/main_session_rotation');

const RUNTIME_DIR = path.join(__dirname, '..', 'data', 'runtime');
const QUEUE_PATH = path.join(RUNTIME_DIR, 'ops_requests.jsonl');
const RESULT_PATH = path.join(RUNTIME_DIR, 'ops_results.jsonl');
const PROCESSED_PATH = path.join(RUNTIME_DIR, 'ops_processed_ids.json');
const SNAPSHOT_PATH = path.join(RUNTIME_DIR, 'ops_snapshot.json');
const TUNNEL_STATE_PATH = path.join(RUNTIME_DIR, 'tunnel_state.json');
const SKILL_FEEDBACK_STATE_PATH = path.join(RUNTIME_DIR, 'skill_feedback_state.json');
const SKILL_FEEDBACK_SCRIPT = path.join(ROOT, 'scripts', 'skill_feedback_loop.js');
const NOTIFY_AGGREGATE_STATE_PATH = path.join(RUNTIME_DIR, 'ops_notify_aggregate_state.json');
const NOTIFY_WINDOW_MS = Math.max(5, Number(process.env.OPS_NOTIFY_WINDOW_MINUTES || 30)) * 60 * 1000;
const NOTIFY_SUPPRESSED_SUMMARY_THRESHOLD = Math.max(2, Number(process.env.OPS_NOTIFY_SUPPRESSED_SUMMARY_THRESHOLD || 3));
const NOTIFY_SOURCE_KINDS = Object.freeze(['user_direct', 'test', 'internal', 'scheduled_background']);
const NOTIFY_SEVERITIES = Object.freeze(['P1', 'P2', 'P3', 'P4', 'UNKNOWN']);
const SAFE_INTERNAL_ERROR_REPLY = '실패\n원인: 내부 실행 오류가 발생했어.\n다음 조치: 잠시 후 다시 시도해줘.';
const TRACE_BLOCK_PATTERNS = [
  /Exec:/i,
  /Command exited with code\s+\d+/i,
  /Command aborted by signal/i,
  /^\s*sh:\s*\d+:/i,
  /"tool"\s*:\s*"exec"/i,
  /Traceback \(most recent call last\)/i,
  /^\s*(stderr|stack trace|raw json)\s*[:：]/i,
  /^\s*\{\s*"status"\s*:\s*"error"/i,
];
const BRIDGE_NOTIFY_POLICY_MODE = resolveBridgeNotifyPolicyMode();

const ALLOWED_FILE_CONTROL_ACTIONS = new Set([
  'list_files',
  'compute_plan',
  'move',
  'rename',
  'archive',
  'trash',
  'restore',
  'drive_preflight_check',
  'git_status',
  'git_diff',
  'git_mv',
  'git_add',
  'git_commit',
  'git_push',
]);

const CAPABILITY_HANDLERS = Object.freeze({
  bot: botManager,
  file: fileManager,
  mail: mailManager,
  photo: photoManager,
  schedule: scheduleManager,
  browser: browserManager,
  exec: execManager,
  codex: codexManager,
});

const KNOWN_CONTAINERS = [
  'moltbot-dev',
  'moltbot-anki',
  'moltbot-research',
  'moltbot-daily',
  'moltbot-dev-bak',
  'moltbot-anki-bak',
  'moltbot-research-bak',
  'moltbot-daily-bak',
  'moltbot-codex',
  'moltbot-prompt-web',
  'moltbot-proxy',
  'moltbot-web-proxy',
  'moltbot-dev-tunnel',
];

function isUnifiedApprovalEnabled() {
  const envRaw = String(process.env.MOLTBOT_DISABLE_APPROVAL_TOKENS || '').trim().toLowerCase();
  if (envRaw === '1' || envRaw === 'true' || envRaw === 'on') return false;
  if (envRaw === '0' || envRaw === 'false' || envRaw === 'off') return true;
  const section = (config && typeof config.opsUnifiedApprovals === 'object')
    ? config.opsUnifiedApprovals
    : {};
  return section.enabled !== false;
}

function nowIso() {
  return new Date().toISOString();
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    ok: !res.error && res.status === 0,
    code: res.status == null ? 1 : res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function ensureDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  return fs.readFileSync(QUEUE_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function appendResult(result) {
  fs.appendFileSync(RESULT_PATH, `${JSON.stringify(result)}\n`, 'utf8');
}

function getTunnelUrlFromState() {
  const st = readJson(TUNNEL_STATE_PATH, null);
  const url = st && st.publicUrl ? String(st.publicUrl).trim() : '';
  return /^https:\/\/[a-z0-9.-]+$/i.test(url) ? url : null;
}

function collectSnapshot() {
  const ps = run('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}']);
  const rows = ps.ok ? ps.stdout.split('\n').filter(Boolean) : [];
  const map = new Map();
  for (const row of rows) {
    const idx = row.indexOf('\t');
    if (idx <= 0) continue;
    const name = row.slice(0, idx).trim();
    const status = row.slice(idx + 1).trim();
    map.set(name, status);
  }
  const containers = KNOWN_CONTAINERS.map((name) => ({
    name,
    status: map.get(name) || 'not-running',
  }));
  const snapshot = {
    ok: true,
    updatedAt: nowIso(),
    dockerOk: ps.ok,
    dockerError: ps.ok ? '' : (ps.stderr || ps.error || 'unknown error'),
    tunnelUrl: getTunnelUrlFromState(),
    containers,
  };
  writeJson(SNAPSHOT_PATH, snapshot);
  return snapshot;
}

function parseJsonSafely(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function maybeRunSkillFeedbackLoop() {
  const enabled = String(process.env.SKILL_FEEDBACK_AUTORUN || '1') !== '0';
  if (!enabled) {
    return {
      enabled: false,
      ran: false,
      reason: 'disabled_by_env',
    };
  }

  const minIntervalMinutes = Math.max(10, Number(process.env.SKILL_FEEDBACK_MIN_INTERVAL_MINUTES || 60));
  const now = Date.now();
  const state = readJson(SKILL_FEEDBACK_STATE_PATH, {});
  const lastRunMs = Date.parse(String(state.lastRunAt || ''));
  const nextDueMs = Number.isFinite(lastRunMs)
    ? lastRunMs + (minIntervalMinutes * 60 * 1000)
    : 0;

  if (nextDueMs > now) {
    return {
      enabled: true,
      ran: false,
      reason: 'cooldown',
      nextRunAt: new Date(nextDueMs).toISOString(),
      minIntervalMinutes,
    };
  }

  const limit = Math.max(20, Number(process.env.SKILL_FEEDBACK_LIMIT || 120));
  const result = run('node', [SKILL_FEEDBACK_SCRIPT, '--limit', String(limit)]);
  const parsed = parseJsonSafely(result.stdout);
  const nextState = {
    lastRunAt: nowIso(),
    ok: result.ok,
    code: result.code,
    minIntervalMinutes,
    lastResult: parsed || null,
    stderr: result.stderr || '',
  };
  writeJson(SKILL_FEEDBACK_STATE_PATH, nextState);

  return {
    enabled: true,
    ran: true,
    ok: result.ok,
    code: result.code,
    minIntervalMinutes,
    result: parsed || { raw: result.stdout },
    stderr: result.stderr || '',
  };
}

function maybeRotateStaleMainSession(options = {}) {
  return rotateMainSessionIfNeeded({
    root: options.root || ROOT,
    env: options.env || process.env,
    nowMs: options.nowMs,
    fsModule: options.fsModule || fs,
    pathModule: options.pathModule || path,
  });
}

function resolveFileControlPolicy() {
  const baseConfig = (config && typeof config === 'object') ? config : {};
  const policyPatch = {
    ...((baseConfig.opsFileControlPolicy && typeof baseConfig.opsFileControlPolicy === 'object')
      ? baseConfig.opsFileControlPolicy
      : {}),
  };
  if (baseConfig.telegramGuard && typeof baseConfig.telegramGuard === 'object') {
    policyPatch.telegramGuard = {
      ...((policyPatch.telegramGuard && typeof policyPatch.telegramGuard === 'object') ? policyPatch.telegramGuard : {}),
      ...baseConfig.telegramGuard,
    };
  }
  return opsFileControl.loadPolicy({
    ...baseConfig,
    opsFileControlPolicy: policyPatch,
  });
}

function resolveApprovalGrantPolicy(policy = {}) {
  const raw = (policy && typeof policy === 'object' && policy.approvalGrantPolicy && typeof policy.approvalGrantPolicy === 'object')
    ? policy.approvalGrantPolicy
    : {};
  return {
    enabled: Boolean(raw.enabled),
    grant_on_approval: raw.grant_on_approval !== false,
    scope: String(raw.scope || 'all').trim().toLowerCase() || 'all',
    defaultTtlSeconds: Number(raw.defaultTtlSeconds || 1800),
    minTtlSeconds: Number(raw.minTtlSeconds || 300),
    maxTtlSeconds: Number(raw.maxTtlSeconds || 7200),
  };
}

function findActiveApprovalGrant(policy, requestedBy, scope = 'all') {
  const grantPolicy = resolveApprovalGrantPolicy(policy);
  const requester = String(requestedBy || '').trim();
  if (!grantPolicy.enabled || !requester || requester === 'unknown') {
    return {
      active: false,
      requested_by: requester,
      record: null,
      error_code: 'GRANT_POLICY_DISABLED',
      error: 'approval grant policy disabled or requester missing',
    };
  }
  return opsApprovalStore.hasActiveApprovalGrant({
    requestedBy: requester,
    scope,
  });
}

function maybeIssueApprovalGrant(policy, request, token, consumedRecord = null) {
  const grantPolicy = resolveApprovalGrantPolicy(policy);
  if (!grantPolicy.enabled || grantPolicy.grant_on_approval === false) {
    return {
      issued: false,
      record: null,
      error_code: 'GRANT_POLICY_DISABLED',
      error: 'approval grant policy disabled',
    };
  }
  const requestedBy = String((request && request.requested_by) || '').trim();
  if (!requestedBy || requestedBy === 'unknown') {
    return {
      issued: false,
      record: null,
      error_code: 'REQUESTER_REQUIRED',
      error: 'approval grant requester missing',
    };
  }

  try {
    const grantRecord = opsApprovalStore.createApprovalGrant({
      requestedBy,
      grantPolicy,
      scope: grantPolicy.scope || 'all',
      sourceToken: token,
      sourceRequestId: String((request && request.request_id) || ''),
      grantedBy: String((consumedRecord && consumedRecord.consumed_by) || requestedBy),
    });
    return {
      issued: true,
      record: grantRecord,
      error_code: null,
      error: null,
    };
  } catch (error) {
    return {
      issued: false,
      record: null,
      error_code: String(error && error.code ? error.code : 'GRANT_CREATE_FAILED'),
      error: String(error && error.message ? error.message : error),
    };
  }
}

function resolveBridgeNotifyPolicyMode() {
  const envMode = String(process.env.OPS_NOTIFY_POLICY_MODE || '').trim().toLowerCase();
  const cfgMode = String(
    config
    && config.opsNotificationPolicy
    && typeof config.opsNotificationPolicy === 'object'
    && config.opsNotificationPolicy.mode
      ? config.opsNotificationPolicy.mode
      : '',
  ).trim().toLowerCase();
  const mode = envMode || cfgMode || 'strict';
  if (mode === 'strict' || mode === 'relaxed') return mode;
  return 'strict';
}

function normalizeNotifySourceKind(value) {
  const key = String(value || '').trim().toLowerCase();
  if (NOTIFY_SOURCE_KINDS.includes(key)) return key;
  return 'internal';
}

function normalizeNotifySeverity(value) {
  const key = String(value || '').trim().toUpperCase();
  if (NOTIFY_SEVERITIES.includes(key)) return key;
  return 'UNKNOWN';
}

function detectNotifySourceKind(request = {}) {
  const req = request && typeof request === 'object' ? request : {};
  const requestId = String(req.request_id || '').trim().toLowerCase();
  const requestedBy = String(req.requested_by || '').trim().toLowerCase();
  const telegramContext = (req.telegram_context && typeof req.telegram_context === 'object')
    ? req.telegram_context
    : {};
  const hasDirectTransport = Boolean(
    telegramContext
    && (telegramContext.userId || telegramContext.groupId || telegramContext.chatId),
  );
  if (
    requestId.startsWith('test-')
    || requestedBy.startsWith('test-')
    || requestedBy.includes('test user')
    || requestedBy.includes(':test')
  ) {
    return 'test';
  }
  if (
    requestedBy.includes('ops-daily-supervisor')
    || requestedBy.includes('cron')
    || requestedBy.includes('heartbeat')
    || requestedBy.includes('nightly')
    || requestedBy.includes('autopilot')
    || requestedBy.includes('system:event')
  ) {
    return 'scheduled_background';
  }
  if (
    hasDirectTransport
    || /^(telegram|discord|slack|line|kakao|whatsapp):/.test(requestedBy)
  ) {
    return 'user_direct';
  }
  if (requestedBy.startsWith('bridge:') || requestedBy === 'unknown') {
    return 'internal';
  }
  return 'internal';
}

function classifyNotifySeverity({ ok, errorCode, sourceKind, notificationKind }) {
  const kind = String(notificationKind || 'result').trim().toLowerCase();
  if (kind === 'aggregate_summary') return 'P4';
  if (ok) return 'P4';

  const source = normalizeNotifySourceKind(sourceKind);
  const code = String(errorCode || '').trim().toUpperCase();
  if (!code) return 'UNKNOWN';

  if (code === 'UNHANDLED_WORKER_ERROR' || code === 'TOKEN_CONSUME_FAILED' || code === 'TOKEN_VALIDATE_FAILED') {
    return 'P1';
  }
  if (code === 'CONNECTOR_UNAVAILABLE') {
    return source === 'user_direct' ? 'P2' : 'P3';
  }
  if (code === 'PERMISSION_DENIED') {
    return source === 'user_direct' ? 'P2' : 'P3';
  }
  if (code === 'TOKEN_NOT_FOUND' || code === 'PLAN_MISMATCH' || code === 'APPROVAL_FLAGS_REQUIRED') {
    return 'P3';
  }
  if (code === 'DISPATCH_DELEGATED_SOFT_FAIL') {
    return 'P4';
  }
  if (code.endsWith('_FAILED')) {
    return source === 'user_direct' ? 'P2' : 'P3';
  }
  if (code.endsWith('_REQUIRED') || code.endsWith('_MISSING') || code.includes('_MISMATCH')) {
    return 'P3';
  }
  return 'UNKNOWN';
}

function buildNotifyDedupeKey({ request, command, errorCode, sourceKind, tsMs = Date.now() }) {
  const botId = String(process.env.MOLTBOT_BOT_ID || 'unknown').trim() || 'unknown';
  const req = request && typeof request === 'object' ? request : {};
  const commandKey = String(
    req.command_kind
    || command
    || 'ops',
  ).trim().toLowerCase() || 'ops';
  const capability = String(req.capability || '').trim().toLowerCase();
  const action = String(req.action || req.intent_action || '').trim().toLowerCase();
  const code = String(errorCode || 'OK').trim().toUpperCase() || 'OK';
  const windowStartMs = Math.floor(Number(tsMs) / NOTIFY_WINDOW_MS) * NOTIFY_WINDOW_MS;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const dedupeKey = [
    botId,
    commandKey,
    capability || '-',
    action || '-',
    code,
    normalizeNotifySourceKind(sourceKind),
    windowStartIso,
  ].join(':');
  return { dedupeKey, windowStartIso, windowStartMs };
}

function containsBlockedTrace(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  return TRACE_BLOCK_PATTERNS.some((pattern) => pattern.test(raw));
}

function enforceSafeTelegramReply(text) {
  const sanitized = telegramFinalizer && typeof telegramFinalizer.sanitizeForUser === 'function'
    ? telegramFinalizer.sanitizeForUser(text)
    : String(text || '');
  const normalized = String(sanitized || '').trim();
  if (!normalized) return SAFE_INTERNAL_ERROR_REPLY;
  if (containsBlockedTrace(normalized)) return SAFE_INTERNAL_ERROR_REPLY;
  return normalized;
}

function shouldNotifyUser(event, policyMode = BRIDGE_NOTIFY_POLICY_MODE) {
  const sourceKind = normalizeNotifySourceKind(event && event.source_kind);
  const severity = normalizeNotifySeverity(event && event.severity);
  const notificationKind = String(event && event.notification_kind || 'result').trim().toLowerCase();
  if (notificationKind === 'aggregate_summary') {
    return { notify: true, reason: 'aggregate_summary' };
  }
  if (policyMode !== 'strict') {
    return { notify: true, reason: `policy_${policyMode}` };
  }
  if (sourceKind === 'user_direct') {
    return { notify: true, reason: 'strict:user_direct' };
  }
  if (severity === 'P1' || severity === 'P2') {
    return { notify: true, reason: `strict:${severity}` };
  }
  return { notify: false, reason: `strict:block:${sourceKind}:${severity}` };
}

function readNotifyAggregateState() {
  return readJson(NOTIFY_AGGREGATE_STATE_PATH, {
    schema_version: '1.0',
    windows: {},
    updated_at: null,
  });
}

function writeNotifyAggregateState(state) {
  const payload = (state && typeof state === 'object') ? state : {};
  payload.schema_version = '1.0';
  payload.updated_at = nowIso();
  payload.windows = payload.windows && typeof payload.windows === 'object' ? payload.windows : {};
  writeJson(NOTIFY_AGGREGATE_STATE_PATH, payload);
  return payload;
}

function maybeEnqueueSuppressedSummary(event) {
  if (!event || event.ok || !event.errorCode) return { summarized: false, reason: 'not_eligible' };
  const sourceKind = normalizeNotifySourceKind(event.source_kind);
  if (sourceKind === 'user_direct' || sourceKind === 'test') {
    return { summarized: false, reason: `${sourceKind}_passthrough` };
  }
  const severity = normalizeNotifySeverity(event.severity);
  if (severity === 'P1' || severity === 'P2') return { summarized: false, reason: 'high_severity' };
  const classification = buildNotifyDedupeKey({
    request: event.request,
    command: event.command,
    errorCode: event.errorCode,
    sourceKind,
    tsMs: event.timestampMs,
  });
  const state = readNotifyAggregateState();
  const key = classification.dedupeKey;
  const now = nowIso();
  const row = state.windows[key] && typeof state.windows[key] === 'object'
    ? state.windows[key]
    : {
        source_kind: sourceKind,
        severity,
        error_code: String(event.errorCode || 'UNKNOWN'),
        command: String(event.command || '').trim() || null,
        window_start: classification.windowStartIso,
        count: 0,
        first_seen: now,
        last_seen: now,
        summary_enqueued: false,
      };
  row.count = Number(row.count || 0) + 1;
  row.last_seen = now;
  state.windows[key] = row;

  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  for (const [windowKey, windowValue] of Object.entries(state.windows)) {
    if (!windowValue || typeof windowValue !== 'object') {
      delete state.windows[windowKey];
      continue;
    }
    const windowStartMs = Date.parse(String(windowValue.window_start || ''));
    if (Number.isFinite(windowStartMs) && windowStartMs < cutoff) {
      delete state.windows[windowKey];
    }
  }

  let summaryPayload = null;
  if (!row.summary_enqueued && row.count >= NOTIFY_SUPPRESSED_SUMMARY_THRESHOLD) {
    row.summary_enqueued = true;
    row.summary_enqueued_at = now;
    const summaryText = [
      '[OPS] 내부 오류 집계 (30분)',
      `- error: ${row.error_code}`,
      `- count: ${row.count}`,
      `- source: ${row.source_kind}`,
      '- 영향: 사용자 직접 요청 영향 없음 (내부 처리됨)',
    ].join('\n');
    const summaryReply = enforceSafeTelegramReply(finalizeOpsTelegramReply(event.request || {}, summaryText, 'execute'));
    summaryPayload = {
      taskId: makeTaskId('ops-notify-summary'),
      command: String(event.command || 'ops:summary'),
      requestId: String(event.request && event.request.request_id || ''),
      status: 'done',
      timestamp: nowIso(),
      telegramReply: summaryReply,
      notification_kind: 'aggregate_summary',
      source_kind: row.source_kind,
      severity: 'P4',
      user_visible: true,
      dedupe_key: key,
      classification_reason: `aggregate_summary_threshold:${NOTIFY_SUPPRESSED_SUMMARY_THRESHOLD}`,
      metadata: {
        phase: event.phase || null,
        ok: false,
        errorCode: row.error_code,
        aggregateCount: row.count,
        aggregateWindowStart: row.window_start,
      },
    };
    enqueueBridgePayload(summaryPayload);
  }

  writeNotifyAggregateState(state);
  return {
    summarized: Boolean(summaryPayload),
    reason: summaryPayload ? 'summary_enqueued' : 'aggregated_only',
    aggregateCount: row.count,
  };
}

function enqueueBridgeNotification({
  request,
  taskPrefix,
  command,
  status,
  phase,
  ok,
  telegramReply,
  errorCode = '',
  errorMessage = '',
  metadata = {},
  notificationKind = 'result',
}) {
  const sourceKind = detectNotifySourceKind(request);
  const severity = classifyNotifySeverity({
    ok,
    errorCode,
    sourceKind,
    notificationKind,
  });
  const classification = buildNotifyDedupeKey({
    request,
    command,
    errorCode: errorCode || (ok ? 'OK' : 'UNKNOWN'),
    sourceKind,
    tsMs: Date.now(),
  });
  const policyDecision = shouldNotifyUser({
    source_kind: sourceKind,
    severity,
    notification_kind: notificationKind,
  }, BRIDGE_NOTIFY_POLICY_MODE);
  const safeReply = enforceSafeTelegramReply(telegramReply);
  const classificationReason = `${policyDecision.reason};policy=${BRIDGE_NOTIFY_POLICY_MODE}`;
  const payload = {
    taskId: makeTaskId(taskPrefix),
    command,
    requestId: String(request && request.request_id || ''),
    status,
    timestamp: nowIso(),
    telegramReply: safeReply,
    notification_kind: String(notificationKind || 'result'),
    source_kind: sourceKind,
    severity,
    user_visible: Boolean(policyDecision.notify),
    dedupe_key: classification.dedupeKey,
    classification_reason: classificationReason,
    metadata: {
      phase,
      ok,
      errorCode: errorCode || null,
      errorMessage: errorMessage || null,
      source_kind: sourceKind,
      severity,
      user_visible: Boolean(policyDecision.notify),
      dedupe_key: classification.dedupeKey,
      classification_reason: classificationReason,
      ...metadata,
    },
  };

  if (!policyDecision.notify) {
    maybeEnqueueSuppressedSummary({
      ok,
      errorCode,
      severity,
      source_kind: sourceKind,
      request,
      command,
      phase,
      timestampMs: Date.now(),
    });
    approvalAuditLog.append('bridge_notification_suppressed', {
      request_id: String(request && request.request_id || ''),
      command: String(command || ''),
      phase: String(phase || ''),
      ok: Boolean(ok),
      error_code: errorCode || null,
      source_kind: sourceKind,
      severity,
      dedupe_key: classification.dedupeKey,
      reason: classificationReason,
    });
    return null;
  }

  enqueueBridgePayload(payload);
  return payload;
}

function summarizeGitPreview(plan) {
  const lines = [];
  const git = plan && plan.git && typeof plan.git === 'object' ? plan.git : null;
  if (!git) return '';
  if (git.repo_root) lines.push(`- git repo: ${git.repo_root}`);
  if (git.status && git.status.stdout) {
    const statusLines = String(git.status.stdout).split('\n').slice(0, 8).filter(Boolean);
    if (statusLines.length > 0) {
      lines.push('- git status preview:');
      for (const line of statusLines) lines.push(`  ${line}`);
    }
  }
  if (git.diff && git.diff.stdout) {
    const diffLines = String(git.diff.stdout).split('\n').slice(0, 20).filter(Boolean);
    if (diffLines.length > 0) {
      lines.push('- git diff preview:');
      for (const line of diffLines) lines.push(`  ${line}`);
    }
  }
  return lines.join('\n');
}

function finalizeOpsTelegramReply(request, replyText, phase = '') {
  const raw = String(replyText || '').trim();
  if (!raw) return raw;
  const telegramContext = request && request.telegram_context && typeof request.telegram_context === 'object'
    ? request.telegram_context
    : null;
  const requestedBy = String(request && request.requested_by || '').trim();
  const finalized = telegramFinalizer.finalizeTelegramReply(raw, {
    botId: process.env.MOLTBOT_BOT_ID,
    botRole: process.env.MOLTBOT_BOT_ROLE,
    telegramContext,
    requestedBy,
    route: [
      'ops',
      String(request && request.command_kind || '').trim().toLowerCase(),
      String(request && request.capability || '').trim().toLowerCase(),
      String(request && request.action || '').trim().toLowerCase(),
      String(phase || '').trim().toLowerCase(),
    ].filter(Boolean).join(':'),
    finalizerApplied: false,
  });
  const normalized = enforceSafeTelegramReply(finalized || raw);
  if (normalized) return normalized;
  return SAFE_INTERNAL_ERROR_REPLY;
}

function logAutoExecuteDecision(request, plan, decision) {
  const actorBotId = String(process.env.MOLTBOT_BOT_ID || 'unknown').trim() || 'unknown';
  const actorRequestedBy = String(request && request.requested_by || 'unknown');
  approvalAuditLog.append('auto_execute_decision', {
    request_id: String(request && request.request_id || ''),
    requested_by: actorRequestedBy,
    command_kind: String(request && request.command_kind || 'file_control'),
    action_type: String((plan && (plan.action_type || plan.capability)) || 'file_control'),
    capability: String(plan && plan.capability || ''),
    action: String(plan && plan.action || plan && plan.intent_action || ''),
    decision: String(decision || '').trim() || 'approval_required',
    risk_level: String(plan && plan.risk_tier || request && request.risk_tier || 'MEDIUM'),
    payload: plan && plan.payload ? plan.payload : {},
    actor_requested_by: actorRequestedBy,
    actor_bot_id: actorBotId,
    token_owner_requested_by: actorRequestedBy,
    token_owner_bot_id: actorBotId,
  });
}

function logExecutionResult(request, planOrResult, executeResult, ok) {
  const source = (planOrResult && typeof planOrResult === 'object') ? planOrResult : {};
  const result = (executeResult && typeof executeResult === 'object') ? executeResult : {};
  const actorBotId = String(process.env.MOLTBOT_BOT_ID || 'unknown').trim() || 'unknown';
  const actorRequestedBy = String(request && request.requested_by || 'unknown');
  approvalAuditLog.append('execution_result', {
    request_id: String(request && request.request_id || ''),
    requested_by: actorRequestedBy,
    command_kind: String(request && request.command_kind || source.command_kind || 'file_control'),
    action_type: String(source.action_type || source.capability || 'file_control'),
    capability: String(source.capability || request && request.capability || ''),
    action: String(source.action || source.intent_action || request && request.action || ''),
    risk_level: String(source.risk_tier || request && request.risk_tier || 'MEDIUM'),
    ok: Boolean(ok),
    error_code: result.error_code || null,
    error: result.error || null,
    summary: result.summary || null,
    payload: source.payload || {},
    actor_requested_by: actorRequestedBy,
    actor_bot_id: actorBotId,
    token_owner_requested_by: actorRequestedBy,
    token_owner_bot_id: actorBotId,
  });
}

function notifyBridgePlanResult(request, plan, approvalRecord, ok, errorCode = '', errorMessage = '') {
  const baseReply = ok
    ? opsFileControl.formatPlanReply(plan, approvalRecord)
    : [
        '[PLAN] failed',
        `- error: ${errorCode || 'PLAN_FAILED'}`,
        `- detail: ${errorMessage || 'unknown error'}`,
      ].join('\n');
  const gitPreview = ok ? summarizeGitPreview(plan) : '';
  const telegramReplyRaw = gitPreview ? `${baseReply}\n${gitPreview}` : baseReply;
  const telegramReply = finalizeOpsTelegramReply(request, telegramReplyRaw, 'plan');
  enqueueBridgeNotification({
    request,
    taskPrefix: 'opsfc-plan',
    command: 'ops:file-control:plan',
    status: ok ? 'done' : 'failed',
    phase: 'plan',
    ok,
    telegramReply,
    errorCode,
    errorMessage,
    metadata: {
      token: approvalRecord ? approvalRecord.token : null,
    },
  });
}

function notifyBridgeExecuteResult(request, executeResult, ok, errorCode = '', errorMessage = '') {
  const directReply = executeResult && typeof executeResult.telegramReply === 'string'
    ? String(executeResult.telegramReply).trim()
    : '';
  let approvalGrantLine = '';
  if (executeResult && executeResult.approval_grant && typeof executeResult.approval_grant === 'object') {
    const scope = String(executeResult.approval_grant.scope || 'all');
    const expiresAt = String(executeResult.approval_grant.expires_at || '').trim();
    approvalGrantLine = `- approval grant: active (${scope}${expiresAt ? ` until ${expiresAt}` : ''})`;
  }
  const telegramReplyRaw = directReply || (ok
    ? opsFileControl.formatExecuteReply(executeResult)
    : [
        '[RESULT] execute failed',
        `- error: ${errorCode || 'EXECUTE_FAILED'}`,
        `- detail: ${errorMessage || 'unknown error'}`,
        approvalGrantLine,
      ].filter(Boolean).join('\n'));
  const telegramReply = finalizeOpsTelegramReply(request, telegramReplyRaw, 'execute');
  enqueueBridgeNotification({
    request,
    taskPrefix: 'opsfc-exec',
    command: 'ops:file-control:execute',
    status: ok ? 'done' : 'failed',
    phase: 'execute',
    ok,
    telegramReply,
    errorCode,
    errorMessage,
    metadata: {
      token: request.payload && request.payload.token ? String(request.payload.token) : null,
    },
  });
}

function normalizeFileControlRequest(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const commandKind = String(input.command_kind || 'file_control').trim().toLowerCase();
  const capability = String(input.capability || '').trim().toLowerCase();
  const capabilityAction = String(input.action || '').trim().toLowerCase();
  return {
    schema_version: String(input.schema_version || '1.0'),
    request_id: String(input.request_id || '').trim() || opsCommandQueue.makeRequestId('opsfc'),
    command_kind: commandKind,
    capability,
    action: capabilityAction,
    phase: String(input.phase || 'plan').trim().toLowerCase(),
    intent_action: String(input.intent_action || '').trim(),
    reason: String(input.reason || '').trim(),
    risk_tier: String(input.risk_tier || '').trim().toUpperCase(),
    requires_approval: Boolean(input.requires_approval),
    required_flags: Array.isArray(input.required_flags)
      ? input.required_flags.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
      : [],
    requested_by: String(input.requested_by || 'unknown').trim() || 'unknown',
    telegram_context: (input.telegram_context && typeof input.telegram_context === 'object') ? input.telegram_context : null,
    payload: (input.payload && typeof input.payload === 'object') ? input.payload : {},
    created_at: String(input.created_at || nowIso()),
  };
}

function buildFileControlResultBase(request, overrides = {}) {
  return {
    request_id: request.request_id,
    token_id: overrides.token_id || null,
    requested_by: request.requested_by,
    phase: request.phase,
    intent_action: request.intent_action || null,
    plan_summary: overrides.plan_summary || null,
    executed_steps: Array.isArray(overrides.executed_steps) ? overrides.executed_steps : [],
    file_counts: overrides.file_counts || {},
    hashes: Array.isArray(overrides.hashes) ? overrides.hashes : [],
    rollback_instructions: Array.isArray(overrides.rollback_instructions) ? overrides.rollback_instructions : [],
    ok: Boolean(overrides.ok),
    error_code: overrides.error_code || null,
    error: overrides.error || null,
  };
}

function planSummaryObject(plan, approvalRecord) {
  const summary = {
    intent_action: plan.intent_action,
    risk_tier: plan.risk_tier,
    mutating: Boolean(plan.mutating),
    required_flags: Array.isArray(plan.required_flags) ? plan.required_flags : [],
    exact_paths: Array.isArray(plan.exact_paths) ? plan.exact_paths : [],
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
    blockers: Array.isArray(plan.blockers) ? plan.blockers : [],
    preflight: plan.preflight || null,
  };
  if (plan && plan.approval_grant && typeof plan.approval_grant === 'object') {
    summary.approval_grant = plan.approval_grant;
  }
  if (approvalRecord) {
    summary.token = approvalRecord.token;
    summary.expires_at = approvalRecord.expires_at;
  }
  return summary;
}

function buildCapabilityResultBase(request, overrides = {}) {
  return {
    request_id: request.request_id,
    command_kind: 'capability',
    capability: overrides.capability || request.capability || null,
    action: overrides.action || request.action || null,
    token_id: overrides.token_id || null,
    requested_by: request.requested_by,
    phase: request.phase,
    risk_tier: overrides.risk_tier || request.risk_tier || null,
    requires_approval: typeof overrides.requires_approval === 'boolean'
      ? overrides.requires_approval
      : Boolean(request.requires_approval),
    plan_summary: overrides.plan_summary || null,
    executed_steps: Array.isArray(overrides.executed_steps) ? overrides.executed_steps : [],
    details: overrides.details || null,
    ok: Boolean(overrides.ok),
    error_code: overrides.error_code || null,
    error: overrides.error || null,
  };
}

function capabilitySummaryObject(plan, approvalRecord = null) {
  const summary = {
    command_kind: 'capability',
    capability: plan.capability || null,
    action: plan.action || null,
    intent_action: plan.intent_action || null,
    risk_tier: plan.risk_tier || null,
    requires_approval: Boolean(plan.requires_approval),
    mutating: Boolean(plan.mutating),
    required_flags: Array.isArray(plan.required_flags) ? plan.required_flags : [],
    blockers: Array.isArray(plan.blockers) ? plan.blockers : [],
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
    plan_summary: plan.plan_summary || '',
  };
  if (plan && plan.approval_grant && typeof plan.approval_grant === 'object') {
    summary.approval_grant = plan.approval_grant;
  }
  if (approvalRecord) {
    summary.token = approvalRecord.token;
    summary.expires_at = approvalRecord.expires_at;
  }
  return summary;
}

function getCapabilityHandler(capability) {
  const key = String(capability || '').trim().toLowerCase();
  if (!key) return null;
  return CAPABILITY_HANDLERS[key] || null;
}

function resolveCapabilityPolicy(policy, capability, action, fallback = {}) {
  const key = `${String(capability || '').trim().toLowerCase()}:${String(action || '').trim().toLowerCase()}`;
  return opsFileControl.resolveActionRiskPolicy(policy, 'capability', key, fallback);
}

function buildCapabilityPlanFromHandler(request, policy) {
  const capability = String(request.capability || '').trim().toLowerCase();
  const action = String(request.action || '').trim().toLowerCase();
  const handler = getCapabilityHandler(capability);
  if (!handler) {
    return {
      ok: false,
      error_code: 'CAPABILITY_NOT_SUPPORTED',
      error: `unsupported capability: ${capability || '(empty)'}`,
      plan: null,
    };
  }

  const planned = handler.plan({
    action,
    payload: request.payload || {},
    requestedBy: request.requested_by,
    telegramContext: request.telegram_context || {},
    policy,
  });
  if (!planned || !planned.ok || !planned.plan) {
    return {
      ok: false,
      error_code: String((planned && planned.error_code) || 'CAPABILITY_PLAN_FAILED'),
      error: String((planned && planned.error) || `failed to build plan: ${capability}:${action}`),
      plan: null,
    };
  }

  const plan = {
    command_kind: 'capability',
    capability,
    action,
    intent_action: `capability:${capability}:${action}`,
    created_at: nowIso(),
    requested_by: request.requested_by,
    payload: (planned.plan.payload && typeof planned.plan.payload === 'object') ? planned.plan.payload : {},
    mutating: Boolean(planned.plan.mutating),
    risk_tier: String(planned.plan.risk_tier || request.risk_tier || 'MEDIUM').toUpperCase(),
    requires_approval: Boolean(planned.plan.requires_approval || request.requires_approval),
    required_flags: Array.isArray(planned.plan.required_flags) ? planned.plan.required_flags : [],
    blockers: Array.isArray(planned.plan.blockers) ? planned.plan.blockers : [],
    warnings: Array.isArray(planned.plan.warnings) ? planned.plan.warnings : [],
    operations: Array.isArray(planned.plan.operations) ? planned.plan.operations : [],
    rollback_instructions: Array.isArray(planned.plan.rollback_instructions) ? planned.plan.rollback_instructions : [],
    plan_summary: String(planned.plan.plan_summary || `${capability}:${action}`),
    connector: planned.plan.connector || null,
  };

  const riskPolicy = resolveCapabilityPolicy(policy, capability, action, {
    risk_tier: plan.risk_tier,
    requires_approval: plan.requires_approval,
    required_flags: plan.required_flags,
  });
  plan.risk_tier = riskPolicy.risk_tier;
  if (riskPolicy.requires_approval) {
    plan.requires_approval = true;
    plan.required_flags = Array.isArray(riskPolicy.required_flags) && riskPolicy.required_flags.length > 0
      ? riskPolicy.required_flags
      : ['force'];
  } else {
    plan.requires_approval = false;
    plan.required_flags = [];
  }

  if (plan.requires_approval) {
    plan.mutating = true;
  }

  if (!isUnifiedApprovalEnabled()) {
    plan.requires_approval = false;
    plan.required_flags = [];
  }

  return {
    ok: true,
    plan,
    handler,
  };
}

function notifyBridgeCapabilityPlanResult(request, plan, approvalRecord, ok, errorCode = '', errorMessage = '') {
  const lines = [];
  if (ok && plan) {
    lines.push(`[PLAN] capability ${plan.capability}:${plan.action}`);
    lines.push(`- risk: ${plan.risk_tier || 'MEDIUM'}`);
    lines.push(`- requires approval: ${plan.requires_approval ? 'yes' : 'no'}`);
    if (plan.plan_summary) {
      lines.push(`- summary: ${String(plan.plan_summary).replace(/\\n/g, ' | ')}`);
    }
    if (Array.isArray(plan.blockers) && plan.blockers.length > 0) {
      lines.push(`- blockers: ${plan.blockers.slice(0, 3).map((item) => item.code || 'BLOCKED').join(', ')}`);
    }
    if (approvalRecord) {
      if (approvalRecord.request_id) {
        lines.push(`- request: ${approvalRecord.request_id}`);
      }
      if (approvalRecord.expires_at) {
        lines.push(`- expires: ${approvalRecord.expires_at}`);
      }
      lines.push('- next: `운영: 액션: 승인`으로 실행, `운영: 액션: 거부`로 취소');
    }
  } else {
    lines.push('[PLAN] capability failed');
    lines.push(`- error: ${errorCode || 'CAPABILITY_PLAN_FAILED'}`);
    lines.push(`- detail: ${errorMessage || 'unknown error'}`);
  }

  const telegramReply = finalizeOpsTelegramReply(request, lines.join('\\n'), 'plan');
  enqueueBridgeNotification({
    request,
    taskPrefix: 'opsc-plan',
    command: 'ops:capability:plan',
    status: ok ? 'done' : 'failed',
    phase: 'plan',
    ok,
    telegramReply,
    errorCode,
    errorMessage,
    metadata: {
      command_kind: 'capability',
      capability: request.capability || null,
      action: request.action || null,
      token: approvalRecord ? approvalRecord.token : null,
    },
  });
}

function notifyBridgeCapabilityExecuteResult(request, executeResult, ok, errorCode = '', errorMessage = '') {
  const lines = [];
  const directReply = executeResult && typeof executeResult.telegramReply === 'string'
    ? String(executeResult.telegramReply).trim()
    : '';
  const errorClass = executeResult && typeof executeResult.error_class === 'string'
    ? String(executeResult.error_class).trim().toUpperCase()
    : '';
  const isSoftFail = Boolean(
    errorClass === 'SOFT_FAIL'
    || (executeResult && executeResult.soft_fail === true)
    || String(errorCode || '').trim().toUpperCase() === 'DISPATCH_DELEGATED_SOFT_FAIL',
  );
  if (ok && executeResult && !isSoftFail) {
    if (directReply) {
      lines.push(directReply);
    } else {
      lines.push(`[RESULT] capability ${executeResult.capability}:${executeResult.action}`);
      lines.push('- ok: yes');
      if (executeResult.approval_grant && typeof executeResult.approval_grant === 'object') {
        const scope = String(executeResult.approval_grant.scope || 'all');
        const expiresAt = String(executeResult.approval_grant.expires_at || '').trim();
        lines.push(`- approval grant: active (${scope}${expiresAt ? ` until ${expiresAt}` : ''})`);
      }
      if (executeResult.summary) lines.push(`- summary: ${executeResult.summary}`);
      if (executeResult.note) lines.push(`- note: ${executeResult.note}`);
      if (executeResult.dry_run) lines.push('- dry-run: yes');
    }
  } else if (isSoftFail) {
    lines.push('[RESULT] capability advisory');
    if (directReply) lines.push(directReply);
    const advisoryNote = String(
      errorMessage
      || executeResult && (executeResult.note || executeResult.error || executeResult.summary)
      || '',
    ).trim();
    if (advisoryNote) lines.push(`- note: ${advisoryNote}`);
  } else {
    lines.push('[RESULT] capability execute failed');
    lines.push(`- error: ${errorCode || 'CAPABILITY_EXECUTE_FAILED'}`);
    lines.push(`- detail: ${errorMessage || 'unknown error'}`);
    if (directReply) lines.push(`- reply: ${directReply}`);
    if (executeResult && executeResult.approval_grant && typeof executeResult.approval_grant === 'object') {
      const scope = String(executeResult.approval_grant.scope || 'all');
      const expiresAt = String(executeResult.approval_grant.expires_at || '').trim();
      lines.push(`- approval grant: active (${scope}${expiresAt ? ` until ${expiresAt}` : ''})`);
    }
  }

  const telegramReply = finalizeOpsTelegramReply(request, lines.join('\\n'), 'execute');
  const queueStatus = (ok || isSoftFail) ? 'done' : 'failed';
  enqueueBridgeNotification({
    request,
    taskPrefix: 'opsc-exec',
    command: 'ops:capability:execute',
    status: queueStatus,
    phase: 'execute',
    ok,
    telegramReply,
    errorCode,
    errorMessage,
    metadata: {
      command_kind: 'capability',
      capability: request.capability || null,
      action: request.action || null,
      token: request.payload && request.payload.token ? String(request.payload.token) : null,
      error_class: errorClass || null,
    },
    notificationKind: isSoftFail ? 'advisory' : 'result',
  });
}

function executeCapabilityPlan(request, plan, handler, policy) {
  if (!handler) {
    return {
      ok: false,
      error_code: 'CAPABILITY_HANDLER_MISSING',
      error: `capability handler missing: ${plan.capability || '(unknown)'}`,
      details: null,
      executed_steps: [],
    };
  }
  if (Array.isArray(plan.blockers) && plan.blockers.length > 0) {
    const first = plan.blockers[0] || {};
    return {
      ok: false,
      error_code: String(first.code || 'PLAN_BLOCKED'),
      error: String(first.message || 'capability plan blocked'),
      details: { blockers: plan.blockers },
      executed_steps: [],
    };
  }

  const result = handler.execute({
    action: plan.action,
    payload: plan.payload || {},
    plan,
    policy,
  });
  if (!result || !result.ok) {
    const errorClass = String(result && result.error_class || '').trim().toUpperCase();
    if (errorClass === 'SOFT_FAIL') {
      const advisorySteps = Array.isArray(result && result.executed_steps)
        ? result.executed_steps
        : [{ step: `${plan.capability}:${plan.action}:advisory`, ok: true }];
      return {
        ok: true,
        advisory: true,
        details: {
          ...(result || {}),
          advisory: true,
          soft_fail: true,
          error_class: 'SOFT_FAIL',
          note: String(result && (result.error || result.summary) || 'advisory guidance from delegated route'),
        },
        executed_steps: advisorySteps,
      };
    }
    return {
      ok: false,
      error_code: String((result && result.error_code) || 'CAPABILITY_EXECUTE_FAILED'),
      error: String((result && result.error) || `capability execute failed: ${plan.capability}:${plan.action}`),
      details: result || null,
      executed_steps: Array.isArray(result && result.executed_steps) ? result.executed_steps : [],
    };
  }
  const executedSteps = Array.isArray(result.executed_steps)
    ? result.executed_steps
    : [{ step: `${plan.capability}:${plan.action}`, ok: true }];
  return {
    ok: true,
    details: result,
    executed_steps: executedSteps,
  };
}

function handleCapabilityPlanPhase(request, policy) {
  const built = buildCapabilityPlanFromHandler(request, policy);
  if (!built.ok || !built.plan) {
    notifyBridgeCapabilityPlanResult(request, null, null, false, built.error_code, built.error);
    return buildCapabilityResultBase(request, {
      ok: false,
      error_code: built.error_code || 'CAPABILITY_PLAN_FAILED',
      error: built.error || 'capability plan failed',
    });
  }

  const plan = built.plan;
  const runtimeBotId = String(process.env.MOLTBOT_BOT_ID || 'unknown').trim() || 'unknown';
  const capabilityAllowed = botPermissionPolicy.canUseCapability(runtimeBotId, plan.capability, plan.action);
  if (!capabilityAllowed) {
    const errorCode = 'PERMISSION_DENIED';
    const errorMessage = `capability not allowed for bot ${runtimeBotId}: ${plan.capability}:${plan.action}`;
    approvalAuditLog.append('approval_decision', {
      decision: 'permission_denied',
      request_id: String(request && request.request_id || ''),
      command_kind: 'capability',
      capability: String(plan.capability || ''),
      action: String(plan.action || ''),
      action_type: String(plan.action_type || plan.capability || 'capability'),
      risk_level: String(plan.risk_tier || 'MEDIUM'),
      actor_requested_by: String(request && request.requested_by || 'unknown'),
      actor_bot_id: runtimeBotId,
      token_owner_requested_by: String(request && request.requested_by || 'unknown'),
      token_owner_bot_id: runtimeBotId,
      error_code: errorCode,
      error: errorMessage,
    });
    notifyBridgeCapabilityPlanResult(request, null, null, false, errorCode, errorMessage);
    return buildCapabilityResultBase(request, {
      capability: plan.capability,
      action: plan.action,
      risk_tier: plan.risk_tier,
      requires_approval: true,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
    });
  }
  const activeGrant = plan.requires_approval
    ? findActiveApprovalGrant(policy, request.requested_by, 'all')
    : { active: false, record: null };

  if (plan.requires_approval && activeGrant.active && activeGrant.record) {
    plan.requires_approval = false;
    plan.required_flags = [];
    plan.approval_grant = {
      grant_id: activeGrant.record.grant_id || null,
      scope: activeGrant.record.scope || 'all',
      expires_at: activeGrant.record.expires_at || null,
      source_token: activeGrant.record.source_token || null,
    };
  }

  logAutoExecuteDecision(request, plan, plan.requires_approval ? 'approval_required' : 'auto_execute');

  const snapshotHash = opsApprovalStore.hashPlanSnapshot(plan);
  if (plan.requires_approval) {
    const approvalRecord = opsApprovalStore.createApprovalToken({
      requestedBy: request.requested_by,
      requestId: request.request_id,
      ttlPolicy: policy.ttlPolicy || {},
      requiredFlags: plan.required_flags || [],
      planSnapshotHash: snapshotHash,
      plan,
      planSummary: capabilitySummaryObject(plan, null),
      actionType: plan.capability || 'capability',
      riskLevel: plan.risk_tier || 'MEDIUM',
      botId: process.env.MOLTBOT_BOT_ID || '',
    });
    notifyBridgeCapabilityPlanResult(request, plan, approvalRecord, true);
    return buildCapabilityResultBase(request, {
      token_id: approvalRecord.token,
      capability: plan.capability,
      action: plan.action,
      risk_tier: plan.risk_tier,
      requires_approval: true,
      plan_summary: capabilitySummaryObject(plan, approvalRecord),
      ok: true,
    });
  }

  if (plan.approval_grant) {
    notifyBridgeCapabilityPlanResult(request, plan, null, true);
  }
  const executed = executeCapabilityPlan(request, plan, built.handler, policy);
  if (!executed.ok) {
    logExecutionResult(request, plan, executed.details || executed, false);
    notifyBridgeCapabilityExecuteResult(request, {
      ...(executed.details || {}),
      approval_grant: plan.approval_grant || null,
    }, false, executed.error_code, executed.error);
    return buildCapabilityResultBase(request, {
      capability: plan.capability,
      action: plan.action,
      risk_tier: plan.risk_tier,
      requires_approval: false,
      plan_summary: capabilitySummaryObject(plan, null),
      executed_steps: executed.executed_steps,
      details: executed.details,
      ok: false,
      error_code: executed.error_code,
      error: executed.error,
    });
  }

  logExecutionResult(request, plan, executed.details || executed, true);
  notifyBridgeCapabilityExecuteResult(request, {
    capability: plan.capability,
    action: plan.action,
    ...(executed.details || {}),
    approval_grant: plan.approval_grant || null,
  }, true);
  return buildCapabilityResultBase(request, {
    capability: plan.capability,
    action: plan.action,
    risk_tier: plan.risk_tier,
    requires_approval: false,
    plan_summary: capabilitySummaryObject(plan, null),
    executed_steps: executed.executed_steps,
    details: executed.details,
    ok: true,
  });
}

function handleCapabilityExecuteWithToken(request, policy, token, tokenRecord, planned) {
  const runtimeBotId = String(process.env.MOLTBOT_BOT_ID || 'unknown').trim() || 'unknown';
  const capabilityRequest = {
    ...request,
    command_kind: 'capability',
    capability: String(planned.capability || '').trim().toLowerCase(),
    action: String(planned.action || '').trim().toLowerCase(),
    payload: (planned.payload && typeof planned.payload === 'object') ? planned.payload : {},
    risk_tier: String(planned.risk_tier || request.risk_tier || '').trim().toUpperCase(),
    requires_approval: true,
  };

  const rebuilt = buildCapabilityPlanFromHandler(capabilityRequest, policy);
  if (!rebuilt.ok || !rebuilt.plan) {
    const errorCode = String(rebuilt.error_code || 'CAPABILITY_PLAN_RECOMPUTE_FAILED');
    const errorMessage = String(rebuilt.error || 'capability plan recompute failed');
    notifyBridgeCapabilityExecuteResult(request, null, false, errorCode, errorMessage);
    return buildCapabilityResultBase(request, {
      token_id: token,
      capability: capabilityRequest.capability,
      action: capabilityRequest.action,
      plan_summary: tokenRecord.plan_summary || null,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
    });
  }

  const recomputedPlan = rebuilt.plan;
  const recomputedHash = opsApprovalStore.hashPlanSnapshot(recomputedPlan);
  if (recomputedHash !== tokenRecord.plan_snapshot_hash) {
    const errorCode = 'PLAN_MISMATCH';
    const errorMessage = 'capability plan snapshot hash changed after revalidation';
    notifyBridgeCapabilityExecuteResult(request, null, false, errorCode, errorMessage);
    return buildCapabilityResultBase(request, {
      token_id: token,
      capability: recomputedPlan.capability,
      action: recomputedPlan.action,
      plan_summary: tokenRecord.plan_summary || null,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
    });
  }

  let consumed;
  try {
    consumed = opsApprovalStore.consumeApproval({
      token,
      consumedBy: request.requested_by,
      consumedBotId: runtimeBotId,
      executionRequestId: request.request_id,
    });
  } catch (error) {
    const errorCode = String(error && error.code ? error.code : 'TOKEN_CONSUME_FAILED');
    const errorMessage = String(error && error.message ? error.message : error);
    notifyBridgeCapabilityExecuteResult(request, null, false, errorCode, errorMessage);
    return buildCapabilityResultBase(request, {
      token_id: token,
      capability: recomputedPlan.capability,
      action: recomputedPlan.action,
      plan_summary: tokenRecord.plan_summary || null,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
    });
  }

  const grantIssued = maybeIssueApprovalGrant(policy, request, token, consumed);
  const approvalGrant = grantIssued.issued
    ? grantIssued.record
    : null;

  const executed = executeCapabilityPlan(request, recomputedPlan, rebuilt.handler, policy);
  if (!executed.ok) {
    logExecutionResult(request, recomputedPlan, executed.details || executed, false);
    notifyBridgeCapabilityExecuteResult(request, {
      ...(executed.details || {}),
      approval_grant: approvalGrant,
    }, false, executed.error_code, executed.error);
    return buildCapabilityResultBase(request, {
      token_id: token,
      capability: recomputedPlan.capability,
      action: recomputedPlan.action,
      plan_summary: tokenRecord.plan_summary || null,
      executed_steps: executed.executed_steps,
      details: executed.details,
      ok: false,
      error_code: executed.error_code,
      error: executed.error,
    });
  }

  logExecutionResult(request, recomputedPlan, executed.details || executed, true);
  const planSummary = {
    ...(tokenRecord.plan_summary || {}),
    consumed_at: consumed ? consumed.consumed_at : null,
  };
  if (approvalGrant) {
    planSummary.approval_grant = approvalGrant;
  }
  notifyBridgeCapabilityExecuteResult(request, {
    capability: recomputedPlan.capability,
    action: recomputedPlan.action,
    ...(executed.details || {}),
    approval_grant: approvalGrant,
  }, true);
  return buildCapabilityResultBase(request, {
    token_id: token,
    capability: recomputedPlan.capability,
    action: recomputedPlan.action,
    risk_tier: recomputedPlan.risk_tier,
    requires_approval: true,
    plan_summary: planSummary,
    executed_steps: executed.executed_steps,
    details: executed.details,
    ok: true,
  });
}

function handlePlanPhase(request, policy) {
  const action = opsFileControl.normalizeIntentAction(request.intent_action);
  if (!action || !ALLOWED_FILE_CONTROL_ACTIONS.has(action)) {
    const errorCode = 'UNSUPPORTED_ACTION';
    const errorMessage = `unsupported action: ${request.intent_action || ''}`;
    notifyBridgePlanResult(request, null, null, false, errorCode, errorMessage);
    return buildFileControlResultBase(request, {
      ok: false,
      error_code: errorCode,
      error: errorMessage,
    });
  }

  const planResult = opsFileControl.computePlan({
    intentAction: action,
    payload: request.payload,
    requestedBy: request.requested_by,
    telegramContext: request.telegram_context || {},
    policy,
  });

  if (!planResult.ok || !planResult.plan) {
    const errorCode = String(planResult.error_code || 'PLAN_BUILD_FAILED');
    const errorMessage = String(planResult.error || 'plan build failed');
    notifyBridgePlanResult(request, null, null, false, errorCode, errorMessage);
    return buildFileControlResultBase(request, {
      ok: false,
      error_code: errorCode,
      error: errorMessage,
    });
  }

  const plan = planResult.plan;
  plan.requires_approval = Boolean(
    plan.requires_approval
    || (plan.mutating && Array.isArray(plan.required_flags) && plan.required_flags.length > 0),
  );
  if (!isUnifiedApprovalEnabled()) {
    plan.requires_approval = false;
    plan.required_flags = [];
  }
  const activeGrant = plan.requires_approval
    ? findActiveApprovalGrant(policy, request.requested_by, 'all')
    : { active: false, record: null };
  if (plan.requires_approval && activeGrant.active && activeGrant.record) {
    plan.requires_approval = false;
    plan.required_flags = [];
    plan.approval_grant = {
      grant_id: activeGrant.record.grant_id || null,
      scope: activeGrant.record.scope || 'all',
      expires_at: activeGrant.record.expires_at || null,
      source_token: activeGrant.record.source_token || null,
    };
  }

  logAutoExecuteDecision(request, {
    ...plan,
    action_type: 'file_control',
    capability: 'file_control',
    action: plan.intent_action,
  }, (plan.requires_approval && !plan.approval_grant) ? 'approval_required' : 'auto_execute');

  let approvalRecord = null;
  if (plan.requires_approval && !plan.approval_grant) {
    const snapshotHash = opsApprovalStore.hashPlanSnapshot(plan);
    approvalRecord = opsApprovalStore.createApprovalToken({
      requestedBy: request.requested_by,
      requestId: request.request_id,
      ttlPolicy: policy.ttlPolicy || {},
      requiredFlags: plan.required_flags || [],
      planSnapshotHash: snapshotHash,
      plan,
      planSummary: planSummaryObject(plan, null),
      actionType: 'file_control',
      riskLevel: plan.risk_tier || 'MEDIUM',
      botId: process.env.MOLTBOT_BOT_ID || '',
    });
  }

  notifyBridgePlanResult(request, plan, approvalRecord, true);
  if (plan.mutating && (!plan.requires_approval || plan.approval_grant) && !approvalRecord) {
    const execResult = opsFileControl.executePlan({
      plan,
      policy,
    });
    const executePayload = {
      ...(execResult || {}),
      approval_grant: plan.approval_grant,
    };
    const ok = Boolean(execResult && execResult.ok);
    if (!ok) {
      logExecutionResult(request, {
        ...plan,
        action_type: 'file_control',
        capability: 'file_control',
        action: plan.intent_action,
      }, execResult || {}, false);
      const errorCode = String(execResult && execResult.error_code ? execResult.error_code : 'EXECUTE_FAILED');
      const errorMessage = String(execResult && execResult.error ? execResult.error : 'execute failed');
      notifyBridgeExecuteResult(request, executePayload, false, errorCode, errorMessage);
      return buildFileControlResultBase(request, {
        token_id: null,
        ok: false,
        error_code: errorCode,
        error: errorMessage,
        plan_summary: planSummaryObject(plan, null),
        rollback_instructions: Array.isArray(plan.rollback_instructions) ? plan.rollback_instructions : [],
        executed_steps: Array.isArray(execResult && execResult.executed_steps) ? execResult.executed_steps : [],
        file_counts: (execResult && execResult.file_counts) || {},
        hashes: Array.isArray(execResult && execResult.hashes) ? execResult.hashes : [],
      });
    }
    logExecutionResult(request, {
      ...plan,
      action_type: 'file_control',
      capability: 'file_control',
      action: plan.intent_action,
    }, execResult || {}, true);
    notifyBridgeExecuteResult(request, executePayload, true);
    return buildFileControlResultBase(request, {
      token_id: null,
      ok: true,
      plan_summary: planSummaryObject(plan, null),
      rollback_instructions: Array.isArray(plan.rollback_instructions) ? plan.rollback_instructions : [],
      executed_steps: Array.isArray(execResult && execResult.executed_steps) ? execResult.executed_steps : [],
      file_counts: (execResult && execResult.file_counts) || {},
      hashes: Array.isArray(execResult && execResult.hashes) ? execResult.hashes : [],
    });
  }

  return buildFileControlResultBase(request, {
    token_id: approvalRecord ? approvalRecord.token : null,
    plan_summary: planSummaryObject(plan, approvalRecord),
    rollback_instructions: Array.isArray(plan.rollback_instructions) ? plan.rollback_instructions : [],
    ok: true,
  });
}

function handleExecutePhase(request, policy) {
  const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
  const token = String(payload.token || '').trim();
  const decision = String(payload.decision || 'approve').trim().toLowerCase() || 'approve';
  const providedFlags = opsFileControl.normalizeApprovalFlags(payload.approval_flags || payload.options || '');
  const runtimeBotId = String(process.env.MOLTBOT_BOT_ID || 'unknown').trim() || 'unknown';
  const actorRequestedBy = String(request && request.requested_by || 'unknown').trim() || 'unknown';

  if (decision === 'deny') {
    if (!botPermissionPolicy.canDeny(runtimeBotId)) {
      const errorCode = 'PERMISSION_DENIED';
      const errorMessage = `bot ${runtimeBotId} cannot deny approvals`;
      approvalAuditLog.append('approval_decision', {
        decision: 'permission_denied',
        token: token || null,
        request_id: String(request && request.request_id || ''),
        actor_requested_by: actorRequestedBy,
        actor_bot_id: runtimeBotId,
        token_owner_requested_by: null,
        token_owner_bot_id: null,
        error_code: errorCode,
        error: errorMessage,
      });
      notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
      return buildFileControlResultBase(request, {
        token_id: token || null,
        ok: false,
        error_code: errorCode,
        error: errorMessage,
      });
    }
    if (!token) {
      const errorCode = 'TOKEN_REQUIRED';
      const errorMessage = 'approval token is required for deny';
      notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
      return buildFileControlResultBase(request, {
        token_id: null,
        ok: false,
        error_code: errorCode,
        error: errorMessage,
      });
    }
    let denied;
    try {
      denied = opsApprovalStore.denyApproval({
        token,
        deniedBy: request.requested_by,
        deniedBotId: runtimeBotId,
        executionRequestId: request.request_id,
      });
    } catch (error) {
      const errorCode = String(error && error.code ? error.code : 'TOKEN_DENY_FAILED');
      const errorMessage = String(error && error.message ? error.message : error);
      notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
      return buildFileControlResultBase(request, {
        token_id: token || null,
        ok: false,
        error_code: errorCode,
        error: errorMessage,
      });
    }

    const deniedActionType = String(denied && denied.action_type || 'file_control');
    notifyBridgeExecuteResult(request, {
      ok: true,
      action: 'deny',
      telegramReply: [
        '[RESULT] approval denied',
        `- action_type: ${deniedActionType}`,
      ].join('\n'),
    }, true);
    const deniedPlan = (denied && denied.plan && typeof denied.plan === 'object') ? denied.plan : null;
    if (deniedPlan && String(deniedPlan.command_kind || '').trim().toLowerCase() === 'capability') {
      return buildCapabilityResultBase({
        ...request,
        command_kind: 'capability',
        capability: deniedPlan.capability || null,
        action: deniedPlan.action || null,
      }, {
        token_id: token,
        capability: deniedPlan.capability || null,
        action: deniedPlan.action || null,
        plan_summary: denied && denied.plan_summary ? denied.plan_summary : null,
        executed_steps: [],
        details: {
          action: 'deny',
          denied: true,
          denied_at: denied && denied.denied_at ? denied.denied_at : nowIso(),
        },
        ok: true,
      });
    }
    return buildFileControlResultBase(request, {
      token_id: token,
      ok: true,
      plan_summary: denied && denied.plan_summary ? denied.plan_summary : null,
      executed_steps: [],
      details: {
        action: 'deny',
        denied: true,
        denied_at: denied && denied.denied_at ? denied.denied_at : nowIso(),
      },
    });
  }

  if (!botPermissionPolicy.canApprove(runtimeBotId)) {
    const errorCode = 'PERMISSION_DENIED';
    const errorMessage = `bot ${runtimeBotId} cannot approve tokens`;
    approvalAuditLog.append('approval_decision', {
      decision: 'permission_denied',
      token: token || null,
      request_id: String(request && request.request_id || ''),
      actor_requested_by: actorRequestedBy,
      actor_bot_id: runtimeBotId,
      token_owner_requested_by: null,
      token_owner_bot_id: null,
      error_code: errorCode,
      error: errorMessage,
    });
    notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
    return buildFileControlResultBase(request, {
      token_id: token || null,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
    });
  }

  let validated;
  try {
    validated = opsApprovalStore.validateApproval({
      token,
      requestedBy: request.requested_by,
      botId: runtimeBotId,
      providedFlags,
    });
  } catch (error) {
    const errorCode = String(error && error.code ? error.code : 'TOKEN_VALIDATE_FAILED');
    const errorMessage = String(error && error.message ? error.message : error);
    notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
    return buildFileControlResultBase(request, {
      token_id: token || null,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
    });
  }

  const tokenRecord = validated.record || {};
  const planned = tokenRecord.plan;
  if (!planned || typeof planned !== 'object') {
    const errorCode = 'TOKEN_PLAN_MISSING';
    const errorMessage = 'approval token has no plan payload';
    notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
    return buildFileControlResultBase(request, {
      token_id: token,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
    });
  }

  if (String(planned.command_kind || '').trim().toLowerCase() === 'capability') {
    return handleCapabilityExecuteWithToken(request, policy, token, tokenRecord, planned);
  }

  const recompute = opsFileControl.computePlan({
    intentAction: planned.intent_action,
    payload: planned.payload || {},
    requestedBy: tokenRecord.requested_by || request.requested_by,
    telegramContext: request.telegram_context || {},
    policy,
  });
  if (!recompute.ok || !recompute.plan) {
    const errorCode = String(recompute.error_code || 'PLAN_RECOMPUTE_FAILED');
    const errorMessage = String(recompute.error || 'plan recompute failed');
    notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
    return buildFileControlResultBase(request, {
      token_id: token,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
      plan_summary: tokenRecord.plan_summary || null,
    });
  }

  const recomputedPlan = recompute.plan;
  const recomputedHash = opsApprovalStore.hashPlanSnapshot(recomputedPlan);
  if (recomputedHash !== tokenRecord.plan_snapshot_hash) {
    const errorCode = 'PLAN_MISMATCH';
    const errorMessage = 'plan snapshot hash changed after revalidation';
    notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
    return buildFileControlResultBase(request, {
      token_id: token,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
      plan_summary: tokenRecord.plan_summary || null,
      rollback_instructions: Array.isArray(recomputedPlan.rollback_instructions) ? recomputedPlan.rollback_instructions : [],
    });
  }

  let consumed;
  try {
    consumed = opsApprovalStore.consumeApproval({
      token,
      consumedBy: request.requested_by,
      consumedBotId: runtimeBotId,
      executionRequestId: request.request_id,
    });
  } catch (error) {
    const errorCode = String(error && error.code ? error.code : 'TOKEN_CONSUME_FAILED');
    const errorMessage = String(error && error.message ? error.message : error);
    notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
    return buildFileControlResultBase(request, {
      token_id: token,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
      plan_summary: tokenRecord.plan_summary || null,
    });
  }

  const grantIssued = maybeIssueApprovalGrant(policy, request, token, consumed);
  const approvalGrant = grantIssued.issued ? grantIssued.record : null;
  if (approvalGrant) {
    recomputedPlan.approval_grant = {
      grant_id: approvalGrant.grant_id || null,
      scope: approvalGrant.scope || 'all',
      expires_at: approvalGrant.expires_at || null,
      source_token: approvalGrant.source_token || token,
    };
  }

  const execResult = opsFileControl.executePlan({
    plan: recomputedPlan,
    policy,
  });
  const executePayload = {
    ...(execResult || {}),
    approval_grant: recomputedPlan.approval_grant || null,
  };

  const ok = Boolean(execResult && execResult.ok);
  if (!ok) {
    logExecutionResult(request, {
      ...recomputedPlan,
      action_type: 'file_control',
      capability: 'file_control',
      action: recomputedPlan.intent_action,
    }, execResult || {}, false);
    const errorCode = String(execResult && execResult.error_code ? execResult.error_code : 'EXECUTE_FAILED');
    const errorMessage = String(execResult && execResult.error ? execResult.error : 'execute failed');
    notifyBridgeExecuteResult(request, executePayload, false, errorCode, errorMessage);
    return buildFileControlResultBase(request, {
      token_id: token,
      ok: false,
      error_code: errorCode,
      error: errorMessage,
      plan_summary: tokenRecord.plan_summary || null,
      executed_steps: execResult.executed_steps || [],
      file_counts: execResult.file_counts || {},
      hashes: execResult.hashes || [],
      rollback_instructions: execResult.rollback_instructions || [],
    });
  }

  logExecutionResult(request, {
    ...recomputedPlan,
    action_type: 'file_control',
    capability: 'file_control',
    action: recomputedPlan.intent_action,
  }, execResult || {}, true);
  const planSummary = {
    ...(tokenRecord.plan_summary || {}),
    consumed_at: consumed ? consumed.consumed_at : null,
  };
  if (recomputedPlan.approval_grant) {
    planSummary.approval_grant = recomputedPlan.approval_grant;
  }
  notifyBridgeExecuteResult(request, executePayload, true);
  return buildFileControlResultBase(request, {
    token_id: token,
    ok: true,
    plan_summary: planSummary,
    executed_steps: execResult.executed_steps || [],
    file_counts: execResult.file_counts || {},
    hashes: execResult.hashes || [],
    rollback_instructions: execResult.rollback_instructions || [],
  });
}

function processFileControlClaim(claim, policy) {
  const request = normalizeFileControlRequest(claim && claim.payload ? claim.payload : {});
  let row;
  try {
    if (request.command_kind === 'capability' && request.phase === 'plan') {
      row = handleCapabilityPlanPhase(request, policy);
    } else if (request.phase === 'plan') {
      row = handlePlanPhase(request, policy);
    } else if (request.phase === 'execute') {
      row = handleExecutePhase(request, policy);
    } else {
      const errorCode = 'UNSUPPORTED_PHASE';
      const errorMessage = `unsupported phase: ${request.phase}`;
      notifyBridgeExecuteResult(request, null, false, errorCode, errorMessage);
      row = buildFileControlResultBase(request, {
        ok: false,
        error_code: errorCode,
        error: errorMessage,
      });
    }
  } catch (error) {
    const code = String(error && error.code ? error.code : 'UNHANDLED_WORKER_ERROR');
    const message = String(error && error.message ? error.message : error);
    row = request.command_kind === 'capability'
      ? buildCapabilityResultBase(request, {
          ok: false,
          error_code: code,
          error: message,
        })
      : buildFileControlResultBase(request, {
          ok: false,
          error_code: code,
          error: message,
        });
    if (request.phase === 'plan') {
      if (request.command_kind === 'capability') {
        notifyBridgeCapabilityPlanResult(request, null, null, false, code, message);
      } else {
        notifyBridgePlanResult(request, null, null, false, code, message);
      }
    } else {
      if (request.command_kind === 'capability') {
        notifyBridgeCapabilityExecuteResult(request, null, false, code, message);
      } else {
        notifyBridgeExecuteResult(request, null, false, code, message);
      }
    }
  }
  return opsCommandQueue.completeClaim(claim, row);
}

function processFileControlQueue() {
  const policy = resolveFileControlPolicy();
  let handled = 0;
  for (;;) {
    const claim = opsCommandQueue.claimNextCommand();
    if (!claim) break;
    processFileControlClaim(claim, policy);
    handled += 1;
  }
  return handled;
}

function processLegacyRestartQueue() {
  const processed = new Set(readJson(PROCESSED_PATH, []));
  const requests = readQueue();
  let handled = 0;

  for (const req of requests) {
    if (!req || !req.id || processed.has(req.id)) continue;
    const action = String(req.action || '').toLowerCase();
    const targets = Array.isArray(req.targets) ? req.targets : [];
    let result;

    if (action === 'restart' && targets.length) {
      const items = targets.map((container) => {
        const r = run('docker', ['restart', container]);
        return {
          container,
          ok: r.ok,
          code: r.code,
          stderr: r.stderr,
          error: r.error,
        };
      });
      result = {
        id: req.id,
        action,
        target: req.target || '',
        createdAt: req.createdAt || null,
        processedAt: nowIso(),
        ok: items.every((i) => i.ok),
        items,
      };
    } else {
      result = {
        id: req.id,
        action,
        target: req.target || '',
        createdAt: req.createdAt || null,
        processedAt: nowIso(),
        ok: false,
        error: 'unsupported request',
      };
    }

    appendResult(result);
    processed.add(req.id);
    handled += 1;
  }

  writeJson(PROCESSED_PATH, Array.from(processed));
  return handled;
}

function main() {
  ensureDir();
  opsCommandQueue.ensureLayout();
  opsApprovalStore.ensureLayout();
  const approvalsGc = opsApprovalStore.expirePendingTokens();
  opsApprovalStore.syncPendingApprovalsMirror();

  const sessionRotate = maybeRotateStaleMainSession();
  const handledLegacy = processLegacyRestartQueue();
  const handledFileControl = processFileControlQueue();
  const skillFeedback = maybeRunSkillFeedbackLoop();
  const snapshot = collectSnapshot();

  const out = {
    ok: true,
    handledLegacy,
    handledFileControl,
    handled: handledLegacy + handledFileControl,
    approvalsGc,
    sessionRotate,
    skillFeedback,
    snapshotUpdatedAt: snapshot.updatedAt,
    tunnelUrl: snapshot.tunnelUrl,
  };
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}

module.exports = {
  finalizeOpsTelegramReply,
  maybeRotateStaleMainSession,
};
