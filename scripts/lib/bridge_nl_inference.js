const path = require('path');

function normalizeMonthToken(rawValue) {
  const token = String(rawValue || '').trim();
  if (!token) return '';
  if (/^\d{4}-\d{2}$/.test(token)) return token;
  if (/^\d{6}$/.test(token)) return `${token.slice(0, 4)}-${token.slice(4, 6)}`;
  return '';
}

function extractMemoStatsPayload(text, deps = {}) {
  const normalizeMonthTokenFn = typeof deps.normalizeMonthToken === 'function'
    ? deps.normalizeMonthToken
    : normalizeMonthToken;
  const raw = String(text || '').trim();
  if (!raw) return null;
  const memoKeyword = /(메모장|메모|기록|일지|회고|저널|다이어리)/i.test(raw);
  const statsKeyword = /(통계|요약|summary|status)/i.test(raw);
  if (!memoKeyword || !statsKeyword) return null;

  const monthMatch = raw.match(/(20\d{2}-\d{2}|\d{6})/);
  const month = normalizeMonthTokenFn(monthMatch ? monthMatch[1] : '');
  return month ? `통계 ${month}` : '통계';
}

function isLikelyMemoJournalBlock(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!raw) return false;
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const hasRangeHint = /(?:^|\n)\s*\d{2}\d{2}\d{1,2}\s*[~\-]\s*\d{1,2}\s*(?:\n|$)/.test(raw);
  const dayHeaderCount = (raw.match(/(?:^|\n)\s*\d{1,2}\s*(월|화|수|목|금|토|일)(?:요일)?\s*(?:\n|$)/g) || []).length;
  if (hasRangeHint && dayHeaderCount >= 1) return true;
  if (dayHeaderCount >= 2) return true;
  return false;
}

function stripNaturalMemoLead(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  const stripped = raw
    .replace(/^(메모장|메모|기록|일지|회고|저널|다이어리)\s*(?:[:：]|으로|로|를|은|는)?\s*/i, '')
    .trim();
  return stripped || raw;
}

function inferMemoIntentPayload(text, deps = {}) {
  const extractMemoStatsPayloadFn = typeof deps.extractMemoStatsPayload === 'function'
    ? deps.extractMemoStatsPayload
    : extractMemoStatsPayload;
  const isLikelyMemoJournalBlockFn = typeof deps.isLikelyMemoJournalBlock === 'function'
    ? deps.isLikelyMemoJournalBlock
    : isLikelyMemoJournalBlock;
  const stripNaturalMemoLeadFn = typeof deps.stripNaturalMemoLead === 'function'
    ? deps.stripNaturalMemoLead
    : stripNaturalMemoLead;

  const raw = String(text || '').trim();
  if (!raw) return null;

  const statsPayload = extractMemoStatsPayloadFn(raw);
  if (statsPayload) return statsPayload;
  if (isLikelyMemoJournalBlockFn(raw)) return raw;

  const memoKeyword = /(메모장|메모|기록|일지|회고|저널|다이어리)/i.test(raw);
  const memoAction = /(저장|정리|집계|통계|분석|추가|남겨|반영|업데이트|던져|올려)/i.test(raw);
  if (memoKeyword && memoAction) {
    return stripNaturalMemoLeadFn(raw);
  }
  return null;
}

function inferFinanceIntentPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const hasFinanceKeyword = /(가계|가계부|지출|수입|환급|정산|이체|소비|입금|출금|결제|용돈|식비|교통비|월세|생활비|finance|expense|income|refund|budget)/i.test(raw);
  const hasMoneyToken = /(¥|￥|\$)\s*\d+|(?:\d[\d,]*(?:\.\d+)?)\s*(?:만엔|엔|円|jpy|원|krw|달러|usd|eur|유로)(?:\s|$)/i.test(raw);
  const hasFinanceVerb = /(기록|저장|추가|정리|요약|통계|내역|조회|보여|알려)/i.test(raw);
  const hasWorkoutSignal = /(운동|러닝|달리기|헬스|요가|수영|사이클|걷기)/i.test(raw);

  if (hasWorkoutSignal && !hasFinanceKeyword) return null;
  if (!hasFinanceKeyword && !hasMoneyToken) return null;
  if (!hasMoneyToken && !/(통계|요약|내역|목록|summary|list|status)/i.test(raw)) return null;
  if (!hasFinanceKeyword && !hasFinanceVerb && !hasMoneyToken) return null;

  return raw
    .replace(/^(가계부?|finance)\s*(?:로|에|를|는|은)?\s*/i, '')
    .trim() || raw;
}

function inferTodoIntentPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const hasTodoKeyword = /(투두|todo|to-do|할일|할 일|task|체크리스트)/i.test(raw);
  const hasTodoAction = /(추가|등록|완료|끝|체크|재개|다시|삭제|지움|목록|리스트|요약|통계|status|list|done|remove|open|add)/i.test(raw);

  if (hasTodoKeyword && hasTodoAction) {
    return raw
      .replace(/^(투두|todo|to-do|할일|할 일)\s*(?:로|에|를|는|은)?\s*/i, '')
      .trim() || raw;
  }

  if (/^(오늘\s*)?(할\s*일|해야\s*할\s*일)/i.test(raw)) {
    return raw;
  }

  return null;
}

function inferRoutineIntentPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const hasRoutineKeyword = /(루틴|습관|habit|routine|체크인)/i.test(raw);
  const hasRoutineAction = /(등록|추가|활성|비활성|켜|끄|체크|완료|오늘|목록|리스트|요약|통계|summary|status|check)/i.test(raw);

  if (!hasRoutineKeyword) return null;
  if (!hasRoutineAction && raw.length > 40) return null;

  return raw
    .replace(/^(루틴|습관)\s*(?:으로|로|에|를|는|은)?\s*/i, '')
    .trim() || raw;
}

function inferWorkoutIntentPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const hasWorkoutKeyword = /(운동|헬스|러닝|달리기|런닝|조깅|걷기|산책|웨이트|스쿼트|벤치|푸쉬업|요가|필라테스|수영|사이클|자전거|workout|run|running|gym|walk|swim|cycle)/i.test(raw);
  const hasWorkoutMetric = /(\d{1,4}\s*(분|min)|\d+(?:\.\d+)?\s*(km|킬로)|\d{2,5}\s*(kcal|칼로리))/i.test(raw);
  const hasFinanceOnlyToken = /(¥|￥|\$)\s*\d+|(?:\d[\d,]*(?:\.\d+)?)\s*(?:만엔|엔|円|jpy|원|krw|달러|usd|eur|유로)(?:\s|$)/i.test(raw);

  if (!hasWorkoutKeyword && !hasWorkoutMetric) return null;
  if (!hasWorkoutKeyword && !/(기록|완료|했다|했어|함|로그)/i.test(raw)) return null;
  if (hasFinanceOnlyToken && !hasWorkoutKeyword) return null;

  return raw
    .replace(/^(운동|workout)\s*(?:으로|로|을|를|은|는)?\s*/i, '')
    .trim() || raw;
}

function inferBrowserIntentPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const hasBrowserKeyword = /(브라우저|browser|웹자동화|web automation|openclaw browser|오픈클로 브라우저)/i.test(raw);
  const hasLookupIntent = /(찾아|검색|search|열어|접속|이동|보여|조회|확인|뭐\s*있|뭐있|추천|최신|인기|베스트|포텐)/i.test(raw);
  const hasLibraryIntent = /(라이브러리|library|스킬|skill|문서|docs?|도큐먼트)/i.test(raw);
  const hasCommunityIntent = /(펨코|fmkorea|포텐|디시|dcinside|갤러리|레딧|reddit|커뮤니티)/i.test(raw);
  if (!hasBrowserKeyword && !(hasLibraryIntent && hasLookupIntent) && !(hasCommunityIntent && hasLookupIntent)) return null;

  const urlMatch = raw.match(/https?:\/\/[^\s<>'"`]+/i);
  const keywordMatch = raw.match(/(?:키워드|keyword)\s*[:：]\s*([^\n;]+)/i);
  const keyword = String(keywordMatch && keywordMatch[1] ? keywordMatch[1] : '').trim();
  const wantsDocs = /(공식문서|문서|docs?)/i.test(raw);

  let targetUrl = String(urlMatch && urlMatch[0] ? urlMatch[0] : '').trim();
  if (!targetUrl) {
    if (/(펨코|fmkorea|포텐)/i.test(raw)) {
      targetUrl = 'https://www.fmkorea.com/best';
    } else if (/(디시|dcinside|갤러리)/i.test(raw) && /(특이점이\s*온다|thesingularity)/i.test(raw)) {
      targetUrl = 'https://gall.dcinside.com/mgallery/board/lists/?id=thesingularity';
    } else if (/(디시|dcinside|갤러리)/i.test(raw)) {
      targetUrl = 'https://gall.dcinside.com/';
    } else if (wantsDocs) {
      targetUrl = 'https://docs.openclaw.ai/';
    } else if (keyword) {
      targetUrl = `https://clawhub.com/search?q=${encodeURIComponent(keyword)}`;
    } else {
      targetUrl = 'https://clawhub.com/';
    }
  }

  return `액션: 브라우저; 작업: open; URL: ${targetUrl}`;
}

function inferScheduleIntentPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const hasCalendarKeyword = /(캘린더|calendar|일정|스케줄|schedule)/i.test(raw);
  if (!hasCalendarKeyword) return null;

  const hasLookupIntent = /(확인|조회|보여|열어|체크|check|show|list|what|뭐|알려)/i.test(raw);
  if (!hasLookupIntent) return null;

  return '액션: 일정; 동작: 조회';
}

function inferGogLookupIntentPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const hasGoogleSignal = /(구글|google|\bgog\b)/i.test(raw);
  if (!hasGoogleSignal) return null;
  if (/^\s*gog\b/i.test(raw)) return null;

  const hasLookupIntent = /(확인|조회|보여|최근|목록|내역|list|show|check|알려)/i.test(raw);
  if (!hasLookupIntent) return null;

  if (/(캘린더|calendar|일정|스케줄|schedule)/i.test(raw)) {
    return '액션: 일정; 작업: 조회';
  }
  if (/(메일|gmail|email|지메일)/i.test(raw)) {
    return '액션: 메일; 작업: 목록';
  }
  if (/(드라이브|drive)/i.test(raw)) {
    return '액션: 브라우저; 작업: open; URL: https://drive.google.com/drive/my-drive';
  }

  return null;
}

function inferStatusIntentPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const hasStatusKeyword = /(상태|현황|헬스|health|status|업타임|다운|장애|에러|오류|살아있|죽었|정상)/i.test(raw);
  if (!hasStatusKeyword) return null;

  const isDirectStatusQuery = /^(상태|현황|헬스|health|status)\b/i.test(raw);
  const hasOpsScope = /(봇|bot|서버|컨테이너|daily|데일리|dev|개발봇|anki|리서치|research|트렌드봇|오픈클로|openclaw|시스템|운영|서비스|프롬프트|prompt)/i.test(raw);
  if (!isDirectStatusQuery && !hasOpsScope) return null;

  if (/(전체|all|모든|봇들|bot들)/i.test(raw)) return 'all';
  if (/(데일리|daily)/i.test(raw)) return 'daily';
  if (/(리서치|research|트렌드봇)/i.test(raw)) return 'research';
  if (/(안키|anki)/i.test(raw)) return 'anki';
  if (/(개발봇|개발|dev)/i.test(raw)) return 'dev';
  if (/(프롬프트|prompt|웹앱|webapp|웹)/i.test(raw)) return 'prompt';
  if (/(터널|tunnel)/i.test(raw)) return 'tunnel';
  return '';
}

