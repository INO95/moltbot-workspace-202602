function handleOpsTokenAction(parsed = {}, deps = {}) {
  const isUnifiedApprovalEnabled = deps.isUnifiedApprovalEnabled;
  const findApprovalTokenCandidates = deps.findApprovalTokenCandidates;

  if (typeof isUnifiedApprovalEnabled !== 'function') {
    throw new Error('isUnifiedApprovalEnabled dependency is required');
  }
  if (typeof findApprovalTokenCandidates !== 'function') {
    throw new Error('findApprovalTokenCandidates dependency is required');
  }

  if (!isUnifiedApprovalEnabled()) {
    return {
      route: 'ops',
      templateValid: true,
      success: true,
      action: 'token',
      results: [],
      telegramReply: '승인 토큰 제도는 현재 비활성화되어 있습니다.',
    };
  }

  const fields = parsed && parsed.fields && typeof parsed.fields === 'object'
    ? parsed.fields
    : {};
  const query = String(fields.식별자 || fields.토큰 || fields.작업 || fields.내용 || '').trim();
  const candidates = findApprovalTokenCandidates(query);
  if (candidates.length === 0) {
    return {
      route: 'ops',
      templateValid: true,
      success: false,
      action: 'token',
      errorCode: 'TOKEN_NOT_FOUND',
      telegramReply: query
        ? `토큰 조회 결과 없음: ${query}`
        : '현재 대기 중인 승인 토큰이 없습니다.',
    };
  }

  const lines = ['승인 토큰 조회 결과:'];
  for (const row of candidates.slice(0, 5)) {
    const reqId = String((row && row.request_id) || '').trim() || '(no request_id)';
    const actionType = String((row && row.action_type) || '').trim() || 'file_control';
    const expires = String((row && row.expires_at) || '').trim() || '(no expires)';
    lines.push(`- ${reqId}`);
    lines.push(`  action: ${actionType}`);
    lines.push(`  expires: ${expires}`);
  }
  lines.push('승인: `운영: 액션: 승인` / 거부: `운영: 액션: 거부`');
  return {
    route: 'ops',
    templateValid: true,
    success: true,
    action: 'token',
    query: query || null,
    results: candidates.slice(0, 5),
    telegramReply: lines.join('\n'),
  };
}

module.exports = {
  handleOpsTokenAction,
};
