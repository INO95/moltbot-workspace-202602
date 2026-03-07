#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseFailureCode,
  buildFailureNextAction,
} = require('./lib/recursive_improve_health');

const ROOT = path.join(__dirname, '..');

const DEFAULT_ALLOWLIST = Object.freeze([
  'data/policy/routing_adaptive_keywords.json',
  'skills/moltbot/SKILL.md',
  'notes/PORTFOLIO_CONTENT_TEMPLATE.md',
  'data/config.json',
]);

const STAGE1_COMMANDS = Object.freeze([
  'node scripts/test_midnight_recursive_improve.js',
  'node scripts/test_bridge_nl_inference.js',
  'node scripts/test_bridge_natural_language_routing.js',
  'node scripts/test_skill_feedback_loop.js',
]);

const STAGE2_COMMANDS = Object.freeze([
  'node scripts/test_bridge_report_default_by_runtime.js',
  'node scripts/test_no_prefix_routing_report.js',
]);

const DEFAULTS = Object.freeze({
  branch: 'codex/nightly-recursive-improve',
  worktree: '.worktrees/nightly-recursive-improve',
  baseBranch: 'origin/main',
  maxIterations: 3,
  dryRun: false,
  lockStaleMinutes: 360,
  skillFeedbackLimit: 120,
  windowDays: 7,
  minEvidenceCount: 5,
  maxAdditionsPerIntent: 2,
  timezone: 'Asia/Tokyo',
});

const MANAGED_WORKTREE_RELATIVE_PATHS = Object.freeze([
  DEFAULTS.worktree,
  '.tmp/nightly-recursive-worktree',
]);

function nowIso(nowFn = () => new Date()) {
  return nowFn().toISOString();
}

function parseBool(raw, fallback = false) {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveUnderRoot(rootPath, targetPath) {
  if (path.isAbsolute(targetPath)) return targetPath;
  return path.join(rootPath, targetPath);
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function writeText(filePath, text) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, text, 'utf8');
}

function runProcess(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeoutMs || 15 * 60 * 1000,
    shell: Boolean(options.shell),
  });
  return {
    ok: !res.error && res.status === 0,
    code: Number.isInteger(res.status) ? res.status : 1,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function runShell(command, options = {}) {
  return runProcess(command, [], { ...options, shell: true });
}

function extractJsonPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  const candidate = raw.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch (_) {
    return null;
  }
}

function posixify(relPath) {
  return String(relPath || '').replace(/\\/g, '/');
}

function parseStatusPaths(statusText) {
  const out = [];
  const lines = String(statusText || '').split('\n').map((line) => line.trimEnd()).filter(Boolean);
  for (const rawLine of lines) {
    const line = rawLine;
    if (line.length < 4) continue;
    const body = line.slice(3).trim();
    if (!body) continue;
    if (body.includes(' -> ')) {
      const parts = body.split(' -> ');
      out.push(posixify(parts[parts.length - 1]));
    } else {
      out.push(posixify(body));
    }
  }
  return out;
}

function normalizeBaseRef(baseBranchRaw) {
  const raw = String(baseBranchRaw || '').trim();
  if (!raw) return 'main';
  if (raw.startsWith('origin/')) return raw.slice('origin/'.length) || 'main';
  if (raw.startsWith('refs/heads/')) return raw.slice('refs/heads/'.length) || 'main';
  return raw;
}

function collectPendingIds(rows) {
  const set = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (String(row.status || '') !== 'pending_approval') continue;
    const id = String(row.id || '').trim();
    if (id) set.add(id);
  }
  return set;
}

function collectNewPendingIds(beforeRows, afterRows) {
  const before = collectPendingIds(beforeRows);
  const out = [];
  for (const row of Array.isArray(afterRows) ? afterRows : []) {
    if (!row || typeof row !== 'object') continue;
    if (String(row.status || '') !== 'pending_approval') continue;
    const id = String(row.id || '').trim();
    if (!id) continue;
    if (!before.has(id)) out.push(id);
  }
  return out;
}

function buildConfig(env = process.env, root = ROOT) {
  const mainWorkspace = resolveUnderRoot(root, String(env.MIDNIGHT_RECURSIVE_MAIN_WORKSPACE || root));
  const worktreeRaw = String(env.MIDNIGHT_RECURSIVE_WORKTREE || DEFAULTS.worktree).trim() || DEFAULTS.worktree;
  const worktreePath = path.isAbsolute(worktreeRaw) ? worktreeRaw : path.join(mainWorkspace, worktreeRaw);

  return {
    root,
    mainWorkspace,
    worktreePath,
    branch: String(env.MIDNIGHT_RECURSIVE_BRANCH || DEFAULTS.branch).trim() || DEFAULTS.branch,
    baseBranch: String(env.MIDNIGHT_RECURSIVE_BASE_BRANCH || DEFAULTS.baseBranch).trim() || DEFAULTS.baseBranch,
    baseRef: normalizeBaseRef(String(env.MIDNIGHT_RECURSIVE_BASE_BRANCH || DEFAULTS.baseBranch)),
    maxIterations: parsePositiveInt(env.MIDNIGHT_RECURSIVE_MAX_ITERATIONS, DEFAULTS.maxIterations),
    dryRun: parseBool(env.MIDNIGHT_RECURSIVE_DRY_RUN, DEFAULTS.dryRun),
    lockPath: path.join(mainWorkspace, 'data', 'runtime', 'midnight_recursive_improve_lock.json'),
    statePath: path.join(mainWorkspace, 'data', 'runtime', 'midnight_recursive_improve_state.json'),
    reportPath: path.join(mainWorkspace, 'logs', 'midnight_recursive_improve_latest.json'),
    allowlist: DEFAULT_ALLOWLIST.slice(),
    stage1Commands: STAGE1_COMMANDS.slice(),
    stage2Commands: STAGE2_COMMANDS.slice(),
    lockStaleMinutes: parsePositiveInt(env.MIDNIGHT_RECURSIVE_LOCK_STALE_MINUTES, DEFAULTS.lockStaleMinutes),
    skillFeedbackLimit: parsePositiveInt(env.MIDNIGHT_RECURSIVE_SKILL_FEEDBACK_LIMIT, DEFAULTS.skillFeedbackLimit),
    routingWindowDays: parsePositiveInt(env.MIDNIGHT_RECURSIVE_WINDOW_DAYS, DEFAULTS.windowDays),
    routingMinEvidence: parsePositiveInt(env.MIDNIGHT_RECURSIVE_MIN_EVIDENCE_COUNT, DEFAULTS.minEvidenceCount),
    routingMaxAdditions: parsePositiveInt(env.MIDNIGHT_RECURSIVE_MAX_ADDITIONS_PER_INTENT, DEFAULTS.maxAdditionsPerIntent),
    timezone: String(env.MIDNIGHT_RECURSIVE_TIMEZONE || DEFAULTS.timezone).trim() || DEFAULTS.timezone,
  };
}

function getDateKeyInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

function acquireLock(config, nowFn = () => new Date()) {
  const staleMs = Math.max(1, Number(config.lockStaleMinutes || DEFAULTS.lockStaleMinutes)) * 60 * 1000;
  ensureDir(config.lockPath);

  const tryAcquire = () => {
    try {
      const fd = fs.openSync(config.lockPath, 'wx');
      const payload = {
        pid: process.pid,
        acquiredAt: nowIso(nowFn),
      };
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.closeSync(fd);
      return {
        acquired: true,
        lockPath: config.lockPath,
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }
      return {
        acquired: false,
        lockPath: config.lockPath,
        reason: 'already_locked',
      };
    }
  };

  let lock = tryAcquire();
  if (lock.acquired) return lock;

  let stale = false;
  try {
    const stat = fs.statSync(config.lockPath);
    const ageMs = Date.now() - Number(stat.mtimeMs || 0);
    stale = Number.isFinite(ageMs) && ageMs > staleMs;
  } catch (_) {
    stale = true;
  }

  if (stale) {
    try {
      fs.unlinkSync(config.lockPath);
    } catch (_) {
      // no-op: retried below
    }
    lock = tryAcquire();
    if (lock.acquired) return { ...lock, staleReplaced: true };
    return { ...lock, reason: 'lock_busy_after_stale_replace' };
  }

  return lock;
}

function releaseLock(lockPath) {
  if (!lockPath) return;
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch (_) {
    // lock cleanup failure should not crash the run
  }
}

function parseGitdirReference(gitFilePath) {
  try {
    if (!fs.existsSync(gitFilePath)) return '';
    const raw = fs.readFileSync(gitFilePath, 'utf8');
    const match = raw.match(/gitdir:\s*(.+)\s*$/im);
    if (!match) return '';
    const candidate = String(match[1] || '').trim();
    if (!candidate) return '';
    return path.isAbsolute(candidate)
      ? path.normalize(candidate)
      : path.normalize(path.resolve(path.dirname(gitFilePath), candidate));
  } catch (_) {
    return '';
  }
}

function canonicalizePath(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  try {
    return path.normalize(fs.realpathSync.native(resolved));
  } catch (_) {
    const parent = path.dirname(resolved);
    if (parent && parent !== resolved) {
      return path.join(canonicalizePath(parent), path.basename(resolved));
    }
    return path.normalize(resolved);
  }
}

function isWithinRoot(targetPath, rootPath) {
  const rel = path.relative(rootPath, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveManagedWorktreePaths(config) {
  return MANAGED_WORKTREE_RELATIVE_PATHS
    .map((relPath) => canonicalizePath(path.join(config.mainWorkspace, relPath)));
}

function isManagedAutomationWorktreePath(config, targetPath = config.worktreePath) {
  const workspacePath = canonicalizePath(config.mainWorkspace);
  const candidatePath = canonicalizePath(targetPath);
  if (!isWithinRoot(candidatePath, workspacePath)) return false;
  return resolveManagedWorktreePaths(config).includes(candidatePath);
}

function parseRegisteredWorktreeEntries(stdout) {
  const entries = [];
  let current = null;
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        worktreePath: canonicalizePath(line.slice('worktree '.length).trim()),
        branchRef: '',
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('branch ')) {
      current.branchRef = line.slice('branch '.length).trim();
    }
  }
  if (current) entries.push(current);
  return entries;
}

function listRegisteredWorktrees(mainWorkspace) {
  const res = runProcess('git', ['worktree', 'list', '--porcelain'], { cwd: mainWorkspace });
  if (!res.ok) {
    return {
      ok: false,
      worktreePaths: [],
      entries: [],
      error: res.stderr || res.error || res.stdout || `exit:${res.code}`,
    };
  }

  const entries = parseRegisteredWorktreeEntries(res.stdout);
  const worktreePaths = entries.map((entry) => entry.worktreePath);
  return { ok: true, worktreePaths, entries, error: '' };
}

