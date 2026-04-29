#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = process.env.OPS_GC_ROOT
  ? path.resolve(String(process.env.OPS_GC_ROOT))
  : path.resolve(__dirname, '..');

const DEFAULT_TARGETS = Object.freeze([
  'logs',
  'reports',
  'ops/alerts/sent',
  'ops/state/briefing_locks',
  'ops/commands/state/completed',
  'ops/commands/state/consumed',
]);
const KEEP_FILE_NAMES = new Set(['.gitkeep', '.gitignore']);

function toPosix(relPath) {
  return String(relPath || '').split(path.sep).join('/');
}

function toRel(root, filePath) {
  const rel = path.relative(root, filePath);
  return toPosix(rel || '.');
}

function isInsideRoot(root, filePath) {
  const rel = path.relative(root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeLstat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (_) {
    return null;
  }
}

function collectRuntimeGcPlan(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const targets = Array.isArray(options.targets) && options.targets.length > 0
    ? options.targets
    : DEFAULT_TARGETS;
  const days = Number.isFinite(Number(options.days)) ? Number(options.days) : 30;
  const cutoffMs = Date.now() - (Math.max(0, days) * 24 * 60 * 60 * 1000);
  const candidates = [];
  const skipped = [];

  function skip(filePath, reason) {
    skipped.push({
      path: toRel(root, filePath),
      reason,
    });
  }

  function visit(filePath) {
    const absolutePath = path.resolve(filePath);
    if (!isInsideRoot(root, absolutePath)) {
      skip(absolutePath, 'outside_root');
      return;
    }
    const stat = safeLstat(absolutePath);
    if (!stat) {
      skip(absolutePath, 'missing');
      return;
    }
    if (stat.isSymbolicLink()) {
      skip(absolutePath, 'symlink');
      return;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(absolutePath);
      } catch (_) {
        skip(absolutePath, 'unreadable');
        return;
      }
      for (const entry of entries) {
        visit(path.join(absolutePath, entry));
      }
      return;
    }
    if (!stat.isFile()) {
      skip(absolutePath, 'not_file');
      return;
    }
    if (KEEP_FILE_NAMES.has(path.basename(absolutePath))) {
      skip(absolutePath, 'keep_file');
      return;
    }
    if (stat.mtimeMs <= cutoffMs) {
      candidates.push({
        path: toRel(root, absolutePath),
        absolutePath,
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }

  for (const target of targets) {
    visit(path.resolve(root, String(target || '')));
  }

  candidates.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    root,
    days,
    cutoff: new Date(cutoffMs).toISOString(),
    targets: targets.map((target) => toPosix(String(target || ''))),
    candidates,
    skipped,
  };
}

function runRuntimeGc(options = {}) {
  const apply = options.apply === true;
  const plan = collectRuntimeGcPlan(options);
  const deleted = [];
  const deleteErrors = [];

  if (apply) {
    for (const candidate of plan.candidates) {
      const absolutePath = path.resolve(candidate.absolutePath);
      const stat = safeLstat(absolutePath);
      if (!stat) continue;
      if (!isInsideRoot(plan.root, absolutePath) || stat.isSymbolicLink() || !stat.isFile()) {
        deleteErrors.push({
          path: candidate.path,
          reason: 'unsafe_path',
        });
        continue;
      }
      try {
        fs.rmSync(absolutePath, { force: true });
        deleted.push(candidate.path);
      } catch (error) {
        deleteErrors.push({
          path: candidate.path,
          reason: String(error && error.message ? error.message : error),
        });
      }
    }
  }

  return {
    ...plan,
    apply,
    deleted,
    deletedCount: deleted.length,
    deleteErrors,
    ok: deleteErrors.length === 0,
  };
}

function normalizeLimit(value, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function compactCandidate(row) {
  return {
    path: row.path,
    sizeBytes: row.sizeBytes,
    mtime: row.mtime,
  };
}

function compactRuntimeGcResult(result, options = {}) {
  const limit = normalizeLimit(options.limit, 50);
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  const deleted = Array.isArray(result.deleted) ? result.deleted : [];
  const deleteErrors = Array.isArray(result.deleteErrors) ? result.deleteErrors : [];

  return {
    ok: result.ok,
    root: result.root,
    days: result.days,
    cutoff: result.cutoff,
    targets: result.targets,
    apply: result.apply,
    candidateCount: candidates.length,
    skippedCount: skipped.length,
    deletedCount: result.deletedCount || deleted.length,
    deleteErrorCount: deleteErrors.length,
    candidateSample: candidates.slice(0, limit).map(compactCandidate),
    skippedSample: skipped.slice(0, limit),
    deletedSample: deleted.slice(0, limit),
    deleteErrors: deleteErrors.slice(0, limit),
    hasMoreCandidates: candidates.length > limit,
    hasMoreSkipped: skipped.length > limit,
    hasMoreDeleted: deleted.length > limit,
    hasMoreDeleteErrors: deleteErrors.length > limit,
  };
}

function parseArgs(argv) {
  const out = {
    apply: false,
    json: false,
    full: false,
    limit: 50,
    days: 30,
    targets: [],
    root: DEFAULT_ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--full') out.full = true;
    else if (arg === '--summary') out.full = false;
    else if (arg === '--limit') {
      i += 1;
      out.limit = normalizeLimit(argv[i], out.limit);
    } else if (arg.startsWith('--limit=')) {
      out.limit = normalizeLimit(arg.slice('--limit='.length), out.limit);
    } else if (arg === '--days') {
      i += 1;
      out.days = Number(argv[i]);
    } else if (arg.startsWith('--days=')) {
      out.days = Number(arg.slice('--days='.length));
    } else if (arg === '--target') {
      i += 1;
      out.targets.push(argv[i]);
    } else if (arg.startsWith('--target=')) {
      out.targets.push(arg.slice('--target='.length));
    } else if (arg === '--root') {
      i += 1;
      out.root = path.resolve(argv[i]);
    } else if (arg.startsWith('--root=')) {
      out.root = path.resolve(arg.slice('--root='.length));
    }
  }
  return out;
}

function printText(result, options = {}) {
  const limit = normalizeLimit(options.limit, 20);
  const mode = result.apply ? 'apply' : 'dry-run';
  console.log(`ops runtime gc (${mode})`);
  console.log(`root: ${result.root}`);
  console.log(`older than: ${result.days} days`);
  console.log(`candidates: ${result.candidates.length}`);
  console.log(`deleted: ${result.deletedCount}`);
  if (result.candidates.length > 0) {
    console.log(`sample (limit ${limit}):`);
    for (const row of result.candidates.slice(0, limit)) {
      console.log(`- ${row.path} (${row.sizeBytes} bytes, ${row.mtime})`);
    }
    if (result.candidates.length > limit) {
      console.log(`... ${result.candidates.length - limit} more. Use --json --full to print every candidate.`);
    }
  }
  if (result.skipped.length > 0) {
    console.log(`skipped: ${result.skipped.length}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runRuntimeGc(args);
  if (args.json) {
    const payload = args.full ? result : compactRuntimeGcResult(result, { limit: args.limit });
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printText(result, args);
  }
  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_TARGETS,
  KEEP_FILE_NAMES,
  collectRuntimeGcPlan,
  compactRuntimeGcResult,
  runRuntimeGc,
};
