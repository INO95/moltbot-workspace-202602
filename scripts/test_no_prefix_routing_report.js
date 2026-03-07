const assert = require('assert');
const { computeNoPrefixRoutingReport } = require('./no_prefix_routing_report');

function main() {
  const rows = [
    {
      timestamp: '2026-02-21T10:00:00.000Z',
      source: 'user',
      route: 'work',
      message: '브릿지 라우터 리팩터링해줘',
    },
    {
      timestamp: '2026-02-21T10:01:00.000Z',
      source: 'user',
      route: 'none',
      message: '테스트 실패 원인 점검해줘',
    },
    {
      timestamp: '2026-02-21T10:02:00.000Z',
      source: 'user',
      route: 'none',
      message: '오늘 뭐 먹지',
    },
    {
      timestamp: '2026-02-21T10:03:00.000Z',
      source: 'user',
      route: 'project',
      message: '프로젝트: 프로젝트명: demo; 목표: 테스트; 스택: rust; 경로: /tmp; 완료기준: 실행',
    },
    {
      timestamp: '2026-02-21T10:04:00.000Z',
      source: 'internal',
      route: 'none',
      message: 'internal ping',
    },
  ];

  const report = computeNoPrefixRoutingReport(rows, {
    now: '2026-02-21T12:00:00.000Z',
    windowHours: 24,
    sampleLimit: 8,
    commandPrefixes: {},
    naturalLanguageRouting: {
      enabled: true,
      hubOnly: false,
      inferMemo: true,
      inferFinance: true,
      inferTodo: true,
      inferRoutine: true,
      inferWorkout: true,
      inferPersona: true,
      inferBrowser: true,
      inferSchedule: true,
      inferStatus: true,
      inferLink: true,
      inferWork: true,
      inferInspect: true,
      inferReport: true,
      inferProject: true,
    },
  });

  assert.strictEqual(report.userRecordsInWindow, 4);
  assert.strictEqual(report.prefixedRecordsInWindow, 1);
  assert.strictEqual(report.noPrefixRecords, 3);
  assert.strictEqual(report.noPrefixNoneCount, 2);
  assert.ok(report.noPrefixNoneRate > 0.66 && report.noPrefixNoneRate < 0.67);
  assert.strictEqual(report.potentialMisclassificationCount, 1);
  assert.strictEqual(report.mismatchBreakdown.missedIntent, 1);
  assert.strictEqual(report.mismatchBreakdown.routeDrift, 0);
  assert.strictEqual(report.mismatchBreakdown.replayNone, 0);
  assert.strictEqual(report.routeCounts.none, 2);
  assert.strictEqual(report.routeCounts.work, 1);
  assert.ok(Array.isArray(report.mismatchSamples) && report.mismatchSamples.length === 1);
  assert.strictEqual(report.mismatchSamples[0].recordedRoute, 'none');
  assert.strictEqual(report.mismatchSamples[0].replayRoute, 'inspect');

  console.log('test_no_prefix_routing_report: ok');
}

main();
