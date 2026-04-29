#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const DOCKER_TARGETS = Object.freeze([
  { id: 'daily', container: 'moltbot-daily' },
  { id: 'dev', container: 'moltbot-dev' },
  { id: 'anki', container: 'moltbot-anki' },
  { id: 'research', container: 'moltbot-research' },
]);

function safeStat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (_) {
    return null;
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readJsonl(filePath, limit = 500) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit);
    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function countFiles(dirPath, predicate = () => true) {
  const stat = safeStat(dirPath);
  if (!stat || !stat.isDirectory()) return 0;
  try {
    return fs.readdirSync(dirPath)
      .filter((name) => predicate(path.join(dirPath, name), name))
      .length;
  } catch (_) {
    return 0;
  }
}

function dirSizeBytes(dirPath) {
  const stat = safeStat(dirPath);
  if (!stat) return 0;
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    total += dirSizeBytes(path.join(dirPath, entry));
  }
  return total;
}

function summarizeStateFiles() {
  const relPaths = [
    'ops/state/state.json',
    'ops/state/issues.json',
    'ops/state/leader_snapshot_latest.json',
    'logs/nightly_autopilot_latest.json',
    'logs/cron_guard_latest.json',
    'logs/notion_sync_dashboard_latest.json',
    'logs/model_cost_latency_dashboard_latest.json',
  ];
  return relPaths.map((relPath) => {
    const filePath = path.join(ROOT, relPath);
    const stat = safeStat(filePath);
    return {
      path: relPath,
      exists: Boolean(stat && stat.isFile()),
      sizeBytes: stat && stat.isFile() ? stat.size : 0,
      mtime: stat && stat.isFile() ? stat.mtime.toISOString() : null,
    };
  });
}

