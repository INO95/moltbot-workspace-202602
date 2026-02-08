#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
  return {
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
    lines.push(`## ${s.ok ? 'OK' : 'FAIL'} - ${s.name}`);
    lines.push(`- command: \`${s.command}\``);
    lines.push(`- code: ${s.code}`);
    if (s.stderr) lines.push(`- stderr: \`${s.stderr.replace(/`/g, "'")}\``);
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const steps = [
    step('ops-worker', 'node', ['scripts/ops_host_worker.js']),
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

try {
  main();
} catch (e) {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
}