function findManagedBranchConflict(config, registry = listRegisteredWorktrees(config.mainWorkspace)) {
  if (!registry || registry.ok !== true) {
    return {
      ok: false,
      conflictPath: '',
      branchRef: `refs/heads/${config.branch}`,
    };
  }

  const targetPath = canonicalizePath(config.worktreePath);
  const branchRef = `refs/heads/${config.branch}`;
  const entries = Array.isArray(registry.entries) ? registry.entries : [];
  const conflict = entries.find((entry) => (
    entry
    && entry.branchRef === branchRef
    && entry.worktreePath !== targetPath
    && isManagedAutomationWorktreePath(config, entry.worktreePath)
  ));

  return {
    ok: true,
    conflictPath: conflict ? conflict.worktreePath : '',
    branchRef,
  };
}

function inspectWorktreePreflight(config) {
  const worktreePath = canonicalizePath(config.worktreePath);
  const out = {
    worktreePath,
    valid: true,
    gitdirPath: '',
    registered: false,
    repaired: false,
    repairAction: 'none',
    reason: 'clean_absent',
  };

  const registry = listRegisteredWorktrees(config.mainWorkspace);
  if (!registry.ok) {
    return {
      ...out,
      valid: false,
      reason: 'preflight_worktree_list_failed',
    };
  }
  out.registered = registry.worktreePaths.includes(worktreePath);

  if (!fs.existsSync(worktreePath)) {
    out.reason = out.registered ? 'registered_path_missing' : 'clean_absent';
    out.valid = !out.registered;
    return out;
  }

  const gitFilePath = path.join(worktreePath, '.git');
  const gitStat = fs.existsSync(gitFilePath) ? fs.statSync(gitFilePath) : null;
  if (!gitStat) {
    return {
      ...out,
      valid: false,
      reason: 'preflight_git_metadata_missing',
    };
  }

  if (gitStat.isFile()) {
    out.gitdirPath = parseGitdirReference(gitFilePath);
    if (!out.gitdirPath) {
      return {
        ...out,
        valid: false,
        reason: 'preflight_gitdir_unparseable',
      };
    }
    if (!fs.existsSync(out.gitdirPath)) {
      return {
        ...out,
        valid: false,
        reason: 'gitdir_missing',
      };
    }
    const expectedRoot = canonicalizePath(path.join(config.mainWorkspace, '.git', 'worktrees'));
    if (!out.gitdirPath.startsWith(expectedRoot)) {
      return {
        ...out,
        valid: false,
        reason: 'gitdir_workspace_mismatch',
      };
    }
  } else if (!gitStat.isDirectory()) {
    return {
      ...out,
      valid: false,
      reason: 'preflight_git_metadata_invalid',
    };
  }

  if (!out.registered) {
    return {
      ...out,
      valid: false,
      reason: 'preflight_worktree_not_registered',
    };
  }

  const gitCheck = runProcess('git', ['-C', worktreePath, 'rev-parse', '--is-inside-work-tree'], {
    cwd: config.mainWorkspace,
  });
  if (!gitCheck.ok) {
    return {
      ...out,
      valid: false,
      reason: 'git_rev_parse_failed',
    };
  }

  return {
    ...out,
    valid: true,
    reason: 'ok',
  };
}

function repairWorktree(config, preflight = {}) {
  const worktreePath = canonicalizePath(config.worktreePath);
  const registered = preflight.registered === true;
  const gitdirPath = preflight.gitdirPath ? canonicalizePath(preflight.gitdirPath) : '';
  const repairAllowed = isManagedAutomationWorktreePath(config, worktreePath);
  let repairAction = 'none';
  const steps = [];

  if (!repairAllowed) {
    return {
      repaired: false,
      repairAllowed: false,
      repairAction: 'blocked_unmanaged_worktree',
      repairSteps: [{
        step: 'guard_managed_worktree',
        ok: false,
        detail: worktreePath,
      }],
    };
  }

  if (registered) {
    const remove = runProcess('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: config.mainWorkspace,
    });
    steps.push({
      step: 'git_worktree_remove',
      ok: remove.ok,
      detail: remove.stderr || remove.error || remove.stdout || '',
    });
    if (remove.ok) repairAction = 'remove_registered_worktree';
  }

  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    steps.push({ step: 'rm_worktree_path', ok: true, detail: worktreePath });
    if (repairAction === 'none') repairAction = 'remove_broken_worktree_path';
  }

  if (gitdirPath && fs.existsSync(gitdirPath)) {
    const gitdirRoot = canonicalizePath(path.join(config.mainWorkspace, '.git', 'worktrees'));
    if (gitdirPath.startsWith(gitdirRoot)) {
      fs.rmSync(gitdirPath, { recursive: true, force: true });
      steps.push({ step: 'rm_gitdir_path', ok: true, detail: gitdirPath });
      if (repairAction === 'none') repairAction = 'remove_stale_gitdir';
    }
  }

  const branchConflict = findManagedBranchConflict(config);
  if (branchConflict.ok && branchConflict.conflictPath) {
    const removeConflict = runProcess('git', ['worktree', 'remove', '--force', branchConflict.conflictPath], {
      cwd: config.mainWorkspace,
    });
    steps.push({
      step: 'git_worktree_remove_conflicting_branch',
      ok: removeConflict.ok,
      detail: branchConflict.conflictPath,
    });
    if (removeConflict.ok && repairAction === 'none') {
      repairAction = 'remove_conflicting_branch_worktree';
    }
  }

  const prune = runProcess('git', ['worktree', 'prune'], { cwd: config.mainWorkspace });
  steps.push({
    step: 'git_worktree_prune',
    ok: prune.ok,
    detail: prune.stderr || prune.error || prune.stdout || '',
  });
  if (!prune.ok && repairAction === 'none') {
    repairAction = 'prune_failed';
  } else if (prune.ok && repairAction === 'none') {
    repairAction = 'prune_only';
  }

  return {
    repaired: true,
    repairAllowed: true,
    repairAction,
    repairSteps: steps,
  };
}

