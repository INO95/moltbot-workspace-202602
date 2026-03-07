#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readRecursiveImproveHealth } = require('./lib/recursive_improve_health');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const OUT_JSON = path.join(LOG_DIR, 'nightly_autopilot_latest.json');
const OUT_MD = path.join(LOG_DIR, 'nightly_autopilot_latest.md');

function nowIso() {
  return new Date().toISOString();
}

function run(cmd, args, envAdd = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    env: { ...process.env, ...envAdd },
  });
  return {
    ok: !res.error && res.status === 0,
    code: res.status == null ? 1 : res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function step(name, cmd, args, envAdd = {}) {
  const startedAt = nowIso();
  const r = run(cmd, args, envAdd);
  const endedAt = nowIso();
  const out = {
    name,
    command: [cmd, ...args].join(' '),
    startedAt,
    endedAt,
    ok: r.ok,
    code: r.code,
    stdout: r.stdout.slice(0, 4000),
    stderr: r.stderr.slice(0, 4000),
    error: r.error,
  };
  if (name === 'blog-publish-dry-run') {
    return normalizeBlogDryRunStep(out);
  }
  if (name === 'prompt-web-health') {
    return normalizePromptWebHealthStep(out);
  }
  return out;
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
  } catch {
    return null;
  }
}

function normalizeBlogDryRunStep(stepResult) {
  const parsed = extractJsonPayload(stepResult.stdout) || extractJsonPayload(stepResult.stderr);
  if (!parsed || typeof parsed !== 'object') return stepResult;
  const reason = String(parsed.reason || '').trim().toLowerCase();
  const skipReasonsAsOk = new Set(['no_recent_reports', 'policy_filtered']);
  if (parsed.skipped === true && skipReasonsAsOk.has(reason)) {
    return {
      ...stepResult,
      ok: true,
      code: 0,
      normalized: true,
      normalizedReason: reason,
    };
  }
  return stepResult;
}

function normalizePromptWebHealthStep(stepResult) {
  const parsed = extractJsonPayload(stepResult.stderr) || extractJsonPayload(stepResult.stdout);
  if (!parsed || typeof parsed !== 'object') return stepResult;
  const classification = String(parsed.classification || '').trim().toLowerCase();
  if (classification === 'service_absent') {
    return {
      ...stepResult,
      ok: true,
      code: 0,
      normalized: true,
      normalizedReason: 'service_absent',
    };
  }
  return stepResult;
}

function summarize(report) {
  const failed = report.steps.filter((s) => !s.ok);
  const ok = report.steps.length - failed.length;
  return {
    ...report,
    summary: {
      total: report.steps.length,
      ok,
      failed: failed.length,
      failedNames: failed.map((f) => f.name),
    },
  };
}

function buildRecursiveImproveHealthStep(root = ROOT, options = {}) {
  const startedAt = nowIso();
  const health = readRecursiveImproveHealth(root, options);
  const endedAt = nowIso();
  const ok = Boolean(health.exists && health.ok && health.fresh);
  const summary = {
    ok,
    exists: health.exists,
    fresh: health.fresh,
    runAt: health.runAt,
    ageMinutes: health.ageMinutes,
    consecutiveFailures: health.consecutiveFailures,
    preflightRepaired: health.preflightRepaired,
    prAttempted: health.prAttempted,
    prUrl: health.prUrl,
    shouldEscalate: health.shouldEscalate,
    failureCode: health.failureCode,
    nextAction: health.nextAction,
    summaryLine: health.summaryLine,
    path: health.path,
  };
  const stderr = ok
    ? ''
    : (health.exists ? (health.error || health.summaryLine) : 'midnight recursive improve report missing');

  return {
    name: 'recursive-improve-health',
    command: 'internal:read logs/midnight_recursive_improve_latest.json',
    startedAt,
    endedAt,
    ok,
    code: ok ? 0 : 1,
    stdout: JSON.stringify(summary, null, 2).slice(0, 4000),
    stderr: String(stderr || '').slice(0, 4000),
    error: '',
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push(`# Nightly Autopilot`);
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- total: ${report.summary.total}`);
  lines.push(`- ok: ${report.summary.ok}`);
  lines.push(`- failed: ${report.summary.failed}`);
  if (report.summary.failedNames.length) {
    lines.push(`- failedNames: ${report.summary.failedNames.join(', ')}`);
  }
  lines.push('');
  for (const s of report.steps) {
    const label = s.ok ? (s.normalized ? 'OK (normalized)' : 'OK') : 'FAIL';
    lines.push(`## ${label} - ${s.name}`);
    lines.push(`- command: \`${s.command}\``);
    lines.push(`- code: ${s.code}`);
    if (s.normalizedReason) lines.push(`- normalizedReason: ${s.normalizedReason}`);
    if (s.stderr) lines.push(`- stderr: \`${s.stderr.replace(/`/g, "'")}\``);
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const steps = [
    step('ops-worker', 'node', ['scripts/ops_host_worker.js']),
    buildRecursiveImproveHealthStep(ROOT),
    step('tunnel-status', 'node', ['scripts/dev_tunnel.js', 'status']),
    step('prompt-web-health', 'node', ['scripts/prompt_web_healthcheck.js'], { SKIP_OPS_WORKER: '1', SKIP_AUTOPILOT_TRIGGER: '1' }),
    step('seo-audit', 'node', ['scripts/seo_optimizer_bot.js']),
    step('backlink-status', 'node', ['scripts/backlink_outreach_bot.js', 'status']),
    step('blog-publish-dry-run', 'node', ['scripts/blog_publish_from_reports.js', '--dry-run', '--hours', '24']),
    step('notion-sync-dashboard', 'node', ['scripts/notion_sync_dashboard.js']),
    step('model-cost-latency', 'node', ['scripts/model_cost_latency_dashboard.js']),
  ];

  const report = summarize({
    generatedAt: nowIso(),
    mode: 'nightly-autopilot',
    policy: 'low-cost-local-first',
    steps,
  });

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(OUT_MD, toMarkdown(report), 'utf8');

  console.log(JSON.stringify({
    ok: report.summary.failed === 0,
    outJson: OUT_JSON,
    outMd: OUT_MD,
    summary: report.summary,
  }, null, 2));

  if (report.summary.failed > 0) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = {
  run,
  step,
  buildRecursiveImproveHealthStep,
  extractJsonPayload,
  normalizeBlogDryRunStep,
  normalizePromptWebHealthStep,
  summarize,
  toMarkdown,
};
