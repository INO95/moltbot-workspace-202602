function splitOpsBatchPayloads(payloadText) {
  const raw = String(payloadText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!raw) return [];

  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return [raw];

  const chunks = [];
  let current = '';
  for (const line of lines) {
    const stripped = line.replace(/^\s*(?:운영|ops)\s*[:：]\s*/i, '').trim();
    const hasOpsPrefix = stripped.length > 0 && stripped !== line;
    if (hasOpsPrefix) {
      if (current.trim()) chunks.push(current.trim());
      current = stripped;
      continue;
    }
    if (!current) {
      current = line;
      continue;
    }
    current += `\n${line}`;
  }
  if (current.trim()) chunks.push(current.trim());

  const looksLikeBatch = chunks.length > 1
    && chunks.every((chunk) => /(?:^|[;\n])\s*(?:액션|action)\s*[:：]/i.test(chunk));
  return looksLikeBatch ? chunks : [raw];
}

function runOpsCommand(payloadText, options = {}, deps = {}) {
  const runOpsCommandSingle = deps.runOpsCommandSingle;
  if (typeof runOpsCommandSingle !== 'function') {
    throw new Error('runOpsCommandSingle dependency is required');
  }
  const batchPayloads = splitOpsBatchPayloads(payloadText);
  if (batchPayloads.length <= 1) {
    return runOpsCommandSingle(batchPayloads[0] || payloadText, options);
  }

  const items = batchPayloads.map((entry) => runOpsCommandSingle(entry, options));
  const templateValid = items.every((item) => item && item.templateValid !== false);
  const success = items.every((item) => item && item.success !== false);
  const requestIds = items
    .map((item) => String((item && item.requestId) || '').trim())
    .filter(Boolean);
  const lines = [`운영 배치 요청 접수: ${items.length}건`];
  items.forEach((item, index) => {
    const capability = String((item && (item.capability || item.action)) || 'ops').trim();
    const capabilityAction = String((item && item.capabilityAction) || '').trim();
    const label = capabilityAction ? `${capability} ${capabilityAction.toUpperCase()}` : capability;
    const requestId = String((item && item.requestId) || '').trim();
    if (requestId) {
      const risk = String((item && item.riskTier) || '').trim();
      const approval = (item && typeof item.requiresApproval === 'boolean')
        ? `, approval=${item.requiresApproval ? 'required' : 'auto'}`
        : '';
      lines.push(`${index + 1}. ${label}: ${requestId}${risk ? ` (risk=${risk}${approval})` : approval ? ` (${approval.replace(/^,\s*/, '')})` : ''}`);
      return;
    }
    if (item && item.success === false) {
      const reason = String(item.error || item.errorCode || item.telegramReply || 'unknown error').trim();
      lines.push(`${index + 1}. 실패: ${label}${reason ? ` - ${reason}` : ''}`);
      return;
    }
    lines.push(`${index + 1}. ${label}`);
  });

  return {
    route: 'ops',
    templateValid,
    success,
    batch: true,
    items,
    requestIds,
    telegramReply: lines.join('\n'),
  };
}

module.exports = {
  splitOpsBatchPayloads,
  runOpsCommand,
};