function isRecoverableWorktreeError(error) {
  const raw = String(error && error.message ? error.message : error || '').trim().toLowerCase();
  if (!raw) return false;
  return (
    raw.startsWith('worktree_')
    || raw.startsWith('preflight_')
    || raw.startsWith('gitdir_')
    || raw === 'git_rev_parse_failed'
    || raw.includes('worktree_path_not_git')
  );
}

function ensureWorktree(config) {
  fs.mkdirSync(path.dirname(config.worktreePath), { recursive: true });

  const branchExists = runProcess('git', ['show-ref', '--verify', '--quiet', `refs/heads/${config.branch}`], {
    cwd: config.mainWorkspace,
  }).ok;

  if (!fs.existsSync(config.worktreePath)) {
    const addArgs = branchExists
      ? ['worktree', 'add', config.worktreePath, config.branch]
      : ['worktree', 'add', '-b', config.branch, config.worktreePath, config.baseBranch];
    const add = runProcess('git', addArgs, { cwd: config.mainWorkspace });
    if (!add.ok) {
      throw new Error(`worktree_add_failed: ${add.stderr || add.error || add.stdout || add.code}`);
    }
  } else {
    const check = runProcess('git', ['-C', config.worktreePath, 'rev-parse', '--is-inside-work-tree'], {
      cwd: config.mainWorkspace,
    });
    if (!check.ok) {
      throw new Error(`worktree_path_not_git: ${config.worktreePath}`);
    }
  }

  const checkout = runProcess('git', ['-C', config.worktreePath, 'checkout', config.branch], {
    cwd: config.mainWorkspace,
  });
  if (!checkout.ok) {
    throw new Error(`worktree_checkout_failed: ${checkout.stderr || checkout.error || checkout.stdout || checkout.code}`);
  }

  // Dedicated automation worktree: always start from clean branch state.
  const hardReset = runProcess('git', ['-C', config.worktreePath, 'reset', '--hard'], { cwd: config.mainWorkspace });
  if (!hardReset.ok) {
    throw new Error(`worktree_reset_failed: ${hardReset.stderr || hardReset.error || hardReset.stdout || hardReset.code}`);
  }
  runProcess('git', ['-C', config.worktreePath, 'clean', '-fd'], { cwd: config.mainWorkspace });
}

function runRoutingLoopOnce(config) {
  const policyPath = path.join(config.worktreePath, 'data', 'policy', 'routing_adaptive_keywords.json');
  const routingJsonPath = path.join(config.worktreePath, 'logs', 'reports', 'routing_recursive_loop_latest.json');
  const routingMdPath = path.join(config.worktreePath, 'logs', 'reports', 'routing_recursive_loop_latest.md');
  const inputPath = path.join(config.mainWorkspace, 'data', 'conversation', 'staging.jsonl');
  const routingScriptPath = path.join(config.mainWorkspace, 'scripts', 'routing_recursive_loop.js');

  const args = [
    routingScriptPath,
    '--input', inputPath,
    '--policy', policyPath,
    '--report-json', routingJsonPath,
    '--report-md', routingMdPath,
    '--window-days', String(config.routingWindowDays),
    '--min-evidence-count', String(config.routingMinEvidence),
    '--max-additions-per-intent', String(config.routingMaxAdditions),
    '--no-validate',
  ];
  const res = runProcess('node', args, { cwd: config.worktreePath, timeoutMs: 10 * 60 * 1000 });
  const payload = extractJsonPayload(res.stdout) || extractJsonPayload(res.stderr) || {};
  return {
    ...res,
    payload,
    totalAdded: Number(payload.totalAdded || 0),
  };
}

function ensureSeedQueueFile(mainQueuePath, queuePath) {
  ensureDir(queuePath);
  if (fs.existsSync(mainQueuePath)) {
    fs.copyFileSync(mainQueuePath, queuePath);
    return;
  }
  writeText(queuePath, '');
}

function runSkillFeedbackLoopOnce(config, queuePath, previewPath) {
  const skillFeedbackLoopPath = path.join(config.mainWorkspace, 'scripts', 'skill_feedback_loop.js');
  const skillFeedbackApplyPath = path.join(config.mainWorkspace, 'scripts', 'skill_feedback_apply.js');
  const env = {
    CONVERSATION_STAGING_PATH: path.join(config.mainWorkspace, 'data', 'conversation', 'staging.jsonl'),
    BRIDGE_INBOX_LOG_PATH: path.join(config.mainWorkspace, 'data', 'bridge', 'inbox.jsonl'),
    SKILL_FEEDBACK_QUEUE_PATH: queuePath,
    SKILL_PATCH_PREVIEW_PATH: previewPath,
  };
  const beforeRows = readJsonl(queuePath);
  const run = runProcess(
    'node',
    [skillFeedbackLoopPath, '--limit', String(config.skillFeedbackLimit)],
    { cwd: config.worktreePath, env, timeoutMs: 10 * 60 * 1000 },
  );
  const afterRows = readJsonl(queuePath);
  const newPendingIds = collectNewPendingIds(beforeRows, afterRows);

  const appliedIds = [];
  const applyResults = [];
  for (const id of newPendingIds) {
    const apply = runProcess(
      'node',
      [skillFeedbackApplyPath, 'apply', '--id', id],
      { cwd: config.worktreePath, env: { SKILL_FEEDBACK_QUEUE_PATH: queuePath }, timeoutMs: 10 * 60 * 1000 },
    );
    const payload = extractJsonPayload(apply.stdout) || extractJsonPayload(apply.stderr) || {};
    const appliedCount = Number(payload.applied || 0);
    if (apply.ok && appliedCount > 0) appliedIds.push(id);
    applyResults.push({
      id,
      ok: apply.ok,
      code: apply.code,
      applied: appliedCount,
      stderr: String(apply.stderr || '').slice(0, 600),
    });
    if (!apply.ok) {
      return {
        ok: false,
        code: apply.code,
        newPendingIds,
        appliedIds,
        applyResults,
        stderr: apply.stderr,
      };
    }
  }

  return {
    ok: run.ok,
    code: run.code,
    stderr: run.stderr,
    payload: extractJsonPayload(run.stdout) || extractJsonPayload(run.stderr) || {},
    newPendingIds,
    appliedIds,
    applyResults,
  };
}

