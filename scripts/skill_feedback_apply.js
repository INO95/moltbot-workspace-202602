#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FEEDBACK_QUEUE_PATH = process.env.SKILL_FEEDBACK_QUEUE_PATH
  ? path.resolve(String(process.env.SKILL_FEEDBACK_QUEUE_PATH))
  : path.join(ROOT, 'data', 'skill', 'feedback_queue.jsonl');
const MOLT_SKILL_PATH = path.join(ROOT, 'skills', 'moltbot', 'SKILL.md');
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');
const PORTFOLIO_TEMPLATE_PATH = path.join(ROOT, 'notes', 'PORTFOLIO_CONTENT_TEMPLATE.md');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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

function writeJsonl(filePath, rows) {
  ensureDir(filePath);
  const text = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, text ? `${text}\n` : '', 'utf8');
}

function ensureTextBlock(filePath, marker, block) {
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (original.includes(marker)) return { changed: false, filePath };
  const suffix = original.endsWith('\n') ? '' : '\n';
  const next = `${original}${suffix}\n${marker}\n${block.trim()}\n`;
  fs.writeFileSync(filePath, next, 'utf8');
  return { changed: true, filePath };
}

function applySkillRevisionLoop() {
  return ensureTextBlock(
    MOLT_SKILL_PATH,
    '<!-- skill-revision-loop:auto -->',
    [
      '### Automated Revision Trigger',
      '- Trigger source: `ops_host_worker` periodic run + `skill_feedback_loop` queue.',
      '- Approval/apply command (single entrypoint): `npm run -s skill:feedback:apply -- --id <feedback_id>`',
      '- If patch is applied, summarize the changed rule in the next response so behavior is corrected immediately.',
    ].join('\n'),
  );
}

function applyConversationRoutingGuard() {
  const cfg = readJson(CONFIG_PATH, {});
  cfg.commandPrefixes = cfg.commandPrefixes || {};
  cfg.commandAllowlist = cfg.commandAllowlist || {};
  cfg.commandAllowlist.autoRoutes = Array.isArray(cfg.commandAllowlist.autoRoutes)
    ? cfg.commandAllowlist.autoRoutes
    : [];

  let changed = false;
  if (!cfg.commandPrefixes.memo) {
    cfg.commandPrefixes.memo = '메모:';
    changed = true;
  }
  if (!cfg.commandPrefixes.record) {
    cfg.commandPrefixes.record = '기록:';
    changed = true;
  }
  if (!cfg.commandAllowlist.autoRoutes.includes('memo')) {
    cfg.commandAllowlist.autoRoutes.push('memo');
    changed = true;
  }
  if (!cfg.commandAllowlist.enabled && cfg.commandAllowlist.enabled !== true) {
    cfg.commandAllowlist.enabled = true;
    changed = true;
  }
  if (changed) writeJson(CONFIG_PATH, cfg);
  return { changed, filePath: CONFIG_PATH };
}

function applyNotionGovernanceGuard() {
  const cfg = readJson(CONFIG_PATH, {});
  cfg.governance = cfg.governance || {};
  let changed = false;
  if (cfg.governance.requireApprovalForAllNotionWrites !== true) {
    cfg.governance.requireApprovalForAllNotionWrites = true;
    changed = true;
  }
  if (cfg.governance.allowDbMetaMutation !== false) {
    cfg.governance.allowDbMetaMutation = false;
    changed = true;
  }
  if (changed) writeJson(CONFIG_PATH, cfg);
  return { changed, filePath: CONFIG_PATH };
}

