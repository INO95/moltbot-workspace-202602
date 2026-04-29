const assert = require('assert');
const { classifyScript } = require('./package_scripts_manifest');

function main() {
  assert.strictEqual(classifyScript('test:core', 'npm run -s test:ops'), 'test');
  assert.strictEqual(classifyScript('ops:dashboard', 'node scripts/ops_dashboard.js'), 'ops');
  assert.strictEqual(classifyScript('runtime:daily:status', 'node scripts/runtime_bot.js daily status'), 'runtime');
  assert.strictEqual(classifyScript('cron:daily:digest', 'node scripts/daily_telegram_digest.js'), 'cron');
  assert.strictEqual(classifyScript('anki:backfill:dry', 'node scripts/anki_backfill_quality.js'), 'anki');
  console.log('test_package_scripts_manifest: ok');
}

main();