function runCommandsStage(stageName, commands, cwd) {
  const rows = [];
  for (const command of commands) {
    const res = runShell(command, { cwd, timeoutMs: 20 * 60 * 1000 });
    rows.push({
      command,
      ok: res.ok,
      code: res.code,
      stderr: String(res.stderr || '').slice(0, 1000),
    });
    if (!res.ok) {
      return {
        stage: stageName,
        ok: false,
        failedCommand: command,
        rows,
      };
    }
  }
  return {
    stage: stageName,
    ok: true,
    failedCommand: '',
    rows,
  };
}

function uniq(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).map((item) => posixify(item).trim()).filter(Boolean)));
}

function diffDisallowed(paths, allowlist) {
  const allowed = new Set(uniq(allowlist));
  return uniq(paths).filter((item) => !allowed.has(item));
}

function stageAllowedChanges(config) {
  const beforeStatus = runProcess('git', ['-C', config.worktreePath, 'status', '--porcelain']);
  if (!beforeStatus.ok) {
    throw new Error(`git_status_failed: ${beforeStatus.stderr || beforeStatus.error || beforeStatus.stdout || beforeStatus.code}`);
  }
  const changedPaths = parseStatusPaths(beforeStatus.stdout);
  const disallowedBefore = diffDisallowed(changedPaths, config.allowlist);
  if (disallowedBefore.length > 0) {
    return {
      ok: false,
      reason: 'disallowed_working_changes',
      changedPaths,
      disallowedPaths: disallowedBefore,
      stagedPaths: [],
    };
  }

  runProcess('git', ['-C', config.worktreePath, 'reset']);
  for (const relPath of config.allowlist) {
    const absPath = path.join(config.worktreePath, relPath);
    const args = relPath === 'data/policy/routing_adaptive_keywords.json'
      ? ['-C', config.worktreePath, 'add', '-f', '-A', '--', relPath]
      : ['-C', config.worktreePath, 'add', '-A', '--', relPath];
    if (fs.existsSync(absPath) || relPath === 'data/policy/routing_adaptive_keywords.json') {
      runProcess('git', args);
    }
  }

  const staged = runProcess('git', ['-C', config.worktreePath, 'diff', '--cached', '--name-only']);
  if (!staged.ok) {
    throw new Error(`git_diff_cached_failed: ${staged.stderr || staged.error || staged.stdout || staged.code}`);
  }
  const stagedPaths = uniq(String(staged.stdout || '').split('\n'));
  const disallowedStaged = diffDisallowed(stagedPaths, config.allowlist);
  if (disallowedStaged.length > 0) {
    return {
      ok: false,
      reason: 'disallowed_staged_changes',
      changedPaths,
      disallowedPaths: disallowedStaged,
      stagedPaths,
    };
  }

  return {
    ok: true,
    reason: stagedPaths.length > 0 ? 'staged' : 'no_changes',
    changedPaths,
    disallowedPaths: [],
    stagedPaths,
  };
}

function buildCommitMessage(config, now = new Date()) {
  const dateKey = getDateKeyInZone(now, config.timezone);
  return `chore(recursive): midnight self-improve ${dateKey}`;
}

function ensureGhAuth(cwd) {
  return runProcess('gh', ['auth', 'status'], { cwd, timeoutMs: 60 * 1000 });
}

function readOpenPullRequest(cwd, branch, baseRef) {
  const res = runProcess(
    'gh',
    ['pr', 'list', '--state', 'open', '--head', branch, '--base', baseRef, '--json', 'number,url,title'],
    { cwd, timeoutMs: 60 * 1000 },
  );
  if (!res.ok) return { ok: false, rows: [], raw: res };
  const payload = extractJsonPayload(res.stdout);
  const rows = Array.isArray(payload) ? payload : [];
  return { ok: true, rows, raw: res };
}

function buildPullRequestTitle(report) {
  const date = String(report.runAt || '').slice(0, 10);
  const suffix = report.ok ? 'ok' : 'failed';
  return `chore(recursive): midnight self-improve ${date} (${suffix})`;
}

