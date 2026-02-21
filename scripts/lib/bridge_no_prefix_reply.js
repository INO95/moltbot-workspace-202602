const NO_PREFIX_GUIDE_LINES = Object.freeze([
  '명령 프리픽스를 붙여주세요.',
  '',
  '자주 쓰는 형식:',
  '- 메모: 오늘 회고',
  '- 가계: 점심 1200엔',
  '- 투두: 추가 장보기',
  '- 루틴: 체크 물 2L',
  '- 운동: 러닝 30분 5km',
  '- 콘텐츠: 듄2 봤음 4.5점 #SF',
  '- 식당: 라멘집 가고싶음 #도쿄',
  '- 링크: 프롬프트',
  '- 상태: [옵션]',
  '- 운영: 액션: 페르소나; 대상: daily; 이름: Adelia; 톤: noble',
  '- 운영: 액션: 승인',
  '- 운영: 액션: 거부',
  '- 단어: 단어1',
  '- 작업: 요청: ...; 대상: ...; 완료기준: ...',
  '- 점검: 대상: ...; 체크항목: ...',
  '- 배포: 대상: ...; 환경: ...; 검증: ...',
  '- 프로젝트: 프로젝트명: ...; 목표: ...; 스택: ...; 경로: ...; 완료기준: ...',
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
