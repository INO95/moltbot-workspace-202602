#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_NATURAL_LANGUAGE_ROUTING,
} = require('../packages/core-policy/src/bridge_defaults');
const { normalizeIncomingCommandText } = require('./lib/bridge_input_normalization');
const { buildRoutingRules, matchPrefix } = require('./lib/bridge_route_dispatch');
const { inferNaturalLanguageRoute } = require('./lib/bridge_nl_inference');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT_PATH = path.join(ROOT, 'data', 'conversation', 'staging.jsonl');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'data', 'config.json');
const DEFAULT_REPORT_DIR = path.join(ROOT, 'logs', 'reports');
const DEFAULT_HISTORY_PATH = path.join(ROOT, 'logs', 'no_prefix_routing_report_history.jsonl');
const DEFAULT_LATEST_JSON_PATH = path.join(DEFAULT_REPORT_DIR, 'no_prefix_routing_report_latest.json');
const DEFAULT_LATEST_MD_PATH = path.join(DEFAULT_REPORT_DIR, 'no_prefix_routing_report_latest.md');

function parseBoolean(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return null;
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = {
    input: DEFAULT_INPUT_PATH,
    config: DEFAULT_CONFIG_PATH,
    outDir: DEFAULT_REPORT_DIR,
    history: DEFAULT_HISTORY_PATH,
    windowHours: 24,
    sampleLimit: 8,
    writeMd: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '').trim();
    const next = String(args[i + 1] || '').trim();
    if (token === '--input' && next) {
      out.input = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === '--config' && next) {
      out.config = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === '--out-dir' && next) {
      out.outDir = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === '--history' && next) {
      out.history = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === '--window-hours' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) out.windowHours = parsed;
      i += 1;
      continue;
    }
    if (token === '--sample-limit' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) out.sampleLimit = Math.floor(parsed);
      i += 1;
      continue;
    }
    if (token === '--since' && next) {
      out.since = next;
      i += 1;
      continue;
    }
    if (token === '--no-md') {
      out.writeMd = false;
      continue;
    }
  }

  return out;
}

function readJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
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

function normalizeRoute(value) {
  const route = String(value || '').trim().toLowerCase();
  return route || 'none';
}

function pickNaturalLanguageRouting(raw = {}) {
  const merged = {
    ...DEFAULT_NATURAL_LANGUAGE_ROUTING,
    ...(raw && typeof raw === 'object' ? raw : {}),
  };
  const enabled = parseBoolean(process.env.BRIDGE_NL_ROUTING_ENABLED);
  const hubOnly = parseBoolean(process.env.BRIDGE_NL_ROUTING_HUB_ONLY);
  const inferWork = parseBoolean(process.env.BRIDGE_NL_INFER_WORK);
  const inferInspect = parseBoolean(process.env.BRIDGE_NL_INFER_INSPECT);
  if (enabled != null) merged.enabled = enabled;
  if (hubOnly != null) merged.hubOnly = hubOnly;
  if (inferWork != null) merged.inferWork = inferWork;
  if (inferInspect != null) merged.inferInspect = inferInspect;
  return merged;
}

function detectExplicitPrefix(message, routingRules) {
  for (const rule of routingRules) {
    for (const prefix of rule.prefixes) {
      const offset = matchPrefix(message, prefix);
      if (offset != null) {
        return { explicit: true, route: rule.route, prefix };
      }
    }
  }
  return { explicit: false, route: '', prefix: '' };
}

function replayInferredRoute(message, naturalLanguageRouting) {
  const inferred = inferNaturalLanguageRoute(message, { env: process.env }, {
    NATURAL_LANGUAGE_ROUTING: naturalLanguageRouting,
    isHubRuntime: () => false,
    isResearchRuntime: () => false,
    normalizeIncomingCommandText: (value) => String(value || '').trim(),
  });
  if (!inferred || typeof inferred !== 'object') return 'none';
  return normalizeRoute(inferred.route);
}

