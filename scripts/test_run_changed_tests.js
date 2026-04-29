const assert = require('assert');
const { planChangedTests } = require('./run_changed_tests');

function main() {
  const plan = planChangedTests([
    'scripts/anki_connect.js',
    'scripts/ops_dashboard.js',
    'package.json',
  ]);
  assert.deepStrictEqual(plan.commands, [
    'npm run -s test:scope:anki',
    'npm run -s test:ops',
    'npm run -s check:scripts',
  ]);

  const fallback = planChangedTests(['README.md']);
  assert.deepStrictEqual(fallback.commands, ['npm run -s test:smoke']);

  const empty = planChangedTests([]);
  assert.deepStrictEqual(empty.commands, []);

  console.log('test_run_changed_tests: ok');
}

main();
