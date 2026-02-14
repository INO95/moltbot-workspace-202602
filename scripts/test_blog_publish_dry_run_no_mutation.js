const assert = require('assert');
const { execSync } = require('child_process');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function extractJsonPayload(text) {
  const raw = String(text || '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  const candidate = raw.slice(first, last + 1);
  return JSON.parse(candidate);
}

function runTest() {
  const before = run('git -C blog status --porcelain');
  const stdout = run('node scripts/blog_publish_from_reports.js --dry-run --hours 24');
  const after = run('git -C blog status --porcelain');

  assert.strictEqual(after, before, 'dry-run must not mutate blog working tree');

  const payload = extractJsonPayload(stdout);
  assert.strictEqual(payload.dryRun, true, 'dry-run response must include dryRun=true');
  assert.strictEqual(payload.mutated, false, 'dry-run response must include mutated=false');
  assert.ok(Array.isArray(payload.plannedPosts), 'dry-run response must include plannedPosts array');
  assert.ok(payload.syncPolicy && Array.isArray(payload.syncPolicy.categories), 'dry-run response must include syncPolicy.categories');
  assert.ok(payload.syncPolicy && Array.isArray(payload.syncPolicy.langs), 'dry-run response must include syncPolicy.langs');

  console.log('test_blog_publish_dry_run_no_mutation: ok');
}

runTest();
