#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = process.env.OPS_WORKSPACE_ROOT
  ? path.resolve(String(process.env.OPS_WORKSPACE_ROOT))
  : path.resolve(__dirname, '..');
const DEFAULT_SENT_DIR = path.join(ROOT, 'ops', 'alerts', 'sent');
const DEFAULT_SUMMARY_DIR = path.join(ROOT, 'ops', 'alerts', 'summaries');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function safeLstat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (_) {
    return null;
  }
}

function isInsideRoot(root, filePath) {
  const rel = path.relative(root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sanitizeToken(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function alertDate(alert, fallbackName = '') {
  const raw = String((alert && alert.created_at) || fallbackName || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : 'unknown-date';
}

function collectAlertCompactPlan(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const sentDir = path.resolve(options.sentDir || path.join(root, 'ops', 'alerts', 'sent'));
  const summaryDir = path.resolve(options.summaryDir || path.join(root, 'ops', 'alerts', 'summaries'));
  const includeSingle = options.includeSingle === true;
  const skipped = [];
  const groups = new Map();

  if (!isInsideRoot(root, sentDir) || !isInsideRoot(root, summaryDir)) {
    throw new Error('alert compact paths must stay inside the workspace root');
  }

  const sentStat = safeLstat(sentDir);
  if (!sentStat || !sentStat.isDirectory()) {
    return {
      ok: true,
      root,
      sentDir,
      summaryDir,
      groupCount: 0,
      fileCount: 0,
      groups: [],
      skipped: [{ path: path.relative(root, sentDir) || '.', reason: 'missing_sent_dir' }],
    };
  }

  for (const name of fs.readdirSync(sentDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(sentDir, name);
    const stat = safeLstat(filePath);
    if (!stat) {
      skipped.push({ path: path.relative(root, filePath), reason: 'missing' });
      continue;
    }
    if (stat.isSymbolicLink()) {
      skipped.push({ path: path.relative(root, filePath), reason: 'symlink' });
      continue;
    }
    if (!stat.isFile()) continue;
    const alert = readJson(filePath, null);
    if (!alert || typeof alert !== 'object') {
      skipped.push({ path: path.relative(root, filePath), reason: 'invalid_json' });
      continue;
    }
    const date = alertDate(alert, name);
    const issueId = sanitizeToken(alert.issue_id || 'unknown_issue');
    const severity = sanitizeToken(alert.severity || 'unknown_severity');
    const key = `${date}__${issueId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        date,
        issueId,
        severity,
        files: [],
        alerts: [],
      });
    }
    const group = groups.get(key);
    group.files.push(filePath);
    group.alerts.push(alert);
  }

  const compactGroups = [];
  for (const group of groups.values()) {
    if (!includeSingle && group.files.length < 2) continue;
    const createdTimes = group.alerts
      .map((alert) => String(alert.created_at || '').trim())
      .filter(Boolean)
      .sort();
    const summaryPath = path.join(
      summaryDir,
      `${sanitizeToken(group.date)}_${sanitizeToken(group.issueId)}.summary.json`,
    );
    compactGroups.push({
      key: `${group.date}:${group.issueId}`,
      date: group.date,
      issueId: group.issueId,
      severity: group.severity,
      count: group.files.length,
      summaryPath,
      sourceFiles: group.files,
      firstCreatedAt: createdTimes[0] || null,
      lastCreatedAt: createdTimes[createdTimes.length - 1] || null,
    });
  }
  compactGroups.sort((a, b) => a.key.localeCompare(b.key));

  return {
    ok: true,
    root,
    sentDir,
    summaryDir,
    groupCount: compactGroups.length,
    fileCount: compactGroups.reduce((sum, group) => sum + group.count, 0),
    groups: compactGroups,
    skipped,
  };
}

function buildSummary(group) {
  return {
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    date: group.date,
    issue_id: group.issueId,
    severity: group.severity,
    alert_count: group.count,
    first_created_at: group.firstCreatedAt,
    last_created_at: group.lastCreatedAt,
    source_files: group.sourceFiles.map((filePath) => path.basename(filePath)),
  };
}

function runAlertCompact(options = {}) {
  const apply = options.apply === true;
  const plan = collectAlertCompactPlan(options);
  const written = [];
  const deleted = [];
  const errors = [];

  if (apply) {
    for (const group of plan.groups) {
      try {
        writeJsonAtomic(group.summaryPath, buildSummary(group));
        written.push(path.relative(plan.root, group.summaryPath));
        for (const filePath of group.sourceFiles) {
          const stat = safeLstat(filePath);
          if (!stat || stat.isSymbolicLink() || !stat.isFile() || !isInsideRoot(plan.root, filePath)) {
            errors.push({ path: path.relative(plan.root, filePath), reason: 'unsafe_source' });
            continue;
          }
          fs.rmSync(filePath, { force: true });
          deleted.push(path.relative(plan.root, filePath));
        }
      } catch (error) {
        errors.push({
          group: group.key,
          reason: String(error && error.message ? error.message : error),
        });
      }
    }
  }

  return {
    ...plan,
    apply,
    written,
    deleted,
    errorCount: errors.length,
    errors,
    ok: errors.length === 0,
  };
}

function compactResult(result, limit = 20) {
  const n = Math.max(0, Math.floor(Number(limit) || 20));
  return {
    ok: result.ok,
    apply: result.apply,
    root: result.root,
    groupCount: result.groupCount,
    fileCount: result.fileCount,
    writtenCount: Array.isArray(result.written) ? result.written.length : 0,
    deletedCount: Array.isArray(result.deleted) ? result.deleted.length : 0,
    skippedCount: Array.isArray(result.skipped) ? result.skipped.length : 0,
    errorCount: result.errorCount || 0,
    groupSample: result.groups.slice(0, n).map((group) => ({
      key: group.key,
      count: group.count,
      firstCreatedAt: group.firstCreatedAt,
      lastCreatedAt: group.lastCreatedAt,
    })),
    hasMoreGroups: result.groups.length > n,
    skippedSample: result.skipped.slice(0, n),
    errors: result.errors.slice(0, n),
  };
}

function parseArgs(argv) {
  const out = {
    apply: false,
    json: false,
    full: false,
    includeSingle: false,
    limit: 20,
    root: ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--full') out.full = true;
    else if (arg === '--include-single') out.includeSingle = true;
    else if (arg === '--limit') {
      i += 1;
      out.limit = Number(argv[i]);
    } else if (arg.startsWith('--limit=')) {
      out.limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--root') {
      i += 1;
      out.root = path.resolve(argv[i]);
    } else if (arg.startsWith('--root=')) {
      out.root = path.resolve(arg.slice('--root='.length));
    }
  }
  return out;
}

function printText(result) {
  console.log(`ops alerts compact (${result.apply ? 'apply' : 'dry-run'})`);
  console.log(`groups: ${result.groupCount}`);
  console.log(`files: ${result.fileCount}`);
  console.log(`written: ${result.written.length}`);
  console.log(`deleted: ${result.deleted.length}`);
  for (const group of result.groups.slice(0, 20)) {
    console.log(`- ${group.key}: ${group.count} files`);
  }
  if (result.groups.length > 20) {
    console.log(`... ${result.groups.length - 20} more`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runAlertCompact(args);
  if (args.json) {
    console.log(JSON.stringify(args.full ? result : compactResult(result, args.limit), null, 2));
  } else {
    printText(result);
  }
  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  collectAlertCompactPlan,
  compactResult,
  runAlertCompact,
};