function toIsoOrNull(value) {
  const ts = Date.parse(String(value || ''));
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function truncateText(value, maxLen = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function mapToSortedObject(inputMap) {
  const entries = Array.from(inputMap.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = {};
  for (const [key, value] of entries) out[key] = value;
  return out;
}

function computeNoPrefixRoutingReport(records = [], options = {}) {
  const nowMs = Number.isFinite(Date.parse(String(options.now || '')))
    ? Date.parse(String(options.now))
    : Date.now();
  const windowHours = Number.isFinite(Number(options.windowHours))
    ? Number(options.windowHours)
    : 24;
  const sinceMs = Number.isFinite(Date.parse(String(options.since || '')))
    ? Date.parse(String(options.since))
    : nowMs - windowHours * 60 * 60 * 1000;
  const untilMs = Number.isFinite(Date.parse(String(options.until || '')))
    ? Date.parse(String(options.until))
    : nowMs;
  const sampleLimit = Number.isFinite(Number(options.sampleLimit))
    ? Math.max(1, Math.floor(Number(options.sampleLimit)))
    : 8;

  const commandPrefixes = (options.commandPrefixes && typeof options.commandPrefixes === 'object')
    ? options.commandPrefixes
    : {};
  const naturalLanguageRouting = pickNaturalLanguageRouting(
    options.naturalLanguageRouting && typeof options.naturalLanguageRouting === 'object'
      ? options.naturalLanguageRouting
      : {},
  );
  const routingRules = buildRoutingRules(commandPrefixes);

  let totalRecords = 0;
  let userRecords = 0;
  let prefixedRecords = 0;
  let noPrefixRecords = 0;
  let noneCount = 0;

  const routeCounts = new Map();
  const replayRouteCounts = new Map();
  const topNoneMessages = new Map();
  const mismatchCounts = {
    missedIntent: 0,
    routeDrift: 0,
    replayNone: 0,
  };
  const mismatchSamples = [];

  for (const record of Array.isArray(records) ? records : []) {
    const row = record && typeof record === 'object' ? record : null;
    if (!row) continue;
    totalRecords += 1;

    const source = String(row.source || '').trim().toLowerCase();
    if (source !== 'user') continue;
    userRecords += 1;

    const ts = Date.parse(String(row.timestamp || ''));
    if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;

    const normalizedMessage = normalizeIncomingCommandText(String(row.message || ''));
    if (!normalizedMessage) continue;

    const prefixMatch = detectExplicitPrefix(normalizedMessage, routingRules);
    if (prefixMatch.explicit) {
      prefixedRecords += 1;
      continue;
    }

    noPrefixRecords += 1;
    const recordedRoute = normalizeRoute(row.route);
    const replayRoute = replayInferredRoute(normalizedMessage, naturalLanguageRouting);

    routeCounts.set(recordedRoute, (routeCounts.get(recordedRoute) || 0) + 1);
    replayRouteCounts.set(replayRoute, (replayRouteCounts.get(replayRoute) || 0) + 1);

    if (recordedRoute === 'none') {
      noneCount += 1;
      topNoneMessages.set(normalizedMessage, (topNoneMessages.get(normalizedMessage) || 0) + 1);
    }

    if (recordedRoute !== replayRoute) {
      let category = 'routeDrift';
      if (recordedRoute === 'none' && replayRoute !== 'none') category = 'missedIntent';
      if (recordedRoute !== 'none' && replayRoute === 'none') category = 'replayNone';
      mismatchCounts[category] += 1;

      if (mismatchSamples.length < sampleLimit) {
        mismatchSamples.push({
          timestamp: toIsoOrNull(row.timestamp),
          message: truncateText(normalizedMessage, 180),
          recordedRoute,
          replayRoute,
          category,
        });
      }
    }
  }

  const mismatchTotal = mismatchCounts.missedIntent + mismatchCounts.routeDrift + mismatchCounts.replayNone;
  const noneRate = noPrefixRecords > 0 ? noneCount / noPrefixRecords : 0;
  const mismatchRate = noPrefixRecords > 0 ? mismatchTotal / noPrefixRecords : 0;

  const topNone = Array.from(topNoneMessages.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, sampleLimit)
    .map(([message, count]) => ({ message: truncateText(message, 180), count }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    windowHours,
    totalRecords,
    userRecordsInWindow: userRecords,
    prefixedRecordsInWindow: prefixedRecords,
    noPrefixRecords,
    noPrefixNoneCount: noneCount,
    noPrefixNoneRate: Number(noneRate.toFixed(6)),
    potentialMisclassificationCount: mismatchTotal,
    potentialMisclassificationRate: Number(mismatchRate.toFixed(6)),
    mismatchBreakdown: mismatchCounts,
    routeCounts: mapToSortedObject(routeCounts),
    replayRouteCounts: mapToSortedObject(replayRouteCounts),
    topNoneMessages: topNone,
    mismatchSamples,
  };
}

function formatPct(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function buildMarkdownReport(report, paths = {}) {
  const lines = [];
  lines.push('# No-prefix Routing Report');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- window: ${report.since} ~ ${report.until} (UTC)`);
  lines.push(`- input: ${paths.input || DEFAULT_INPUT_PATH}`);
  lines.push(`- user records (window): ${report.userRecordsInWindow}`);
  lines.push(`- prefixed records (window): ${report.prefixedRecordsInWindow}`);
  lines.push(`- no-prefix records: ${report.noPrefixRecords}`);
  lines.push(`- route=none: ${report.noPrefixNoneCount} (${formatPct(report.noPrefixNoneRate)})`);
  lines.push(`- potential misclassification: ${report.potentialMisclassificationCount} (${formatPct(report.potentialMisclassificationRate)})`);
  lines.push('- mismatch breakdown:');
  lines.push(`  - missedIntent: ${report.mismatchBreakdown.missedIntent}`);
  lines.push(`  - routeDrift: ${report.mismatchBreakdown.routeDrift}`);
  lines.push(`  - replayNone: ${report.mismatchBreakdown.replayNone}`);
  lines.push('');
  lines.push('## Recorded Route Counts (no-prefix)');
  for (const [route, count] of Object.entries(report.routeCounts || {})) {
    lines.push(`- ${route}: ${count}`);
  }
  if (Object.keys(report.routeCounts || {}).length === 0) {
    lines.push('- (none)');
  }
  lines.push('');
  lines.push('## Replay Route Counts (current inference)');
  for (const [route, count] of Object.entries(report.replayRouteCounts || {})) {
    lines.push(`- ${route}: ${count}`);
  }
  if (Object.keys(report.replayRouteCounts || {}).length === 0) {
    lines.push('- (none)');
  }
  lines.push('');
  lines.push('## Top route=none Messages');
  if (Array.isArray(report.topNoneMessages) && report.topNoneMessages.length > 0) {
    for (const row of report.topNoneMessages) {
      lines.push(`- (${row.count}) ${row.message}`);
    }
  } else {
    lines.push('- (none)');
  }
  lines.push('');
  lines.push('## Mismatch Samples');
  if (Array.isArray(report.mismatchSamples) && report.mismatchSamples.length > 0) {
    for (const row of report.mismatchSamples) {
      lines.push(`- [${row.category}] ${row.recordedRoute} -> ${row.replayRoute} | ${row.message}`);
    }
  } else {
    lines.push('- (none)');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function timestampTag(isoString) {
  return String(isoString || '')
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function saveReport(report, options = {}) {
  const outDir = path.resolve(String(options.outDir || DEFAULT_REPORT_DIR));
  const historyPath = path.resolve(String(options.history || DEFAULT_HISTORY_PATH));
  const latestJsonPath = path.join(outDir, 'no_prefix_routing_report_latest.json');
  const latestMdPath = path.join(outDir, 'no_prefix_routing_report_latest.md');
  const tag = timestampTag(report.generatedAt);
  const datedJsonPath = path.join(outDir, `no_prefix_routing_report_${tag}.json`);
  const datedMdPath = path.join(outDir, `no_prefix_routing_report_${tag}.md`);

  ensureDir(latestJsonPath);
  ensureDir(historyPath);

  fs.writeFileSync(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(datedJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  let latestMdOut = null;
  let datedMdOut = null;
  if (options.writeMd !== false) {
    const markdown = buildMarkdownReport(report, { input: options.input });
    fs.writeFileSync(latestMdPath, markdown, 'utf8');
    fs.writeFileSync(datedMdPath, markdown, 'utf8');
    latestMdOut = latestMdPath;
    datedMdOut = datedMdPath;
  }

  const historyRow = {
    generatedAt: report.generatedAt,
    windowHours: report.windowHours,
    noPrefixRecords: report.noPrefixRecords,
    noPrefixNoneCount: report.noPrefixNoneCount,
    noPrefixNoneRate: report.noPrefixNoneRate,
    potentialMisclassificationCount: report.potentialMisclassificationCount,
    potentialMisclassificationRate: report.potentialMisclassificationRate,
  };
  fs.appendFileSync(historyPath, `${JSON.stringify(historyRow)}\n`, 'utf8');

  return {
    latestJsonPath,
    latestMdPath: latestMdOut,
    datedJsonPath,
    datedMdPath: datedMdOut,
    historyPath,
  };
}

function run(options = {}) {
  const config = readJson(options.config || DEFAULT_CONFIG_PATH, {});
  const commandPrefixes = (config.commandPrefixes && typeof config.commandPrefixes === 'object')
    ? config.commandPrefixes
    : {};
  const naturalLanguageRouting = pickNaturalLanguageRouting(config.naturalLanguageRouting || {});
  const records = readJsonl(options.input || DEFAULT_INPUT_PATH);

  const report = computeNoPrefixRoutingReport(records, {
    now: options.now,
    since: options.since,
    until: options.until,
    windowHours: options.windowHours,
    sampleLimit: options.sampleLimit,
    commandPrefixes,
    naturalLanguageRouting,
  });

  const saved = saveReport(report, {
    outDir: options.outDir,
    history: options.history,
    input: options.input,
    writeMd: options.writeMd,
  });

  return {
    ok: true,
    input: path.resolve(String(options.input || DEFAULT_INPUT_PATH)),
    ...saved,
    summary: {
      noPrefixRecords: report.noPrefixRecords,
      noPrefixNoneCount: report.noPrefixNoneCount,
      noPrefixNoneRate: report.noPrefixNoneRate,
      potentialMisclassificationCount: report.potentialMisclassificationCount,
      potentialMisclassificationRate: report.potentialMisclassificationRate,
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = run(options);
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  readJsonl,
  detectExplicitPrefix,
  replayInferredRoute,
  computeNoPrefixRoutingReport,
  buildMarkdownReport,
  run,
};