function buildPullRequestBody(config, report) {
  const failureCode = parseFailureCode(report.error || '');
  const lines = [];
  lines.push('# Midnight Recursive Improve');
  lines.push('');
  lines.push(`- runAt: ${report.runAt}`);
  lines.push(`- ok: ${report.ok}`);
  lines.push(`- iterations: ${report.iterations.length}`);
  lines.push(`- routingAdded: ${report.routingAdded}`);
  lines.push(`- skillApplied: ${report.skillApplied}`);
  lines.push(`- dryRun: ${config.dryRun}`);
  lines.push(`- logPath: ${path.relative(config.mainWorkspace, config.reportPath)}`);
  lines.push(`- consecutiveFailures: ${report.consecutiveFailures || 0}`);
  if (report.error) lines.push(`- error: ${report.error}`);
  lines.push('');
  lines.push('## Automation Status');
  lines.push(`- preflight: valid=${report.preflight && report.preflight.valid === true}, registered=${report.preflight && report.preflight.registered === true}, repaired=${report.preflight && report.preflight.repaired === true}`);
  lines.push(`- repairAction: ${report.preflight && report.preflight.repairAction ? report.preflight.repairAction : 'none'}`);
  lines.push(`- retry: attempted=${report.retry && report.retry.attempted === true}, succeeded=${report.retry && report.retry.succeeded === true}, reason=${report.retry && report.retry.reason ? report.retry.reason : '-'}`);
  lines.push(`- delivery: prAttempted=${report.delivery && report.delivery.prAttempted === true}, prUrl=${report.delivery && report.delivery.prUrl ? report.delivery.prUrl : '-'}`);
  if (failureCode) {
    lines.push(`- nextAction: ${buildFailureNextAction(failureCode)}`);
  }
  lines.push('');
  lines.push('## Test Gates');
  for (const stage of report.tests) {
    lines.push(`- ${stage.stage}: ${stage.ok ? 'pass' : `fail (${stage.failedCommand || 'unknown'})`}`);
  }
  lines.push('');
  lines.push('## Iteration Detail');
  for (const row of report.iterations) {
    lines.push(`- #${row.index}: routingAdded=${row.routingAdded}, newPending=${row.newPending}, applied=${row.applied}`);
  }
  return `${lines.join('\n')}\n`;
}

function upsertPullRequest(config, report) {
  const open = readOpenPullRequest(config.worktreePath, config.branch, config.baseRef);
  if (!open.ok) {
    return {
      ok: false,
      action: 'list_failed',
      number: null,
      url: '',
      error: open.raw.stderr || open.raw.error || open.raw.stdout || 'pr_list_failed',
    };
  }

  const title = buildPullRequestTitle(report);
  const body = buildPullRequestBody(config, report);
  const existing = open.rows[0] || null;

  if (config.dryRun) {
    return {
      ok: true,
      action: existing ? 'edit_dry_run' : 'create_dry_run',
      number: existing ? Number(existing.number || 0) : null,
      url: existing ? String(existing.url || '') : '',
      title,
    };
  }

  if (existing) {
    const edit = runProcess(
      'gh',
      ['pr', 'edit', String(existing.number), '--title', title, '--body', body],
      { cwd: config.worktreePath, timeoutMs: 60 * 1000 },
    );
    if (!edit.ok) {
      return {
        ok: false,
        action: 'edit_failed',
        number: Number(existing.number || 0),
        url: String(existing.url || ''),
        error: edit.stderr || edit.error || edit.stdout || 'pr_edit_failed',
      };
    }
    return {
      ok: true,
      action: 'edited',
      number: Number(existing.number || 0),
      url: String(existing.url || ''),
      title,
    };
  }

  const create = runProcess(
    'gh',
    ['pr', 'create', '--base', config.baseRef, '--head', config.branch, '--title', title, '--body', body],
    { cwd: config.worktreePath, timeoutMs: 60 * 1000 },
  );
  if (!create.ok) {
    return {
      ok: false,
      action: 'create_failed',
      number: null,
      url: '',
      error: create.stderr || create.error || create.stdout || 'pr_create_failed',
    };
  }

  const refreshed = readOpenPullRequest(config.worktreePath, config.branch, config.baseRef);
  const created = refreshed.ok ? (refreshed.rows[0] || null) : null;
  return {
    ok: true,
    action: 'created',
    number: created ? Number(created.number || 0) : null,
    url: created ? String(created.url || '').trim() : '',
    title,
  };
}

function computeBriefingEligible(report) {
  if (!report || typeof report !== 'object') return false;
  if (report.ok !== true) return true;
  if (report.preflight && report.preflight.repaired === true) return true;
  if (report.pr && report.pr.attempted === true) return true;
  if (report.retry && report.retry.attempted === true) return true;
  return false;
}

function updateDelivery(report) {
  if (!report || typeof report !== 'object') return report;
  report.delivery = report.delivery || {};
  report.delivery.prAttempted = Boolean(report.pr && report.pr.attempted === true);
  report.delivery.prUrl = String((report.pr && report.pr.url) || '').trim();
  report.delivery.briefingEligible = computeBriefingEligible(report);
  return report;
}

function persistReport(config, d, report, previousState = {}) {
  const prior = previousState && typeof previousState === 'object' ? previousState : {};
  if (report.skipped) {
    report.consecutiveFailures = Math.max(0, Number(prior.consecutiveFailures || 0));
  } else if (report.ok) {
    report.consecutiveFailures = 0;
  } else {
    report.consecutiveFailures = Math.max(1, Number(prior.consecutiveFailures || 0) + 1);
  }

  updateDelivery(report);

  if (!report.skipped) {
    d.writeJson(config.statePath, {
      schema_version: '1.0',
      updatedAt: report.runAt,
      lastRunAt: report.runAt,
      lastResultOk: report.ok === true,
      lastError: String(report.error || ''),
      lastFailureCode: parseFailureCode(report.error || ''),
      consecutiveFailures: report.consecutiveFailures,
      preflightRepaired: Boolean(report.preflight && report.preflight.repaired === true),
      prUrl: String((report.delivery && report.delivery.prUrl) || ''),
    });
  }

  d.writeJson(config.reportPath, report);
  return report;
}

