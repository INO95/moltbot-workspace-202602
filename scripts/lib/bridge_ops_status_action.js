function handleOpsStatusAction({
  action = 'status',
  targetKey = '',
} = {}, deps = {}) {
  const allowedTargets = deps.allowedTargets;
  const execDocker = deps.execDocker;
  const isDockerPermissionError = deps.isDockerPermissionError;
  const readOpsSnapshot = deps.readOpsSnapshot;
  const getTunnelPublicBaseUrl = deps.getTunnelPublicBaseUrl;
  const buildOpsStatusRowsFromSnapshot = deps.buildOpsStatusRowsFromSnapshot;
  const buildOpsStatusRowsFromDocker = deps.buildOpsStatusRowsFromDocker;
  const buildOpsStatusReply = deps.buildOpsStatusReply;

  if (!allowedTargets || typeof allowedTargets !== 'object') {
    throw new Error('allowedTargets dependency is required');
  }
  if (typeof execDocker !== 'function'
      || typeof isDockerPermissionError !== 'function'
      || typeof readOpsSnapshot !== 'function'
      || typeof getTunnelPublicBaseUrl !== 'function'
      || typeof buildOpsStatusRowsFromSnapshot !== 'function'
      || typeof buildOpsStatusRowsFromDocker !== 'function'
      || typeof buildOpsStatusReply !== 'function') {
    throw new Error('handleOpsStatusAction dependencies are incomplete');
  }

  if (!targetKey || !allowedTargets[targetKey]) {
    return {
      route: 'ops',
      templateValid: false,
      error: '지원하지 않는 대상입니다.',
      telegramReply: '운영 대상은 dev/anki/research/daily/codex/dev_bak/anki_bak/research_bak/daily_bak/proxy/webproxy/tunnel/prompt/web/all 만 지원합니다. (legacy: main/sub1 지원)',
    };
  }
  const targets = Array.isArray(allowedTargets[targetKey])
    ? allowedTargets[targetKey]
    : [allowedTargets[targetKey]];
  const ps = execDocker(['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}']);

  if (!ps.ok) {
    if (isDockerPermissionError(ps.stderr || ps.error)) {
      const snap = readOpsSnapshot();
      const tunnelUrl = targetKey === 'tunnel' || targetKey === 'all' ? getTunnelPublicBaseUrl() : null;
      if (snap && Array.isArray(snap.containers)) {
        const rows = buildOpsStatusRowsFromSnapshot(snap, targets);
        return {
          route: 'ops',
          templateValid: true,
          success: true,
          action,
          target: targetKey,
          source: 'snapshot',
          snapshotUpdatedAt: snap.updatedAt || null,
          results: rows.map((row) => `${row.name}\t${row.statusText}`),
          rows,
          telegramReply: buildOpsStatusReply(rows, {
            snapshotUpdatedAt: snap.updatedAt || '',
            tunnelUrl,
          }),
        };
      }
    }
    return {
      route: 'ops',
      templateValid: true,
      success: false,
      action,
      target: targetKey,
      telegramReply: `운영 상태 조회 실패: ${ps.stderr || ps.error || 'unknown error'}`,
    };
  }

  const rows = buildOpsStatusRowsFromDocker(ps.stdout, targets);
  const tunnelUrl = targetKey === 'tunnel' || targetKey === 'all' ? getTunnelPublicBaseUrl() : null;
  return {
    route: 'ops',
    templateValid: true,
    success: true,
    action,
    target: targetKey,
    results: rows.map((row) => `${row.name}\t${row.statusText}`),
    rows,
    telegramReply: buildOpsStatusReply(rows, { tunnelUrl }),
  };
}

module.exports = {
  handleOpsStatusAction,
};
