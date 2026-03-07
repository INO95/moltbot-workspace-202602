const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildRecursiveImproveHealthStep } = require('./nightly_autopilot');

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-autopilot-'));
  try {
    writeJson(path.join(tmpRoot, 'logs', 'midnight_recursive_improve_latest.json'), {
      runAt: '2026-03-06T15:00:00.000Z',
      ok: false,
      skipped: false,
      error: 'stage2_failed:node scripts/test_no_prefix_routing_report.js',
      consecutiveFailures: 2,
      preflight: {
        worktreePath: path.join(tmpRoot, '.worktrees', 'nightly-recursive-improve'),
        valid: true,
        gitdirPath: '',
        registered: true,
        repaired: true,
        repairAction: 'remove_broken_worktree_path',
      },
      delivery: {
        prAttempted: false,
        prUrl: '',
        briefingEligible: true,
      },
      pr: {
        attempted: false,
        ok: false,
        action: 'none',
        number: null,
        url: '',
        error: '',
      },
    });

    const failStep = buildRecursiveImproveHealthStep(tmpRoot, { now: '2026-03-06T18:30:00.000Z' });
    assert.strictEqual(failStep.name, 'recursive-improve-health');
    assert.strictEqual(failStep.ok, false);
    assert.ok(String(failStep.stdout).includes('"consecutiveFailures": 2'));
    assert.ok(String(failStep.stdout).includes('"preflightRepaired": true'));
    assert.ok(String(failStep.stderr).includes('stage2_failed'));

    writeJson(path.join(tmpRoot, 'logs', 'midnight_recursive_improve_latest.json'), {
      runAt: '2026-03-06T15:00:00.000Z',
      ok: true,
      skipped: false,
      error: '',
      consecutiveFailures: 0,
      preflight: {
        worktreePath: path.join(tmpRoot, '.worktrees', 'nightly-recursive-improve'),
        valid: true,
        gitdirPath: '',
        registered: true,
        repaired: false,
        repairAction: 'none',
      },
      delivery: {
        prAttempted: true,
        prUrl: 'https://example.com/pr/123',
        briefingEligible: true,
      },
      pr: {
        attempted: true,
        ok: true,
        action: 'edited',
        number: 123,
        url: 'https://example.com/pr/123',
        error: '',
      },
    });

    const okStep = buildRecursiveImproveHealthStep(tmpRoot, { now: '2026-03-06T18:30:00.000Z' });
    assert.strictEqual(okStep.ok, true);
    assert.ok(String(okStep.stdout).includes('"prUrl": "https://example.com/pr/123"'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('test_nightly_autopilot: ok');
}

main();
