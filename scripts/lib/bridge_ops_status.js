function normalizeOpsStateBucket(state, statusText) {
  const stateRaw = String(state || '').trim().toLowerCase();
  const statusRaw = String(statusText || '').trim().toLowerCase();
  if (stateRaw === 'running' || /^up\b/.test(statusRaw)) return 'running';
  if (stateRaw === 'restarting' || /^restarting\b/.test(statusRaw)) return 'restarting';
  if (stateRaw === 'paused') return 'paused';
  if (stateRaw === 'created') return 'created';
  if (stateRaw === 'exited' || stateRaw === 'dead' || statusRaw === 'not-running' || /\bexited\b/.test(statusRaw)) return 'stopped';
  if (statusRaw === 'not-found') return 'missing';
  return 'unknown';
}

function buildOpsStatusRowsFromDocker(rawLines, targets) {
  const map = new Map();
  for (const line of String(rawLines || '').split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const name = String(parts[0] || '').trim();
    const state = String(parts[1] || '').trim();
    const status = String(parts.slice(2).join('\t') || '').trim() || state || 'unknown';
    if (!name) continue;
    map.set(name, { name, state, statusText: status });
  }

  return (Array.isArray(targets) ? targets : []).map((name) => {
    const row = map.get(name);
    if (!row) {
      return {
        name,
        state: 'missing',
        statusText: 'not-found',
      };
    }
    return {
      name: row.name,
      state: normalizeOpsStateBucket(row.state, row.statusText),
      statusText: row.statusText,
    };
  });
}

function buildOpsStatusRowsFromSnapshot(snapshot, targets) {
  const map = new Map();
  for (const row of (Array.isArray(snapshot && snapshot.containers) ? snapshot.containers : [])) {
    const name = String((row && row.name) || '').trim();
    if (!name) continue;
    const status = String((row && row.status) || '').trim() || 'unknown';
    map.set(name, { name, statusText: status });
  }

  return (Array.isArray(targets) ? targets : []).map((name) => {
    const row = map.get(name);
    if (!row) {
      return {
        name,
        state: 'missing',
        statusText: 'not-found',
      };
    }
    return {
      name: row.name,
      state: normalizeOpsStateBucket('', row.statusText),
      statusText: row.statusText,
    };
  });
}

function buildOpsStatusReply(rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (safeRows.length === 0) return '운영 상태: 대상 정보가 없습니다.';

  const counts = {
    running: 0,
    restarting: 0,
    paused: 0,
    created: 0,
    stopped: 0,
    missing: 0,
    unknown: 0,
  };
  for (const row of safeRows) {
    const bucket = String((row && row.state) || 'unknown');
    counts[bucket] = (counts[bucket] || 0) + 1;
  }

  const summary = [
    `running ${counts.running}`,
    `stopped ${counts.stopped}`,
    `missing ${counts.missing}`,
    counts.restarting > 0 ? `restarting ${counts.restarting}` : '',
    counts.paused > 0 ? `paused ${counts.paused}` : '',
    counts.created > 0 ? `created ${counts.created}` : '',
    counts.unknown > 0 ? `unknown ${counts.unknown}` : '',
  ].filter(Boolean).join(', ');
  const title = options.snapshotUpdatedAt
    ? `운영 상태(스냅샷 ${options.snapshotUpdatedAt}):`
    : '운영 상태:';
  const lines = [
    title,
    `- 요약: ${summary}`,
    ...safeRows.map((row) => `- ${row.name}: ${row.statusText}`),
  ];
  if (options.tunnelUrl) {
    lines.push(`- tunnel-url: ${options.tunnelUrl}`);
  }
  return lines.join('\n');
}

module.exports = {
  normalizeOpsStateBucket,
  buildOpsStatusRowsFromDocker,
  buildOpsStatusRowsFromSnapshot,
  buildOpsStatusReply,
};
