const assert = require('assert');
const parser = require('./health_ingest_parser');

function run() {
  const running = parser.parseCaptureInput('Indoor Run 2026/01/30 Distance 5.66km 338kcal 42min');
  assert.strictEqual(running.ok, true);
  assert.strictEqual(running.sessions.length, 1);
  assert.strictEqual(running.sessions[0].sportType, 'running');
  assert.strictEqual(running.sessions[0].distanceKm, 5.66);
  assert.strictEqual(running.sessions[0].calories, 338);
  assert.strictEqual(running.sessions[0].durationMin, 42);
  assert.ok(running.sessions[0].areas.includes('cardio'));

  const workout = parser.parseCaptureInput('하체 어깨 2026.01.31 61min 8230kg 23sets 285reps 267kcal');
  assert.strictEqual(workout.ok, true);
  assert.strictEqual(workout.sessions.length, 1);
  assert.strictEqual(workout.sessions[0].sportType, 'workout');
  assert.strictEqual(workout.sessions[0].volumeKg, 8230);
  assert.strictEqual(workout.sessions[0].sets, 23);
  assert.strictEqual(workout.sessions[0].reps, 285);
  assert.ok(workout.sessions[0].areas.includes('legs'));
  assert.ok(workout.sessions[0].areas.includes('shoulders'));

  const structured = parser.parseCaptureInput({
    date: '2026-02-08',
    sportType: 'running',
    distanceKm: 10,
    durationMin: 55,
    calories: 600,
    notes: 'zone2',
  });
  assert.strictEqual(structured.ok, true);
  assert.strictEqual(structured.sessions.length, 1);
  assert.strictEqual(structured.sessions[0].date, '2026-02-08');
  assert.strictEqual(structured.sessions[0].sportType, 'running');
  assert.strictEqual(structured.sessions[0].distanceKm, 10);

  console.log('test_health_ingest_parser: ok');
}

run();
