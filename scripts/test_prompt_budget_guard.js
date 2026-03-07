const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROMPT_BUDGET_CAPS,
  collectPromptBudgetViolations,
} = require('./check_prompt_budget');

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-budget-'));
  fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), 'a'.repeat(PROMPT_BUDGET_CAPS['AGENTS.md'] + 1), 'utf8');
  fs.writeFileSync(path.join(tempDir, 'IDENTITY.md'), 'ok', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'HEARTBEAT.md'), 'ok', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'TOOLS.md'), 'ok', 'utf8');

  const violations = collectPromptBudgetViolations(tempDir);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].name, 'AGENTS.md');

  console.log('test_prompt_budget_guard: ok');
}

main();