function executeMidnightRecursivePass(config, d, report, queuePath, previewPath) {
  d.ensureWorktree(config);
  d.ensureSeedQueueFile(path.join(config.mainWorkspace, 'data', 'skill', 'feedback_queue.jsonl'), queuePath);

  for (let index = 1; index <= config.maxIterations; index += 1) {
    const routing = d.runRoutingLoopOnce(config);
    if (!routing.ok) {
      throw new Error(`routing_loop_failed: ${routing.stderr || routing.error || routing.stdout || routing.code}`);
    }

    const skill = d.runSkillFeedbackLoopOnce(config, queuePath, previewPath);
    if (!skill.ok) {
      throw new Error(`skill_feedback_failed: ${skill.stderr || skill.code}`);
    }

    const iterationRow = {
      index,
      routingAdded: routing.totalAdded,
      newPending: skill.newPendingIds.length,
      applied: skill.appliedIds.length,
    };
    report.iterations.push(iterationRow);
    report.routingAdded += routing.totalAdded;
    report.skillApplied += skill.appliedIds.length;

    if (routing.totalAdded === 0 && skill.appliedIds.length === 0) {
      break;
    }
  }

  const stage1 = d.runCommandsStage('stage1', config.stage1Commands, config.worktreePath);
  report.tests.push(stage1);
  if (!stage1.ok) {
    throw new Error(`stage1_failed:${stage1.failedCommand}`);
  }

  const stage2 = d.runCommandsStage('stage2', config.stage2Commands, config.worktreePath);
  report.tests.push(stage2);
  if (!stage2.ok) {
    throw new Error(`stage2_failed:${stage2.failedCommand}`);
  }

  const staged = d.stageAllowedChanges(config);
  report.git.changedPaths = staged.changedPaths || [];
  report.git.stagedPaths = staged.stagedPaths || [];
  report.git.disallowedPaths = staged.disallowedPaths || [];
  if (!staged.ok) {
    throw new Error(`allowlist_blocked:${staged.reason}:${(staged.disallowedPaths || []).join(',')}`);
  }

  if (staged.stagedPaths.length === 0) {
    report.ok = true;
    report.git.committed = false;
    report.git.pushed = false;
    report.pr.attempted = false;
    return report;
  }

  const ghAuth = d.ensureGhAuth(config.worktreePath);
  if (!ghAuth.ok) {
    throw new Error(`gh_auth_failed:${ghAuth.stderr || ghAuth.error || ghAuth.stdout || ghAuth.code}`);
  }

  if (config.dryRun) {
    report.git.commitMessage = buildCommitMessage(config);
    report.git.committed = false;
    report.git.pushed = false;
  } else {
    const commitMessage = buildCommitMessage(config);
    const commit = runProcess('git', ['-C', config.worktreePath, 'commit', '-m', commitMessage]);
    if (!commit.ok) {
      throw new Error(`git_commit_failed:${commit.stderr || commit.error || commit.stdout || commit.code}`);
    }
    report.git.commitMessage = commitMessage;
    report.git.committed = true;

    const push = runProcess('git', ['-C', config.worktreePath, 'push', '-u', 'origin', config.branch]);
    if (!push.ok) {
      throw new Error(`git_push_failed:${push.stderr || push.error || push.stdout || push.code}`);
    }
    report.git.pushed = true;
  }

  report.pr.attempted = true;
  const pr = d.upsertPullRequest(config, report);
  report.pr = {
    attempted: true,
    ok: pr.ok,
    action: pr.action,
    number: pr.number,
    url: pr.url,
    error: pr.error || '',
  };
  if (!pr.ok) {
    throw new Error(`pr_upsert_failed:${pr.error || pr.action}`);
  }

  report.ok = true;
  return report;
}

function createBaseReport(config, nowFn = () => new Date(), previousState = {}) {
  return {
    runAt: nowIso(nowFn),
    ok: false,
    skipped: false,
    error: '',
    consecutiveFailures: Math.max(0, Number(previousState.consecutiveFailures || 0)),
    iterations: [],
    routingAdded: 0,
    skillApplied: 0,
    preflight: {
      worktreePath: config.worktreePath,
      valid: true,
      gitdirPath: '',
      registered: false,
      repairAllowed: true,
      repaired: false,
      repairAction: 'none',
      repairSteps: [],
    },
    retry: {
      attempted: false,
      reason: '',
      succeeded: false,
    },
    delivery: {
      prAttempted: false,
      prUrl: '',
      briefingEligible: false,
    },
    tests: [],
    git: {
      changedPaths: [],
      stagedPaths: [],
      disallowedPaths: [],
      committed: false,
      pushed: false,
      commitMessage: '',
      branch: config.branch,
      worktreePath: config.worktreePath,
    },
    pr: {
      attempted: false,
      ok: false,
      action: 'none',
      number: null,
      url: '',
      error: '',
    },
  };
}