function applyPortfolioStructureTemplate() {
  const block = [
    '# Portfolio Content Template',
    '',
    '## Business Impact',
    '- What changed in measurable terms (time, cost, quality, risk).',
    '',
    '## Reliability Metrics',
    '- Error rate, recovery time, and operational guardrails.',
    '',
    '## Trade-offs',
    '- Why this design was selected and what was intentionally deferred.',
    '',
    '## 90-day Evolution Plan',
    '- What to harden next and how to validate impact.',
  ].join('\n');
  if (fs.existsSync(PORTFOLIO_TEMPLATE_PATH)) {
    const current = fs.readFileSync(PORTFOLIO_TEMPLATE_PATH, 'utf8');
    if (current.includes('## Business Impact') && current.includes('## 90-day Evolution Plan')) {
      return { changed: false, filePath: PORTFOLIO_TEMPLATE_PATH };
    }
  }
  ensureDir(PORTFOLIO_TEMPLATE_PATH);
  fs.writeFileSync(PORTFOLIO_TEMPLATE_PATH, `${block}\n`, 'utf8');
  return { changed: true, filePath: PORTFOLIO_TEMPLATE_PATH };
}

function applyGeneralFallback() {
  return ensureTextBlock(
    MOLT_SKILL_PATH,
    '<!-- skill-general-fallback:auto -->',
    [
      '### Error Handling Standard',
      '- When a result is wrong, include: (1) repro input, (2) expected output format, (3) corrected command.',
      '- Do not repeat the same failed path without a changed hypothesis.',
    ].join('\n'),
  );
}

function applySuggestion(suggestion) {
  const key = String(suggestion && suggestion.key || '').trim();
  if (key === 'skill-revision-loop') return applySkillRevisionLoop();
  if (key === 'conversation-routing') return applyConversationRoutingGuard();
  if (key === 'notion-governance') return applyNotionGovernanceGuard();
  if (key === 'portfolio-structure') return applyPortfolioStructureTemplate();
  if (key === 'general-fallback') return applyGeneralFallback();
  return { changed: false, filePath: '', skipped: true, reason: `unsupported key: ${key}` };
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const command = String(args[0] || 'list').trim().toLowerCase();
  const out = { command, id: '', applyAll: false };
  for (let i = 1; i < args.length; i += 1) {
    const token = String(args[i] || '').trim();
    if (token === '--id' && args[i + 1]) {
      out.id = String(args[i + 1]).trim();
      i += 1;
      continue;
    }
    if (token === '--all') {
      out.applyAll = true;
      continue;
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = readJsonl(FEEDBACK_QUEUE_PATH);

  if (opts.command === 'list') {
    const pending = rows.filter((row) => String(row.status || '') === 'pending_approval');
    console.log(JSON.stringify({
      ok: true,
      command: 'list',
      total: rows.length,
      pending: pending.length,
      pendingItems: pending.map((row) => ({
        id: row.id,
        key: row.suggestion && row.suggestion.key,
        title: row.suggestion && row.suggestion.title,
        createdAt: row.createdAt || null,
      })),
    }, null, 2));
    return;
  }

  if (opts.command !== 'apply') {
    throw new Error('Usage: node scripts/skill_feedback_apply.js <list|apply> [--id <feedback_id>|--all]');
  }

  const targets = rows.filter((row) => String(row.status || '') === 'pending_approval')
    .filter((row) => opts.applyAll || (opts.id && String(row.id || '') === opts.id));

  if (!targets.length) {
    console.log(JSON.stringify({
      ok: true,
      command: 'apply',
      applied: 0,
      reason: 'no_matching_pending_feedback',
    }, null, 2));
    return;
  }

  const results = [];
  const now = new Date().toISOString();
  for (const row of rows) {
    if (!targets.includes(row)) continue;
    const patchResult = applySuggestion(row.suggestion || {});
    row.approvedAt = row.approvedAt || now;
    row.approvalMode = row.approvalMode || 'cli';
    row.status = patchResult.skipped ? 'skipped' : 'applied';
    row.appliedAt = now;
    row.applyResult = patchResult;
    results.push({
      id: row.id,
      key: row.suggestion && row.suggestion.key,
      status: row.status,
      changed: Boolean(patchResult.changed),
      filePath: patchResult.filePath || null,
      reason: patchResult.reason || '',
    });
  }

  writeJsonl(FEEDBACK_QUEUE_PATH, rows);
  console.log(JSON.stringify({
    ok: true,
    command: 'apply',
    applied: results.length,
    results,
    queuePath: FEEDBACK_QUEUE_PATH,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