function inferLinkIntentPayload(text, deps = {}) {
  const isExternalLinkRequest = typeof deps.isExternalLinkRequest === 'function'
    ? deps.isExternalLinkRequest
    : null;
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/링크드인|linkedin/i.test(raw)) return null;
  if (isExternalLinkRequest && isExternalLinkRequest(raw)) return raw;

  const hasLinkKeyword = /(링크|url|주소|접속|도메인)/i.test(raw);
  if (!hasLinkKeyword) return null;
  const hasDeliveryVerb = /(줘|보내|알려|열어|확인|어디|뭐야|찾아)/i.test(raw);
  const hasOpsTarget = /(프롬프트|prompt|오픈클로|openclaw|웹앱|webapp|웹|web|대시보드|터널|tunnel|상태페이지|페이지)/i.test(raw);
  if (!(hasDeliveryVerb || hasOpsTarget)) return null;
  return raw;
}

function inferReportIntentPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const hasReportKeyword = /(리포트|report|보고서|브리핑|트렌드|동향|뉴스|소식|digest)/i.test(raw);
  if (!hasReportKeyword) return null;
  if (/(메모|기록|일지|회고|저널|다이어리)/i.test(raw) && /(통계|요약|summary|status)/i.test(raw)) {
    return null;
  }

  const hasActionVerb = /(줘|보내|작성|정리|만들|업데이트|발행|올려|요약)/i.test(raw);
  if (!hasActionVerb && raw.length > 40) return null;
  return raw;
}

function extractPreferredProjectBasePath(text, deps = {}) {
  const resolveWorkspaceRootHint = typeof deps.resolveWorkspaceRootHint === 'function'
    ? deps.resolveWorkspaceRootHint
    : () => '';
  const pathModule = deps.pathModule && typeof deps.pathModule.resolve === 'function'
    ? deps.pathModule
    : path;

  const raw = String(text || '').trim();
  if (!raw) return '';

  const workspaceRoot = resolveWorkspaceRootHint();
  const candidates = [];
  const seen = new Set();
  const pathMatches = raw.match(/(?:~\/|\/)[A-Za-z0-9._\-/]+/g) || [];
  for (const match of pathMatches) {
    let value = String(match || '').trim();
    if (!value) continue;
    value = value
      .replace(/^~\/\.openclaw\/workspace/i, workspaceRoot)
      .replace(/^\/home\/node\/\.openclaw\/workspace/i, workspaceRoot)
      .replace(/[),.;:]+$/g, '')
      .trim();
    if (!value || !pathModule.isAbsolute(value)) continue;
    const resolved = pathModule.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    candidates.push(resolved);
  }

  if (candidates.length === 0) return '';

  const preferred = candidates.find((value) => /\/users\/moltbot\/projects(?:\/|$)/i.test(value));
  if (preferred) return preferred;

  const projectsLike = candidates.find((value) => /\/projects(?:\/|$)/i.test(value));
  if (projectsLike) return projectsLike;

  return candidates[0];
}

