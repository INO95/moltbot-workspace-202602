#!/usr/bin/env node
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const RUNTIME_ARTIFACT_PATTERNS = [
  /^ops\/commands\/outbox\//,
  /^ops\/commands\/results\.jsonl$/,
  /^ops\/commands\/state\/(?:completed|consumed|grants|pending|processing)\//,
  /^ops\/state\/(?:state\.json|issues\.json|leader_snapshot_latest\.json|browser_requests\.jsonl)$/,
  /^ops\/state\/cron_backup_.*\.txt$/,
  /^data\/state\/pending_approvals\.json$/,
];

function runGit(args) {
  const res = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: !res.error && res.status === 0,
    code: Number.isInteger(res.status) ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function listTrackedFiles() {
  const res = runGit(['ls-files', '-z']);
  if (!res.ok) {
    throw new Error(`git ls-files failed: ${res.error || res.stderr || `exit=${res.code}`}`);
  }
  return res.stdout
    .split('\0')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isRuntimeArtifact(relPath) {
  return RUNTIME_ARTIFACT_PATTERNS.some((pattern) => pattern.test(relPath));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function untrackFiles(files) {
  let removed = 0;
  for (const group of chunk(files, 200)) {
    const res = runGit(['rm', '--cached', '-q', '--', ...group]);
    if (!res.ok) {
      throw new Error(`git rm --cached failed: ${res.error || res.stderr || `exit=${res.code}`}`);
    }
    removed += group.length;
  }
  return removed;
}

function run() {
  const fix = process.argv.includes('--fix');
  const tracked = listTrackedFiles();
  const offenders = tracked.filter(isRuntimeArtifact);

  if (offenders.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      fixApplied: false,
      trackedFiles: tracked.length,
      offendingTrackedRuntimeArtifacts: 0,
    }, null, 2));
    return;
  }

  let removed = 0;
  if (fix) {
    removed = untrackFiles(offenders);
  }

  const stillTracked = listTrackedFiles().filter(isRuntimeArtifact);
  const sample = (stillTracked.length > 0 ? stillTracked : offenders).slice(0, 20);
  const ok = stillTracked.length === 0;
  const payload = {
    ok,
    fixApplied: fix,
    removedFromIndex: removed,
    offendingTrackedRuntimeArtifacts: stillTracked.length,
    sample,
  };
  if (!ok) {
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(payload, null, 2));
}

try {
  run();
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}
