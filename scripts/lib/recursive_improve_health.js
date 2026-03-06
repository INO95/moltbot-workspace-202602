const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_REL_PATH = path.join('logs', 'midnight_recursive_improve_latest.json');
const DEFAULT_MAX_AGE_HOURS = 36;

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function parseFailureCode(errorText) {
  const raw = String(errorText || '').trim();
  if (!raw) return '';
  const idx = raw.indexOf(':');
  return idx >= 0 ? raw.slice(0, idx).trim() : raw;
}

function buildFailureNextAction(failureCode) {
  const code = String(failureCode || '').trim().toLowerCase();
  if (!code) return 'Inspect the midnight recursive improve report and retry once after the root cause is fixed.';

  if (code === 'gh_auth_failed') {
    return 'Verify GitHub CLI authentication for the automation worktree before the next scheduled run.';
  }
  if (code === 'allowlist_blocked') {
    return 'Review non-allowlisted file changes and keep the automation branch limited to the approved paths.';
  }
  if (code === 'stage1_failed') {
    return 'Fix the stage1 validation failure before allowing the midnight automation to proceed.';
  }
  if (code === 'stage2_failed') {
    return 'Fix the stage2 validation failure before allowing commit/push or PR update.';
  }
  if (
    code.startsWith('worktree_')
    || code.startsWith('preflight_')
    || code.startsWith('gitdir_')
    || code === 'git_rev_parse_failed'
  ) {
    return 'Repair or recreate the dedicated midnight automation worktree, then rerun the automation.';
  }
  if (code === 'routing_loop_failed') {
    return 'Inspect routing adaptive keyword generation and restore the routing loop before retrying.';
  }
  if (code === 'skill_feedback_failed') {
    return 'Inspect the skill feedback queue/apply flow and clear the failing feedback item before retrying.';
  }
  if (code === 'pr_upsert_failed') {
    return 'Verify GitHub connectivity and PR permissions for the automation branch.';
  }
  return 'Inspect the midnight recursive improve report and retry once after the root cause is fixed.';
}

function resolveLogPath(rootOrPath, options = {}) {
  const explicit = String(options.filePath || '').trim();
  if (explicit) return path.resolve(explicit);

  const raw = String(rootOrPath || '').trim();
  if (!raw) return path.resolve(DEFAULT_LOG_REL_PATH);
  if (raw.endsWith('.json')) return path.resolve(raw);
  return path.join(path.resolve(raw), DEFAULT_LOG_REL_PATH);
}

function summarizeRecursiveImproveReport(report, options = {}) {
  const payload = report && typeof report === 'object' ? report : {};
  const now = options.now ? new Date(options.now) : new Date();
  const maxAgeHours = Math.max(1, Number(options.maxAgeHours || DEFAULT_MAX_AGE_HOURS));
  const runAt = payload.runAt ? String(payload.runAt) : null;
  const runAtMs = Date.parse(String(runAt || ''));
  const ageMinutes = Number.isFinite(runAtMs)
    ? Math.max(0, Math.round((now.getTime() - runAtMs) / (60 * 1000)))
    : null;
  const fresh = ageMinutes != null ? ageMinutes <= (maxAgeHours * 60) : false;
  const error = String(payload.error || '').trim();
  const failureCode = parseFailureCode(error);
  const preflight = payload.preflight && typeof payload.preflight === 'object' ? payload.preflight : {};
  const delivery = payload.delivery && typeof payload.delivery === 'object' ? payload.delivery : {};
  const pr = payload.pr && typeof payload.pr === 'object' ? payload.pr : {};
  const consecutiveFailures = Math.max(
    0,
    Number.isFinite(Number(payload.consecutiveFailures))
      ? Number(payload.consecutiveFailures)
      : (payload.ok === false ? 1 : 0),
  );
  const preflightRepaired = preflight.repaired === true;
  const prUrl = String(delivery.prUrl || pr.url || '').trim();
  const ok = payload.ok === true;
  const briefingEligible = delivery.briefingEligible === true
    || Boolean(!ok || preflightRepaired || prUrl);
  const shouldEscalate = !ok && consecutiveFailures >= 2;

  let summaryLine = 'midnight recursive improve report unavailable';
  if (!fresh) {
    summaryLine = 'midnight recursive improve report is stale';
  } else if (ok) {
    summaryLine = `midnight recursive improve ok${preflightRepaired ? ' (worktree repaired)' : ''}${prUrl ? `, pr=${prUrl}` : ''}`;
  } else if (error) {
    summaryLine = `midnight recursive improve failed: ${failureCode || 'unknown'} (consecutive ${consecutiveFailures})`;
  } else {
    summaryLine = `midnight recursive improve failed (consecutive ${consecutiveFailures})`;
  }

  return {
    exists: true,
    ok,
    skipped: payload.skipped === true,
    runAt,
    ageMinutes,
    fresh,
    error,
    failureCode,
    nextAction: buildFailureNextAction(failureCode),
    preflightValid: preflight.valid !== false,
    preflightRepaired,
    prAttempted: delivery.prAttempted === true || pr.attempted === true,
    prUrl,
    briefingEligible,
    consecutiveFailures,
    shouldEscalate,
    summaryLine,
    report: payload,
  };
}

function readRecursiveImproveHealth(rootOrPath, options = {}) {
  const filePath = resolveLogPath(rootOrPath, options);
  const payload = safeReadJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      exists: false,
      ok: false,
      skipped: false,
      runAt: null,
      ageMinutes: null,
      fresh: false,
      error: 'report_missing',
      failureCode: 'report_missing',
      nextAction: 'Verify that the midnight recursive improve cron ran and wrote its latest report.',
      preflightValid: false,
      preflightRepaired: false,
      prAttempted: false,
      prUrl: '',
      briefingEligible: true,
      consecutiveFailures: 0,
      shouldEscalate: false,
      summaryLine: 'midnight recursive improve report missing',
      report: null,
      path: filePath,
    };
  }

  return {
    ...summarizeRecursiveImproveReport(payload, options),
    path: filePath,
  };
}

module.exports = {
  DEFAULT_LOG_REL_PATH,
  DEFAULT_MAX_AGE_HOURS,
  parseFailureCode,
  buildFailureNextAction,
  summarizeRecursiveImproveReport,
  readRecursiveImproveHealth,
};
