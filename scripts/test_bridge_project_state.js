const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  writeJsonFileSafe,
  readJsonFileSafe,
  saveLastProjectBootstrap,
  loadLastProjectBootstrap,
  resolveDefaultProjectBasePath,
  toProjectTemplatePayload,
} = require('./lib/bridge_project_state');

function testReadWriteJson() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-project-state-'));
  try {
    const filePath = path.join(tmpRoot, 'state', 'snapshot.json');
    const payload = { ok: true, n: 1 };
    assert.strictEqual(writeJsonFileSafe(filePath, payload), true);
    assert.deepStrictEqual(readJsonFileSafe(filePath), payload);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testSaveAndLoadBootstrap() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-project-bootstrap-'));
  const statePath = path.join(tmpRoot, 'bootstrap.json');
  try {
    const saved = saveLastProjectBootstrap({
      프로젝트명: 'demo',
      목표: 'test',
      스택: 'node',
      경로: '/tmp/demo',
      완료기준: 'done',
    }, {
      projectName: 'demo',
      targetPath: '/tmp/demo',
      template: 'ts',
      templateLabel: 'TypeScript',
      initMode: 'execute',
      pathPolicy: { allowed: true },
    }, {
      statePath,
      writeJsonFileSafe: (p, row) => writeJsonFileSafe(p, row),
      nowIso: () => '2026-02-21T00:00:00.000Z',
    });
    assert.strictEqual(saved, true);

    const loaded = loadLastProjectBootstrap(48, {
      statePath,
      readJsonFileSafe: (p) => readJsonFileSafe(p),
      nowMs: () => Date.parse('2026-02-21T06:00:00.000Z'),
    });
    assert.ok(loaded);
    assert.strictEqual(loaded.fields.프로젝트명, 'demo');
    assert.strictEqual(loaded.bootstrap.pathAllowed, true);

    const stale = loadLastProjectBootstrap(1, {
      statePath,
      readJsonFileSafe: (p) => readJsonFileSafe(p),
      nowMs: () => Date.parse('2026-02-21T06:00:00.000Z'),
    });
    assert.strictEqual(stale, null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testResolveDefaultProjectBasePath() {
  assert.strictEqual(resolveDefaultProjectBasePath(), '/Users/inho-baek/Projects');
}

function testProjectTemplatePayload() {
  const payload = toProjectTemplatePayload({
    프로젝트명: 'Hello World',
    목표: '템플릿 생성',
    스택: 'rust wasm',
    경로: '/tmp/proj',
    완료기준: '빌드 성공',
    초기화: 'plan',
  }, {
    forceExecute: true,
  }, {
    sanitizeProjectName: (name) => String(name).trim().toLowerCase().replace(/\s+/g, '-'),
    resolveDefaultProjectBasePath: () => '/Users/inho-baek/Projects',
  });
  assert.ok(payload.includes('프로젝트명: hello-world'));
  assert.ok(payload.includes('경로: /tmp/proj'));
  assert.ok(payload.includes('초기화: execute'));
}

function main() {
  testReadWriteJson();
  testSaveAndLoadBootstrap();
  testResolveDefaultProjectBasePath();
  testProjectTemplatePayload();
  console.log('test_bridge_project_state: ok');
}

main();
