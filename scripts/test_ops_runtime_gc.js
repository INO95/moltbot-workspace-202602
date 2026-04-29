const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectRuntimeGcPlan, compactRuntimeGcResult, runRuntimeGc } = require('./ops_runtime_gc');

function touch(filePath, ageDays) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'x', 'utf8');
  const when = new Date(Date.now() - (ageDays * 24 * 60 * 60 * 1000));
  fs.utimesSync(filePath, when, when);
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-runtime-gc-'));
  const oldLog = path.join(root, 'logs', 'old.log');
  const newLog = path.join(root, 'logs', 'new.log');
  const oldReport = path.join(root, 'reports', 'old.json');
  const linkPath = path.join(root, 'logs', 'old-link.log');
  const keepFile = path.join(root, 'logs', '.gitkeep');
  try {
    touch(oldLog, 31);
    touch(newLog, 1);
    touch(oldReport, 31);
    touch(keepFile, 31);
    fs.symlinkSync(oldLog, linkPath);

    const dryRun = runRuntimeGc({
      root,
      days: 30,
      targets: ['logs', 'reports'],
      apply: false,
    });
    assert.strictEqual(dryRun.ok, true);
    assert.strictEqual(dryRun.apply, false);
    assert.ok(dryRun.candidates.some((row) => row.path === 'logs/old.log'));
    assert.ok(dryRun.candidates.some((row) => row.path === 'reports/old.json'));
    assert.ok(!dryRun.candidates.some((row) => row.path === 'logs/new.log'));
    assert.ok(!dryRun.candidates.some((row) => row.path === 'logs/.gitkeep'));
    assert.ok(dryRun.skipped.some((row) => row.path === 'logs/.gitkeep' && row.reason === 'keep_file'));
    assert.ok(dryRun.skipped.some((row) => row.path === 'logs/old-link.log' && row.reason === 'symlink'));
    assert.ok(fs.existsSync(oldLog), 'dry-run should not delete old file');
    const compact = compactRuntimeGcResult(dryRun, { limit: 1 });
    assert.strictEqual(compact.candidateCount, 2);
    assert.strictEqual(compact.candidateSample.length, 1);
    assert.strictEqual(compact.hasMoreCandidates, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(compact, 'candidates'), false);

    const apply = runRuntimeGc({
      root,
      days: 30,
      targets: ['logs', 'reports'],
      apply: true,
    });
    assert.strictEqual(apply.ok, true);
    assert.ok(!fs.existsSync(oldLog), 'apply should delete old log');
    assert.ok(!fs.existsSync(oldReport), 'apply should delete old report');
    assert.ok(fs.existsSync(newLog), 'apply should keep new log');
    assert.ok(fs.existsSync(keepFile), 'apply should keep .gitkeep');
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), 'apply should keep symlink itself');

    const outside = collectRuntimeGcPlan({
      root,
      days: 0,
      targets: ['../outside'],
    });
    assert.ok(outside.skipped.some((row) => row.reason === 'outside_root'));
    console.log('test_ops_runtime_gc: ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
