#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const PROMPT_BUDGET_CAPS = Object.freeze({
  'AGENTS.md': 3500,
  'IDENTITY.md': 1200,
  'HEARTBEAT.md': 900,
  'TOOLS.md': 1000,
});

function collectPromptBudgetViolations(rootDir) {
  const root = path.resolve(rootDir || path.join(__dirname, '..'));
  const files = [];
  for (const [name, maxChars] of Object.entries(PROMPT_BUDGET_CAPS)) {
    const filePath = path.join(root, name);
    const chars = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').length : 0;
    files.push({
      name,
      path: filePath,
      chars,
      maxChars,
      ok: chars <= maxChars,
    });
  }
  return files.filter((row) => !row.ok);
}

function main() {
  const root = process.argv[2] || path.join(__dirname, '..');
  const violations = collectPromptBudgetViolations(root);
  if (violations.length > 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, violations }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, caps: PROMPT_BUDGET_CAPS }, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  PROMPT_BUDGET_CAPS,
  collectPromptBudgetViolations,
};