function inferProjectIntentPayload(text, deps = {}) {
  const extractPreferredProjectBasePathFn = typeof deps.extractPreferredProjectBasePath === 'function'
    ? deps.extractPreferredProjectBasePath
    : (value) => extractPreferredProjectBasePath(value, deps);
  const loadLastProjectBootstrap = typeof deps.loadLastProjectBootstrap === 'function'
    ? deps.loadLastProjectBootstrap
    : null;
  const resolveDefaultProjectBasePath = typeof deps.resolveDefaultProjectBasePath === 'function'
    ? deps.resolveDefaultProjectBasePath
    : null;
  const toProjectTemplatePayload = typeof deps.toProjectTemplatePayload === 'function'
    ? deps.toProjectTemplatePayload
    : null;

  const raw = String(text || '').trim();
  if (!raw) return null;
  if (!resolveDefaultProjectBasePath || !toProjectTemplatePayload) return null;

  const explicitBasePath = extractPreferredProjectBasePathFn(raw);

  const installHereOnly = /^(여기에?\s*)?(설치해|설치|만들어|만들어봐|생성해|세팅해|초기화해)(줘)?$/i.test(raw)
    || /(여기에|여기|현재\s*경로|지금\s*경로).*(설치|생성|만들|초기화|세팅|setup|bootstrap)/i.test(raw);
  if (installHereOnly) {
    const last = loadLastProjectBootstrap ? loadLastProjectBootstrap() : null;
    if (last && last.fields) {
      const fields = {
        ...last.fields,
        경로: explicitBasePath || resolveDefaultProjectBasePath(),
      };
      return toProjectTemplatePayload(fields, { forceExecute: true });
    }
    return toProjectTemplatePayload({
      프로젝트명: 'rust-tap-game',
      목표: '모바일에서 실행 가능한 Rust 웹게임 템플릿 생성',
      스택: 'rust wasm web game',
      경로: explicitBasePath || resolveDefaultProjectBasePath(),
      완료기준: '프로젝트 폴더와 기본 Rust/WASM 파일 생성',
      초기화: 'execute',
    }, { forceExecute: true });
  }

  const hasProjectNoun = /(프로젝트|앱|app|웹앱|webapp|web app|게임|템플릿|boilerplate|scaffold)/i.test(raw);
  const hasBuildVerb = /(만들|생성|초기화|세팅|setup|bootstrap|설치|깔아|구축)/i.test(raw);
  if (!hasProjectNoun || !hasBuildVerb) return null;

  const rawNameMatch = raw.match(/(?:프로젝트명|이름|projectname|name)\s*[:：]?\s*([a-zA-Z0-9._-]{2,64})/i);
  const explicitName = rawNameMatch ? String(rawNameMatch[1] || '').trim() : '';
  const rustHint = /(rust|cargo|wasm|webassembly)/i.test(raw);
  const gameHint = /(게임|game|tap|터치)/i.test(raw);
  const defaultName = rustHint
    ? (gameHint ? 'rust-mobile-tap-game' : 'rust-wasm-app')
    : 'new-project';

  const fields = {
    프로젝트명: explicitName || defaultName,
    목표: raw.replace(/\s+/g, ' ').trim().slice(0, 220),
    스택: rustHint ? 'rust wasm web game' : 'web app',
    경로: explicitBasePath || resolveDefaultProjectBasePath(),
    완료기준: '프로젝트 폴더와 기본 실행 파일 생성',
    초기화: 'execute',
  };
  return toProjectTemplatePayload(fields, { forceExecute: true });
}

