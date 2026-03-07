#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DASHBOARD_JSON_PATH = path.join(ROOT, 'logs', 'model_cost_latency_dashboard_latest.json');

function run(label, cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`[${label}] ${result.stderr || result.stdout || 'unknown error'}`);
  }
  return {
    label,
    cmd,
    args,
    stdout: String(result.stdout || '').trim(),
  };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function summarizeDashboard(dashboard) {
  if (!dashboard) return null;
  const routes = dashboard.routes || {};
  const sessions = dashboard.sessions || {};
  const promptBudget = dashboard.promptBudget || {};
  const sessionRotation = dashboard.sessionRotation || {};
  return {
    generatedAt: dashboard.generatedAt || null,
    defaultModel: dashboard.runtime && dashboard.runtime.defaultModel,
    totalRouteEvents: routes.total || 0,
    otherRouteEvents: (routes.byRoute || routes.counts || {}).other || 0,
    totalSessionTokens: sessions.totalTokens || 0,
    injectedWorkspaceChars: promptBudget.injectedWorkspaceChars || 0,
    toolSchemaChars: promptBudget.toolSchemaChars || 0,
    skillsPromptChars: promptBudget.skillsPromptChars || 0,
    rotationRecommended: Boolean(sessionRotation.recommended),
    rotationReason: sessionRotation.reason || '',
  };
}

function main() {
  const before = summarizeDashboard(readJsonIfExists(DASHBOARD_JSON_PATH));
  const steps = [
    run('prompt-budget', 'node', ['scripts/check_prompt_budget.js']),
    run('profile-templates', 'node', ['scripts/check_openclaw_profile_templates.js']),
    run('config-sync-apply', 'bash', ['scripts/openclaw_sync_runtime_config.sh', '--apply']),
    run('codex-sync-restart', 'node', ['scripts/openclaw_codex_sync.js', '--profiles', 'dev,anki,research,daily,codex', '--restart']),
    run('ops-worker', 'node', ['scripts/ops_host_worker.js']),
    run('cost-latency-dashboard', 'node', ['scripts/model_cost_latency_dashboard.js']),
  ];
  const after = summarizeDashboard(readJsonIfExists(DASHBOARD_JSON_PATH));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    before,
    after,
    steps: steps.map((step) => ({
      label: step.label,
      cmd: [step.cmd, ...step.args].join(' '),
    })),
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}