function dockerStatus(container) {
  const res = spawnSync('docker', [
    'ps',
    '-a',
    '--filter',
    `name=^/${container}$`,
    '--format',
    '{{json .}}',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return {
      dockerOk: false,
      status: 'unknown',
      raw: '',
    };
  }
  const line = String(res.stdout || '').split(/\r?\n/).map((v) => v.trim()).find(Boolean);
  if (!line) {
    return {
      dockerOk: true,
      status: 'missing',
      raw: '',
    };
  }
  const parsed = readJsonFromString(line);
  return {
    dockerOk: true,
    status: String((parsed && parsed.Status) || 'unknown'),
    raw: parsed || line,
  };
}

function readJsonFromString(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function assessOpsDashboardHealth(payload) {
  const reasons = [];
  let score = 0;

  function bump(nextScore, reason) {
    score = Math.max(score, nextScore);
    if (reason) reasons.push(reason);
  }

  const queues = payload.queues || {};
  if (Number(queues.outbox || 0) > 0 || Number(queues.pending || 0) > 0) {
    bump(1, `운영 큐 대기: outbox=${queues.outbox || 0}, pending=${queues.pending || 0}`);
  }
  if (Number(queues.pendingApprovals || 0) > 0) {
    bump(1, `승인 대기 ${queues.pendingApprovals}건`);
  }

  const recentFailures = Array.isArray(payload.recentFailures) ? payload.recentFailures : [];
  if (recentFailures.length >= 5) {
    bump(2, `최근 실패 ${recentFailures.length}건`);
  } else if (recentFailures.length > 0) {
    bump(1, `최근 실패 ${recentFailures.length}건`);
  }

  const docker = Array.isArray(payload.docker) ? payload.docker : [];
  const unhealthyDocker = docker.filter((row) => {
    const status = String(row && row.status ? row.status : '').trim();
    return !row || row.dockerOk === false || !/^up\b/i.test(status);
  });
  if (unhealthyDocker.length > 0) {
    bump(2, `Docker 상태 확인 필요: ${unhealthyDocker.map((row) => row.id || row.container || 'unknown').join(', ')}`);
  }

  const stateFiles = Array.isArray(payload.stateFiles) ? payload.stateFiles : [];
  const requiredStateFiles = new Set(['ops/state/state.json', 'ops/state/issues.json']);
  const missingRequiredState = stateFiles.filter((row) => requiredStateFiles.has(row.path) && !row.exists);
  if (missingRequiredState.length > 0) {
    bump(1, `주요 상태 파일 없음: ${missingRequiredState.map((row) => row.path).join(', ')}`);
  }

  const artifactSizes = payload.artifactSizes || {};
  const totalArtifacts = Number(artifactSizes.logsBytes || 0)
    + Number(artifactSizes.reportsBytes || 0)
    + Number(artifactSizes.opsBytes || 0);
  if (totalArtifacts > 500 * 1024 * 1024) {
    bump(1, `런타임 산출물 500MB 초과: ${totalArtifacts} bytes`);
  }

  const level = score >= 2 ? 'danger' : score === 1 ? 'warning' : 'ok';
  const label = level === 'danger' ? '위험' : level === 'warning' ? '주의' : '정상';
  return {
    level,
    label,
    reasons,
  };
}

function compactOpsDashboard(payload) {
  return {
    ...payload,
    docker: Array.isArray(payload.docker)
      ? payload.docker.map((row) => ({
        id: row.id,
        container: row.container,
        dockerOk: row.dockerOk,
        status: row.status,
      }))
      : [],
  };
}

function buildOpsDashboard() {
  const resultsPath = path.join(ROOT, 'ops', 'commands', 'results.jsonl');
  const results = readJsonl(resultsPath, 1000);
  const failures = results
    .filter((row) => row && row.ok === false)
    .slice(-10)
    .reverse()
    .map((row) => ({
      requestId: row.request_id || null,
      finishedAt: row.finished_at || null,
      commandKind: row.command_kind || null,
      action: row.action || row.intent_action || null,
      errorCode: row.error_code || row.errorCode || null,
    }));

  const commandsRoot = path.join(ROOT, 'ops', 'commands');
  const outboxDir = path.join(commandsRoot, 'outbox');
  const pendingDir = path.join(commandsRoot, 'state', 'pending');
  const approvalsPath = path.join(ROOT, 'data', 'state', 'pending_approvals.json');
  const pendingApprovals = readJson(approvalsPath, {});
  const approvalCount = pendingApprovals && typeof pendingApprovals === 'object'
    ? Object.keys(pendingApprovals).length
    : 0;

  const docker = DOCKER_TARGETS.map((target) => ({
    id: target.id,
    container: target.container,
    ...dockerStatus(target.container),
  }));

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    recentFailures: failures,
    queues: {
      outbox: countFiles(outboxDir, (filePath, name) => name.endsWith('.json')),
      pending: countFiles(pendingDir),
      pendingApprovals: approvalCount,
    },
    stateFiles: summarizeStateFiles(),
    artifactSizes: {
      logsBytes: dirSizeBytes(path.join(ROOT, 'logs')),
      reportsBytes: dirSizeBytes(path.join(ROOT, 'reports')),
      opsBytes: dirSizeBytes(path.join(ROOT, 'ops')),
    },
    docker,
  };
  payload.health = assessOpsDashboardHealth(payload);
  return payload;
}

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    full: argv.includes('--full'),
  };
}

function printText(payload) {
  console.log('ops dashboard');
  console.log(`generated: ${payload.generatedAt}`);
  console.log(`health: ${payload.health.label} (${payload.health.level})`);
  if (payload.health.reasons.length > 0) {
    console.log('health reasons:');
    for (const reason of payload.health.reasons.slice(0, 5)) {
      console.log(`- ${reason}`);
    }
  }
  console.log(`queue outbox: ${payload.queues.outbox}`);
  console.log(`queue pending: ${payload.queues.pending}`);
  console.log(`pending approvals: ${payload.queues.pendingApprovals}`);
  console.log(`recent failures: ${payload.recentFailures.length}`);
  console.log(`artifact sizes: logs=${payload.artifactSizes.logsBytes} reports=${payload.artifactSizes.reportsBytes} ops=${payload.artifactSizes.opsBytes}`);
  console.log('docker:');
  for (const row of payload.docker) {
    console.log(`- ${row.id}: ${row.status}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = buildOpsDashboard();
  if (args.json) {
    console.log(JSON.stringify(args.full ? payload : compactOpsDashboard(payload), null, 2));
  } else {
    printText(payload);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  assessOpsDashboardHealth,
  buildOpsDashboard,
  compactOpsDashboard,
};