function createDefaultDeps() {
  return {
    nowFn: () => new Date(),
    readJson,
    acquireLock,
    releaseLock,
    inspectWorktreePreflight,
    repairWorktree,
    ensureWorktree,
    ensureSeedQueueFile,
    runRoutingLoopOnce,
    runSkillFeedbackLoopOnce,
    runCommandsStage,
    stageAllowedChanges,
    ensureGhAuth,
    readOpenPullRequest,
    upsertPullRequest,
    writeJson,
    makeTempRoot: () => fs.mkdtempSync(path.join(os.tmpdir(), 'midnight-recursive-')),
    cleanupTempRoot: (dirPath) => fs.rmSync(dirPath, { recursive: true, force: true }),
  };
}

function runMidnightRecursiveImprove(config = buildConfig(), deps = {}) {
  const d = { ...createDefaultDeps(), ...(deps || {}) };
  const previousState = d.readJson(config.statePath, { consecutiveFailures: 0 });
  const report = createBaseReport(config, d.nowFn, previousState);
  const lock = d.acquireLock(config, d.nowFn);
  if (!lock.acquired) {
    report.ok = true;
    report.skipped = true;
    report.error = String(lock.reason || 'already_locked');
    report.lock = lock;
    persistReport(config, d, report, previousState);
    return report;
  }

  const tempRoot = d.makeTempRoot();
  const queuePath = path.join(tempRoot, 'feedback_queue.jsonl');
  const previewPath = path.join(tempRoot, 'skill_patch_preview.md');

  try {
    const initialPreflight = d.inspectWorktreePreflight(config);
    report.preflight = {
      ...report.preflight,
      ...initialPreflight,
    };

    if (!report.preflight.valid) {
      const repaired = d.repairWorktree(config, report.preflight);
      const refreshed = d.inspectWorktreePreflight(config);
      report.preflight = {
        ...report.preflight,
        ...refreshed,
        repairAllowed: repaired.repairAllowed !== false,
        repaired: repaired.repaired === true,
        repairAction: repaired.repairAction || report.preflight.repairAction || 'none',
        repairSteps: Array.isArray(repaired.repairSteps) ? repaired.repairSteps : report.preflight.repairSteps,
      };
      if (!report.preflight.valid) {
        throw new Error(`worktree_repair_failed:${report.preflight.reason || 'unknown'}`);
      }
    }

    try {
      executeMidnightRecursivePass(config, d, report, queuePath, previewPath);
    } catch (error) {
      if (!report.retry.attempted && isRecoverableWorktreeError(error)) {
        report.retry.attempted = true;
        report.retry.reason = parseFailureCode(error.message || error);

        const retryPreflight = d.inspectWorktreePreflight(config);
        const repaired = d.repairWorktree(config, retryPreflight);
        const refreshed = d.inspectWorktreePreflight(config);
        report.preflight = {
          ...report.preflight,
          ...refreshed,
          repairAllowed: repaired.repairAllowed !== false,
          repaired: repaired.repaired === true,
          repairAction: repaired.repairAction || report.preflight.repairAction || 'none',
          repairSteps: Array.isArray(repaired.repairSteps) ? repaired.repairSteps : report.preflight.repairSteps,
        };
        if (!report.preflight.valid) {
          throw new Error(`worktree_repair_failed:${report.preflight.reason || 'unknown'}`);
        }

        executeMidnightRecursivePass(config, d, report, queuePath, previewPath);
        report.retry.succeeded = true;
      } else {
        throw error;
      }
    }

    const finalPreflight = d.inspectWorktreePreflight(config);
    report.preflight = {
      ...report.preflight,
      ...finalPreflight,
      repairAllowed: report.preflight.repairAllowed !== false,
      repaired: report.preflight.repaired === true,
      repairAction: report.preflight.repairAction || 'none',
      repairSteps: Array.isArray(report.preflight.repairSteps) ? report.preflight.repairSteps : [],
    };

    persistReport(config, d, report, previousState);
    return report;
  } catch (error) {
    report.ok = false;
    report.error = String(error && error.message ? error.message : error);

    // If there is already an open PR, try to annotate failure status.
    const ghAuth = d.ensureGhAuth(config.worktreePath);
    if (ghAuth.ok) {
      const open = d.readOpenPullRequest(config.worktreePath, config.branch, config.baseRef);
      if (open.ok && open.rows.length > 0) {
        report.pr.attempted = true;
        const pr = d.upsertPullRequest(config, report);
        report.pr = {
          attempted: true,
          ok: pr.ok,
          action: pr.action,
          number: pr.number,
          url: pr.url,
          error: pr.error || '',
        };
      }
    }

    persistReport(config, d, report, previousState);
    return report;
  } finally {
    d.releaseLock(lock.lockPath);
    try {
      d.cleanupTempRoot(tempRoot);
    } catch (_) {
      // temporary files can be cleaned up on next run
    }
  }
}

function main() {
  const config = buildConfig();
  const report = runMidnightRecursiveImprove(config);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    skipped: report.skipped,
    reportPath: config.reportPath,
    iterations: report.iterations.length,
    routingAdded: report.routingAdded,
    skillApplied: report.skillApplied,
    preflightRepaired: report.preflight && report.preflight.repaired === true,
    retryAttempted: report.retry && report.retry.attempted === true,
    consecutiveFailures: report.consecutiveFailures || 0,
    error: report.error || '',
  }, null, 2)}\n`);
  if (!report.ok) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  buildConfig,
  buildCommitMessage,
  collectPendingIds,
  collectNewPendingIds,
  diffDisallowed,
  inspectWorktreePreflight,
  isManagedAutomationWorktreePath,
  repairWorktree,
  normalizeBaseRef,
  parseStatusPaths,
  createBaseReport,
  createDefaultDeps,
  runMidnightRecursiveImprove,
};
