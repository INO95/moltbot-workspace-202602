const assert = require('assert');
const { assessOpsDashboardHealth, compactOpsDashboard } = require('./ops_dashboard');

function makePayload(overrides = {}) {
  return {
    queues: {
      outbox: 0,
      pending: 0,
      pendingApprovals: 0,
    },
    recentFailures: [],
    stateFiles: [
      { path: 'ops/state/state.json', exists: true },
      { path: 'ops/state/issues.json', exists: true },
    ],
    artifactSizes: {
      logsBytes: 1,
      reportsBytes: 1,
      opsBytes: 1,
    },
    docker: [
      { id: 'daily', dockerOk: true, status: 'Up 1 minute' },
      { id: 'dev', dockerOk: true, status: 'Up 1 minute' },
    ],
    ...overrides,
  };
}

function main() {
  const ok = assessOpsDashboardHealth(makePayload());
  assert.strictEqual(ok.level, 'ok');
  assert.strictEqual(ok.label, '정상');

  const warning = assessOpsDashboardHealth(makePayload({
    queues: {
      outbox: 0,
      pending: 0,
      pendingApprovals: 2,
    },
  }));
  assert.strictEqual(warning.level, 'warning');
  assert.strictEqual(warning.label, '주의');

  const danger = assessOpsDashboardHealth(makePayload({
    recentFailures: [{}, {}, {}, {}, {}],
  }));
  assert.strictEqual(danger.level, 'danger');
  assert.strictEqual(danger.label, '위험');

  const dockerDanger = assessOpsDashboardHealth(makePayload({
    docker: [
      { id: 'daily', dockerOk: false, status: 'unknown' },
    ],
  }));
  assert.strictEqual(dockerDanger.level, 'danger');

  const compact = compactOpsDashboard(makePayload({
    docker: [
      { id: 'daily', container: 'moltbot-daily', dockerOk: true, status: 'Up', raw: { large: true } },
    ],
  }));
  assert.deepStrictEqual(compact.docker, [
    { id: 'daily', container: 'moltbot-daily', dockerOk: true, status: 'Up' },
  ]);

  console.log('test_ops_dashboard: ok');
}

main();