function inferNaturalLanguageRoute(text, options = {}, deps = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const routing = deps.NATURAL_LANGUAGE_ROUTING || {};
  const isHubRuntime = typeof deps.isHubRuntime === 'function' ? deps.isHubRuntime : () => false;
  const isResearchRuntime = typeof deps.isResearchRuntime === 'function' ? deps.isResearchRuntime : () => false;
  const normalizeIncomingCommandText = typeof deps.normalizeIncomingCommandText === 'function'
    ? deps.normalizeIncomingCommandText
    : (value) => String(value || '').trim();

  if (!routing.enabled) return null;
  if (routing.hubOnly && !isHubRuntime(env) && !isResearchRuntime(env)) return null;

  const normalized = normalizeIncomingCommandText(text) || String(text || '').trim();
  if (!normalized) return null;

  const inferMemo = typeof deps.inferMemoIntentPayload === 'function' ? deps.inferMemoIntentPayload : inferMemoIntentPayload;
  const inferFinance = typeof deps.inferFinanceIntentPayload === 'function' ? deps.inferFinanceIntentPayload : inferFinanceIntentPayload;
  const inferTodo = typeof deps.inferTodoIntentPayload === 'function' ? deps.inferTodoIntentPayload : inferTodoIntentPayload;
  const inferRoutine = typeof deps.inferRoutineIntentPayload === 'function' ? deps.inferRoutineIntentPayload : inferRoutineIntentPayload;
  const inferWorkout = typeof deps.inferWorkoutIntentPayload === 'function' ? deps.inferWorkoutIntentPayload : inferWorkoutIntentPayload;
  const inferBrowser = typeof deps.inferBrowserIntentPayload === 'function' ? deps.inferBrowserIntentPayload : inferBrowserIntentPayload;
  const inferSchedule = typeof deps.inferScheduleIntentPayload === 'function' ? deps.inferScheduleIntentPayload : inferScheduleIntentPayload;
  const inferGogLookup = typeof deps.inferGogLookupIntentPayload === 'function' ? deps.inferGogLookupIntentPayload : inferGogLookupIntentPayload;
  const inferStatus = typeof deps.inferStatusIntentPayload === 'function' ? deps.inferStatusIntentPayload : inferStatusIntentPayload;
  const inferLink = typeof deps.inferLinkIntentPayload === 'function' ? deps.inferLinkIntentPayload : inferLinkIntentPayload;
  const inferProject = typeof deps.inferProjectIntentPayload === 'function' ? deps.inferProjectIntentPayload : inferProjectIntentPayload;
  const inferReport = typeof deps.inferReportIntentPayload === 'function' ? deps.inferReportIntentPayload : inferReportIntentPayload;

  if (routing.inferMemo) {
    const payload = inferMemo(normalized);
    if (payload != null) {
      return { route: 'memo', payload, inferred: true, inferredBy: 'natural-language:memo' };
    }
  }
  if (routing.inferFinance) {
    const payload = inferFinance(normalized);
    if (payload != null) {
      return { route: 'finance', payload, inferred: true, inferredBy: 'natural-language:finance' };
    }
  }
  if (routing.inferTodo) {
    const payload = inferTodo(normalized);
    if (payload != null) {
      return { route: 'todo', payload, inferred: true, inferredBy: 'natural-language:todo' };
    }
  }
  if (routing.inferRoutine) {
    const payload = inferRoutine(normalized);
    if (payload != null) {
      return { route: 'routine', payload, inferred: true, inferredBy: 'natural-language:routine' };
    }
  }
  if (routing.inferWorkout) {
    const payload = inferWorkout(normalized);
    if (payload != null) {
      return { route: 'workout', payload, inferred: true, inferredBy: 'natural-language:workout' };
    }
  }
  if (routing.inferBrowser) {
    const payload = inferBrowser(normalized);
    if (payload != null) {
      return { route: 'ops', payload, inferred: true, inferredBy: 'natural-language:browser' };
    }
  }
  if (routing.inferSchedule) {
    const payload = inferSchedule(normalized);
    if (payload != null) {
      return { route: 'ops', payload, inferred: true, inferredBy: 'natural-language:schedule' };
    }
  }
  if (routing.inferSchedule) {
    const payload = inferGogLookup(normalized);
    if (payload != null) {
      return { route: 'ops', payload, inferred: true, inferredBy: 'natural-language:gog-lookup' };
    }
  }
  if (routing.inferStatus) {
    const payload = inferStatus(normalized);
    if (payload != null) {
      return { route: 'status', payload, inferred: true, inferredBy: 'natural-language:status' };
    }
  }
  if (routing.inferLink) {
    const payload = inferLink(normalized);
    if (payload != null) {
      return { route: 'link', payload, inferred: true, inferredBy: 'natural-language:link' };
    }
  }
  if (routing.inferProject) {
    const payload = inferProject(normalized);
    if (payload != null) {
      return { route: 'project', payload, inferred: true, inferredBy: 'natural-language:project' };
    }
  }
  if (routing.inferReport) {
    const payload = inferReport(normalized);
    if (payload != null) {
      return { route: 'report', payload, inferred: true, inferredBy: 'natural-language:report' };
    }
  }
  return null;
}

module.exports = {
  normalizeMonthToken,
  extractMemoStatsPayload,
  isLikelyMemoJournalBlock,
  stripNaturalMemoLead,
  inferMemoIntentPayload,
  inferFinanceIntentPayload,
  inferTodoIntentPayload,
  inferRoutineIntentPayload,
  inferWorkoutIntentPayload,
  inferBrowserIntentPayload,
  inferScheduleIntentPayload,
  inferGogLookupIntentPayload,
  inferStatusIntentPayload,
  inferLinkIntentPayload,
  inferReportIntentPayload,
  extractPreferredProjectBasePath,
  inferProjectIntentPayload,
  inferNaturalLanguageRoute,
};
