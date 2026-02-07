const assert = require('assert');
const recovery = require('./health_recovery_engine');

function run() {
  const sessions = [
    { date: '2026-02-07', sportType: 'workout', areas: ['legs'] },
    { date: '2026-02-06', sportType: 'workout', areas: ['chest'] },
    { date: '2026-02-05', sportType: 'running', areas: ['cardio'] },
  ];

  const out = recovery.computeRecoveryFromSessions(sessions, '2026-02-08T12:00:00Z');
  assert.ok(out.byArea.legs);
  assert.ok(out.byArea.chest);
  assert.ok(out.byArea.cardio);
  assert.strictEqual(out.byArea.legs.ready, false);
  assert.strictEqual(out.byArea.legs.color, 'red');
  assert.strictEqual(out.byArea.chest.ready, true);
  assert.strictEqual(out.byArea.chest.color, 'green');
  assert.strictEqual(out.byArea.cardio.ready, true);

  const priorities = out.recommendations.map(x => x.area);
  assert.ok(priorities.includes('back'));
  console.log('test_health_recovery_engine: ok');
}

run();
