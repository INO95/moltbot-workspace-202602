const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildConfig,
  collectNewPendingIds,
  diffDisallowed,
  inspectWorktreePreflight,
  normalizeBaseRef,
  parseStatusPaths,
  repairWorktree,
  runMidnightRecursiveImprove,
} = require('./midnight_recursive_improve');

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'midnight-recursive-test-'));
}

function makeConfig(tmpRoot) {
  return buildConfig({
    MIDNIGHT_RECURSIVE_MAIN_WORKSPACE: tmpRoot,
    MIDNIGHT_RECURSIVE_WORKTREE: path.join(tmpRoot, 'wt'),
    MIDNIGHT_RECURSIVE_DRY_RUN: '1',
    MIDNIGHT_RECURSIVE_MAX_ITERATIONS: '3',
  }, tmpRoot);
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initGitRepo(tmpRoot) {
  runGit(tmpRoot, ['init', '-b', 'main']);
  runGit(tmpRoot, ['config', 'user.email', 'codex@example.com']);
  runGit(tmpRoot, ['config', 'user.name', 'Codex']);
  fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# temp\n', 'utf8');
  runGit(tmpRoot, ['add', 'README.md']);
  runGit(tmpRoot, ['commit', '-m', 'init']);
}

function makeDeps(overrides = {}) {
  const callState = {
    stageCalls: 0,
    upsertCalls: 0,
    releaseCalls: 0,
  };
  const deps = {
    nowFn: () => new Date('2026-02-25T00:00:00.000Z'),
    readJson: (_filePath, fallback) => fallback,
    acquireLock: () => ({ acquired: true, lockPath: '/tmp/lock.json' }),
    releaseLock: () => { callState.releaseCalls += 1; },
    inspectWorktreePreflight: (config) => ({
      worktreePath: config.worktreePath,
      valid: true,
      gitdirPath: '',
      registered: false,
      repairAllowed: true,
      repaired: false,
      repairAction: 'none',
      repairSteps: [],
    }),
    repairWorktree: () => ({ repaired: true, repairAllowed: true, repairAction: 'none', repairSteps: [] }),
    ensureWorktree: () => {},
    ensureSeedQueueFile: (_mainQueuePath, queuePath) => {
      fs.mkdirSync(path.dirname(queuePath), { recursive: true });
      if (!fs.existsSync(queuePath)) fs.writeFileSync(queuePath, '', 'utf8');
    },
    runRoutingLoopOnce: () => ({ ok: true, totalAdded: 0 }),
    runSkillFeedbackLoopOnce: () => ({ ok: true, newPendingIds: [], appliedIds: [] }),
    runCommandsStage: (stage) => {
      callState.stageCalls += 1;
      return { stage, ok: true, failedCommand: '', rows: [] };
    },
    stageAllowedChanges: () => ({
      ok: true,
      reason: 'no_changes',
      changedPaths: [],
      stagedPaths: [],
      disallowedPaths: [],
    }),
    ensureGhAuth: () => ({ ok: true }),
    readOpenPullRequest: () => ({ ok: true, rows: [] }),
    upsertPullRequest: () => {
      callState.upsertCalls += 1;
      return { ok: true, action: 'created', number: 1, url: 'https://example.com/pr/1', error: '' };
    },
    writeJson,
    makeTempRoot: makeTmpRoot,
    cleanupTempRoot: (dirPath) => fs.rmSync(dirPath, { recursive: true, force: true }),
    ...overrides,
  };
  return { deps, callState };
}

function testHelpers() {
  const parsed = parseStatusPaths(' M data/config.json\nR  old.md -> notes/PORTFOLIO_CONTENT_TEMPLATE.md\n?? scripts/x.js\n');
  assert.deepStrictEqual(parsed, ['data/config.json', 'notes/PORTFOLIO_CONTENT_TEMPLATE.md', 'scripts/x.js']);

  const disallowed = diffDisallowed(parsed, [
    'data/config.json',
    'notes/PORTFOLIO_CONTENT_TEMPLATE.md',
  ]);
  assert.deepStrictEqual(disallowed, ['scripts/x.js']);

  assert.strictEqual(normalizeBaseRef('origin/main'), 'main');
  assert.strictEqual(normalizeBaseRef('refs/heads/dev'), 'dev');
  assert.strictEqual(normalizeBaseRef('main'), 'main');

  const newPending = collectNewPendingIds(
    [{ id: 'a', status: 'pending_approval' }],
    [{ id: 'a', status: 'pending_approval' }, { id: 'b', status: 'pending_approval' }],
  );
  assert.deepStrictEqual(newPending, ['b']);
}

function testScenarioNoChanges() {
  const tmpRoot = makeTmpRoot();
  try {
    const config = makeConfig(tmpRoot);
    const { deps } = makeDeps();
    const report = runMidnightRecursiveImprove(config, deps);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.git.committed, false);
    assert.strictEqual(report.git.pushed, false);
    assert.strictEqual(report.pr.attempted, false);
    assert.strictEqual(report.delivery.briefingEligible, false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioRoutingOnly() {
  const tmpRoot = makeTmpRoot();
  try {
    const config = makeConfig(tmpRoot);
    const { deps, callState } = makeDeps({
      runRoutingLoopOnce: (() => {
        let count = 0;
        return () => {
          count += 1;
          if (count === 1) return { ok: true, totalAdded: 1 };
          return { ok: true, totalAdded: 0 };
        };
      })(),
      stageAllowedChanges: () => ({
        ok: true,
        reason: 'staged',
        changedPaths: ['data/policy/routing_adaptive_keywords.json'],
        stagedPaths: ['data/policy/routing_adaptive_keywords.json'],
        disallowedPaths: [],
      }),
    });
    const report = runMidnightRecursiveImprove(config, deps);
    assert.strictEqual(report.ok, true);
    assert.ok(report.routingAdded >= 1);
    assert.strictEqual(report.pr.attempted, true);
    assert.strictEqual(callState.upsertCalls, 1);
    assert.strictEqual(report.delivery.prAttempted, true);
    assert.strictEqual(report.delivery.prUrl, 'https://example.com/pr/1');
    assert.strictEqual(report.delivery.briefingEligible, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioSkillOnly() {
  const tmpRoot = makeTmpRoot();
  try {
    const config = makeConfig(tmpRoot);
    const { deps } = makeDeps({
      runSkillFeedbackLoopOnce: (() => {
        let count = 0;
        return () => {
          count += 1;
          if (count === 1) return { ok: true, newPendingIds: ['id-1'], appliedIds: ['id-1'] };
          return { ok: true, newPendingIds: [], appliedIds: [] };
        };
      })(),
      stageAllowedChanges: () => ({
        ok: true,
        reason: 'staged',
        changedPaths: ['skills/moltbot/SKILL.md'],
        stagedPaths: ['skills/moltbot/SKILL.md'],
        disallowedPaths: [],
      }),
    });
    const report = runMidnightRecursiveImprove(config, deps);
    assert.strictEqual(report.ok, true);
    assert.ok(report.skillApplied >= 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioStage1Failure() {
  const tmpRoot = makeTmpRoot();
  try {
    const config = makeConfig(tmpRoot);
    const { deps, callState } = makeDeps({
      runCommandsStage: (stage) => {
        callState.stageCalls += 1;
        if (stage === 'stage1') {
          return { stage, ok: false, failedCommand: 'node scripts/test_bridge_nl_inference.js', rows: [] };
        }
        return { stage, ok: true, failedCommand: '', rows: [] };
      },
      readOpenPullRequest: () => ({
        ok: true,
        rows: [{ number: 10, url: 'https://example.com/pr/10', title: 'x' }],
      }),
    });
    const report = runMidnightRecursiveImprove(config, deps);
    assert.strictEqual(report.ok, false);
    assert.ok(String(report.error).includes('stage1_failed'));
    assert.strictEqual(callState.stageCalls, 1);
    assert.strictEqual(report.pr.attempted, true);
    assert.strictEqual(report.delivery.briefingEligible, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioStage2Failure() {
  const tmpRoot = makeTmpRoot();
  try {
    const config = makeConfig(tmpRoot);
    const { deps, callState } = makeDeps({
      runCommandsStage: (stage) => {
        callState.stageCalls += 1;
        if (stage === 'stage2') {
          return { stage, ok: false, failedCommand: 'node scripts/test_no_prefix_routing_report.js', rows: [] };
        }
        return { stage, ok: true, failedCommand: '', rows: [] };
      },
    });
    const report = runMidnightRecursiveImprove(config, deps);
    assert.strictEqual(report.ok, false);
    assert.ok(String(report.error).includes('stage2_failed'));
    assert.strictEqual(callState.stageCalls, 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioAllowlistBlocked() {
  const tmpRoot = makeTmpRoot();
  try {
    const config = makeConfig(tmpRoot);
    const { deps } = makeDeps({
      stageAllowedChanges: () => ({
        ok: false,
        reason: 'disallowed_working_changes',
        changedPaths: ['scripts/unsafe.js'],
        stagedPaths: [],
        disallowedPaths: ['scripts/unsafe.js'],
      }),
    });
    const report = runMidnightRecursiveImprove(config, deps);
    assert.strictEqual(report.ok, false);
    assert.ok(String(report.error).includes('allowlist_blocked'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioGhAuthFailure() {
  const tmpRoot = makeTmpRoot();
  try {
    const config = makeConfig(tmpRoot);
    const { deps } = makeDeps({
      stageAllowedChanges: () => ({
        ok: true,
        reason: 'staged',
        changedPaths: ['data/config.json'],
        stagedPaths: ['data/config.json'],
        disallowedPaths: [],
      }),
      ensureGhAuth: () => ({ ok: false, stderr: 'not logged in' }),
    });
    const report = runMidnightRecursiveImprove(config, deps);
    assert.strictEqual(report.ok, false);
    assert.ok(String(report.error).includes('gh_auth_failed'));
    assert.strictEqual(report.consecutiveFailures, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioLockBusy() {
  const tmpRoot = makeTmpRoot();
  try {
    const config = makeConfig(tmpRoot);
    const { deps } = makeDeps({
      acquireLock: () => ({ acquired: false, reason: 'already_locked', lockPath: '/tmp/lock.json' }),
    });
    const report = runMidnightRecursiveImprove(config, deps);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.skipped, true);
    assert.strictEqual(report.error, 'already_locked');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioBrokenWorktreeAutoRepair() {
  const tmpRoot = makeTmpRoot();
  try {
    initGitRepo(tmpRoot);
    const config = buildConfig({
      MIDNIGHT_RECURSIVE_MAIN_WORKSPACE: tmpRoot,
      MIDNIGHT_RECURSIVE_WORKTREE: path.join(tmpRoot, '.worktrees', 'nightly-recursive-improve'),
      MIDNIGHT_RECURSIVE_BASE_BRANCH: 'main',
      MIDNIGHT_RECURSIVE_DRY_RUN: '1',
      MIDNIGHT_RECURSIVE_MAX_ITERATIONS: '1',
    }, tmpRoot);

    fs.mkdirSync(config.worktreePath, { recursive: true });
    fs.writeFileSync(
      path.join(config.worktreePath, '.git'),
      'gitdir: /Users/moltbot/Projects/Moltbot_Workspace/.git/worktrees/nightly-recursive-improve\n',
      'utf8',
    );

    const report = runMidnightRecursiveImprove(config, {
      readJson: (_filePath, fallback) => fallback,
      acquireLock: () => ({ acquired: true, lockPath: '/tmp/lock.json' }),
      releaseLock: () => {},
      runRoutingLoopOnce: () => ({ ok: true, totalAdded: 0 }),
      runSkillFeedbackLoopOnce: () => ({ ok: true, newPendingIds: [], appliedIds: [] }),
      runCommandsStage: () => ({ stage: 'noop', ok: true, failedCommand: '', rows: [] }),
      stageAllowedChanges: () => ({
        ok: true,
        reason: 'no_changes',
        changedPaths: [],
        stagedPaths: [],
        disallowedPaths: [],
      }),
      ensureGhAuth: () => ({ ok: true }),
      writeJson,
      makeTempRoot: makeTmpRoot,
      cleanupTempRoot: (dirPath) => fs.rmSync(dirPath, { recursive: true, force: true }),
    });

    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.preflight.repairAllowed, true);
    assert.strictEqual(report.preflight.repaired, true);
    assert.ok(report.preflight.repairAction && report.preflight.repairAction !== 'none');
    assert.strictEqual(report.preflight.valid, true);
    assert.strictEqual(runGit(tmpRoot, ['worktree', 'list', '--porcelain']).includes(config.worktreePath), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioRecoverableRetry() {
  const tmpRoot = makeTmpRoot();
  try {
    const config = makeConfig(tmpRoot);
    const { deps } = makeDeps();
    let ensureCalls = 0;
    let repairCalls = 0;
    const report = runMidnightRecursiveImprove(config, {
      ...deps,
      repairWorktree: (...args) => {
        repairCalls += 1;
        return deps.repairWorktree(...args);
      },
      ensureWorktree: () => {
        ensureCalls += 1;
        if (ensureCalls === 1) throw new Error('worktree_path_not_git: /tmp/wt');
      },
    });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.retry.attempted, true);
    assert.strictEqual(report.retry.succeeded, true);
    assert.strictEqual(ensureCalls, 2);
    assert.strictEqual(repairCalls, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testScenarioManagedBranchConflictRepair() {
  const tmpRoot = makeTmpRoot();
  try {
    initGitRepo(tmpRoot);
    const managedWorktreePath = path.join(tmpRoot, '.worktrees', 'nightly-recursive-improve');
    runGit(tmpRoot, ['worktree', 'add', '-b', 'codex/nightly-recursive-improve', managedWorktreePath, 'main']);

    const config = buildConfig({
      MIDNIGHT_RECURSIVE_MAIN_WORKSPACE: tmpRoot,
      MIDNIGHT_RECURSIVE_WORKTREE: path.join(tmpRoot, '.tmp', 'nightly-recursive-worktree'),
      MIDNIGHT_RECURSIVE_BASE_BRANCH: 'main',
      MIDNIGHT_RECURSIVE_DRY_RUN: '1',
      MIDNIGHT_RECURSIVE_MAX_ITERATIONS: '1',
    }, tmpRoot);

    fs.mkdirSync(config.worktreePath, { recursive: true });
    fs.writeFileSync(
      path.join(config.worktreePath, '.git'),
      'gitdir: /Users/moltbot/Projects/Moltbot_Workspace/.git/worktrees/nightly-recursive-worktree\n',
      'utf8',
    );

    const report = runMidnightRecursiveImprove(config, {
      readJson: (_filePath, fallback) => fallback,
      acquireLock: () => ({ acquired: true, lockPath: '/tmp/lock.json' }),
      releaseLock: () => {},
      runRoutingLoopOnce: () => ({ ok: true, totalAdded: 0 }),
      runSkillFeedbackLoopOnce: () => ({ ok: true, newPendingIds: [], appliedIds: [] }),
      runCommandsStage: () => ({ stage: 'noop', ok: true, failedCommand: '', rows: [] }),
      stageAllowedChanges: () => ({
        ok: true,
        reason: 'no_changes',
        changedPaths: [],
        stagedPaths: [],
        disallowedPaths: [],
      }),
      ensureGhAuth: () => ({ ok: true }),
      writeJson,
      makeTempRoot: makeTmpRoot,
      cleanupTempRoot: (dirPath) => fs.rmSync(dirPath, { recursive: true, force: true }),
    });

    const worktreeList = runGit(tmpRoot, ['worktree', 'list', '--porcelain']);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.preflight.repaired, true);
    assert.strictEqual(worktreeList.includes(config.worktreePath), true);
    assert.strictEqual(worktreeList.includes(managedWorktreePath), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testRepairBlockedOutsideManagedPath() {
  const tmpRoot = makeTmpRoot();
  const outsideRoot = makeTmpRoot();
  try {
    initGitRepo(tmpRoot);
    const config = buildConfig({
      MIDNIGHT_RECURSIVE_MAIN_WORKSPACE: tmpRoot,
      MIDNIGHT_RECURSIVE_WORKTREE: path.join(outsideRoot, 'nightly-recursive-improve'),
      MIDNIGHT_RECURSIVE_BASE_BRANCH: 'main',
      MIDNIGHT_RECURSIVE_DRY_RUN: '1',
      MIDNIGHT_RECURSIVE_MAX_ITERATIONS: '1',
    }, tmpRoot);

    fs.mkdirSync(config.worktreePath, { recursive: true });

    const repair = repairWorktree(config, {
      registered: false,
      gitdirPath: '',
    });

    assert.strictEqual(repair.repaired, false);
    assert.strictEqual(repair.repairAllowed, false);
    assert.strictEqual(repair.repairAction, 'blocked_unmanaged_worktree');
    assert.strictEqual(fs.existsSync(config.worktreePath), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
}

function main() {
  testHelpers();
  testScenarioNoChanges();
  testScenarioRoutingOnly();
  testScenarioSkillOnly();
  testScenarioStage1Failure();
  testScenarioStage2Failure();
  testScenarioAllowlistBlocked();
  testScenarioGhAuthFailure();
  testScenarioLockBusy();
  testScenarioBrokenWorktreeAutoRepair();
  testScenarioRecoverableRetry();
  testScenarioManagedBranchConflictRepair();
  testRepairBlockedOutsideManagedPath();
  console.log('test_midnight_recursive_improve: ok');
}

main();
