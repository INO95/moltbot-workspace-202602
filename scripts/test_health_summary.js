const assert = require('assert');
const fs = require('fs');
const path = require('path');
const health = require('./health_service');

function run() {
  const dbDir = path.join(__dirname, '../data/tmp');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `health_test_${Date.now()}.sqlite`);

  health.init(dbPath);
  health.ingest(dbPath, {
    source: 'test',
    text: 'Indoor Run 2026/01/30 Distance 5.66km 338kcal 42min',
  });
  health.ingest(dbPath, {
    source: 'test',
    text: '가슴 삼두 2026.02.01 46min 5268kg 15sets 204reps 185kcal',
  });

  const today = health.getToday(dbPath, '2026-02-01');
  assert.ok(today.sessions.length >= 1);

  const monthly = health.getSummary(dbPath, { period: 'month', refDate: '2026-02-10' });
  assert.ok(monthly.running.sessions >= 0);
  assert.ok(monthly.workout.sessions >= 1);
  assert.ok(typeof monthly.comment === 'string');

  const recovery = health.getRecovery(dbPath, '2026-02-10T09:00:00Z');
  assert.ok(recovery.byArea.chest);

  console.log('test_health_summary: ok');
}

run();
