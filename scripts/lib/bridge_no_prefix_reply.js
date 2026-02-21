const NO_PREFIX_GUIDE_LINES = Object.freeze([
  '자연어로 바로 요청하셔도 됩니다.',
  '',
  '자연어 예시:',
  '- 브릿지 라우터 리팩터링 작업해줘',
  '- 테스트 실패 원인 점검해줘',
  '- rust wasm 게임 템플릿 만들어줘',
  '- 메모장에 오늘 회고 저장해줘',
  '- 점심 1200엔 가계에 기록해줘',
  '- 데일리 봇 상태 알려줘',
  '- 웹앱 링크 보내줘',
  '',
  '기존 템플릿 형식(`작업:`, `점검:`, `프로젝트:`)도 계속 사용할 수 있습니다.',
]);

function normalizeInput(text, normalizeIncomingCommandText = null) {
  if (typeof normalizeIncomingCommandText === 'function') {
    const normalized = normalizeIncomingCommandText(text);
    if (String(normalized || '').trim()) return String(normalized).trim();
  }
  return String(text || '').trim();
}

function buildNoPrefixGuide() {
  return NO_PREFIX_GUIDE_LINES.join('\n');
}

function inferPathListReply(inputText, deps = {}) {
  const raw = normalizeInput(inputText, deps.normalizeIncomingCommandText);
  if (!raw) return '';
  const asksList = /(뭐\s*있|뭐있|무엇|내용|파일|폴더|목록|list|ls|show)/i.test(raw);
  if (!asksList) return '';
  if (typeof deps.extractPreferredProjectBasePath !== 'function') return '';
  if (typeof deps.readDirectoryListPreview !== 'function') return '';

  const targetPath = deps.extractPreferredProjectBasePath(raw);
  if (!targetPath) return '';
  const preview = deps.readDirectoryListPreview(targetPath);
  if (!preview) return '';
  return [
    `${targetPath} 안에는 지금 이게 있어:`,
    '',
    preview,
  ].join('\n');
}

function isLegacyPersonaSwitchAttempt(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return /(페르소나|캐릭터|인격|persona|character|모드)/i.test(raw);
}

function buildDailyCasualNoPrefixReply(inputText, deps = {}) {
  const normalized = normalizeInput(inputText, deps.normalizeIncomingCommandText);
  if (isLegacyPersonaSwitchAttempt(normalized)) {
    const personaStatus = typeof deps.buildPersonaStatusReply === 'function'
      ? deps.buildPersonaStatusReply({ route: 'none' })
      : '페르소나 상태를 확인할 수 없습니다.';
    return [
      personaStatus,
      '',
      '설정 변경: `운영: 액션: 페르소나; 대상: daily; 이름: Adelia; 톤: 귀족; 스타일: 조언중심`',
    ].join('\n');
  }
  const pathReply = inferPathListReply(normalized, deps);
  if (pathReply) return pathReply;
  return buildNoPrefixGuide();
}

function buildNoPrefixReply(inputText, options = {}, deps = {}) {
  const pathReply = typeof deps.inferPathListReply === 'function'
    ? deps.inferPathListReply(inputText)
    : inferPathListReply(inputText, deps);
  if (pathReply) return pathReply;
  if (options.isHubRuntime) {
    if (typeof deps.buildDailyCasualNoPrefixReply === 'function') {
      return deps.buildDailyCasualNoPrefixReply(inputText);
    }
    return buildDailyCasualNoPrefixReply(inputText, deps);
  }
  if (typeof deps.buildNoPrefixGuide === 'function') return deps.buildNoPrefixGuide();
  return buildNoPrefixGuide();
}

module.exports = {
  buildNoPrefixGuide,
  inferPathListReply,
  isLegacyPersonaSwitchAttempt,
  buildDailyCasualNoPrefixReply,
  buildNoPrefixReply,
};
