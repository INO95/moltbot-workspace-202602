const PERSONAL_ROUTES = new Set(['finance', 'todo', 'routine', 'workout', 'media', 'place']);

async function buildStructuredRouteResponse(route, payload, options = {}, deps = {}) {
  const parsed = deps.parseStructuredCommand(route, payload);
  const telegramReply = deps.appendExternalLinks(parsed.telegramReply || '');
  const degradedMode = deps.buildCodexDegradedMeta();
  const response = {
    route,
    templateValid: parsed.ok,
    ...parsed,
    telegramReply,
    degradedMode,
    preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
    preferredReasoning: options.preferredReasoning || 'high',
    routeHint: options.routeHint || route,
  };
  if (options.includeDuelMode) {
    response.duelMode = deps.buildDuelModeMeta();
  }
  return deps.withApiMeta(response, {
    route,
    routeHint: options.routeHint || route,
    commandText: payload,
    templateFields: parsed.fields || {},
  });
}

async function handleReportRoute(routed, input = {}, deps = {}) {
  const payloadRaw = String(routed.payload || '').trim();
  const payload = payloadRaw.toLowerCase();
  const forceTrendOnResearch = deps.isResearchRuntime(input.env || process.env);

  if (payload.includes('블로그')) {
    const res = await deps.publishFromReports();
    return deps.withApiMeta({
      route: 'report',
      action: 'blog-publish',
      ...res,
      telegramReply: deps.appendExternalLinks('리포트 완료'),
      preferredModelAlias: 'fast',
      preferredReasoning: 'low',
      routeHint: 'report-blog-publish',
    }, {
      route: 'report',
      routeHint: 'report-blog-publish',
      commandText: routed.payload,
    });
  }

  if (payload.includes('주간')) {
    const res = await deps.buildWeeklyReport();
    return deps.withApiMeta({
      route: 'report',
      action: 'weekly',
      ...res,
      telegramReply: deps.appendExternalLinks('리포트 완료'),
      preferredModelAlias: 'fast',
      preferredReasoning: 'low',
      routeHint: 'report-weekly',
    }, {
      route: 'report',
      routeHint: 'report-weekly',
      commandText: routed.payload,
    });
  }

  const shouldRunTrend = forceTrendOnResearch
    || !payload
    || payload.includes('지금요약')
    || payload.includes('요약')
    || payload.includes('상태')
    || payload.includes('이벤트')
    || payload.includes('키워드')
    || payload.includes('소스')
    || payload.includes('트렌드')
    || payload.includes('테크');

  if (shouldRunTrend) {
    try {
      const normalizedPayload = deps.normalizeReportNewsPayload(payloadRaw || '지금요약');
      const result = await deps.handleNewsCommand(normalizedPayload);
      const modelMeta = deps.pickPreferredModelMeta(result, 'fast', 'low');
      return deps.withApiMeta({
        route: 'report',
        action: 'tech-trend',
        ...result,
        ...modelMeta,
        routeHint: 'report-tech-trend',
      }, {
        route: 'report',
        routeHint: 'report-tech-trend',
        commandText: normalizedPayload,
      });
    } catch (error) {
      return deps.withApiMeta({
        route: 'report',
        success: false,
        errorCode: error && error.code ? error.code : 'REPORT_TREND_ROUTE_LOAD_FAILED',
        error: String(error && error.message ? error.message : error),
        telegramReply: `리포트(테크 트렌드) 처리 실패: ${error && error.message ? error.message : error}`,
        preferredModelAlias: 'fast',
        preferredReasoning: 'low',
        routeHint: 'report-tech-trend',
      }, {
        route: 'report',
        routeHint: 'report-tech-trend',
        commandText: routed.payload,
      });
    }
  }

  const res = await deps.buildDailySummary();
  return deps.withApiMeta({
    route: 'report',
    action: 'daily',
    ...res,
    telegramReply: deps.appendExternalLinks('리포트 완료'),
    preferredModelAlias: 'fast',
    preferredReasoning: 'low',
    routeHint: 'report-daily',
  }, {
    route: 'report',
    routeHint: 'report-daily',
    commandText: routed.payload,
  });
}

async function handleAutoRoutedCommand(input = {}, deps = {}) {
  const routed = input.routed && typeof input.routed === 'object' ? input.routed : { route: 'none', payload: '' };
  const route = String(routed.route || '').trim().toLowerCase();
  const fullText = String(input.fullText || '').trim();
  const payload = routed.payload || '';
  const commandText = payload || fullText;

  if (route === 'memo') {
    try {
      const memoResult = await deps.handleMemoCommand(commandText);
      const legacyLogged = typeof memoResult.logged === 'boolean'
        ? memoResult.logged
        : Boolean(memoResult && memoResult.success);
      return deps.withApiMeta({
        route: 'memo',
        preferredModelAlias: 'fast',
        preferredReasoning: 'low',
        logged: legacyLogged,
        ...memoResult,
      }, {
        route: 'memo',
        routeHint: 'memo-journal',
        commandText,
      });
    } catch (error) {
      return deps.withApiMeta({
        route: 'memo',
        success: false,
        errorCode: error && error.code ? error.code : 'MEMO_ROUTE_LOAD_FAILED',
        error: String(error && error.message ? error.message : error),
        telegramReply: `메모 처리 실패: ${error && error.message ? error.message : error}`,
        preferredModelAlias: 'fast',
        preferredReasoning: 'low',
        logged: false,
      }, {
        route: 'memo',
        routeHint: 'memo-journal',
        commandText,
      });
    }
  }

  if (PERSONAL_ROUTES.has(route)) {
    const out = await deps.handlePersonalRoute(route, commandText, { source: 'telegram' });
    return deps.withApiMeta(out, {
      route,
      commandText,
    });
  }

  if (route === 'word') {
    const wordResult = await deps.processWordTokens(payload, input.toeicDeck, input.toeicTags, {
      source: 'telegram',
      rawText: fullText,
    });
    return deps.withApiMeta({
      route,
      preferredModelAlias: 'gpt',
      preferredReasoning: 'high',
      ...wordResult,
    }, {
      route,
      commandText: payload,
    });
  }

  if (route === 'news') {
    try {
      const normalizedPayload = deps.normalizeNewsCommandPayload(payload);
      const result = await deps.handleNewsCommand(normalizedPayload);
      const modelMeta = deps.pickPreferredModelMeta(result, 'fast', 'low');
      return deps.withApiMeta({
        route,
        ...result,
        ...modelMeta,
      }, {
        route,
        commandText: normalizedPayload,
      });
    } catch (error) {
      return deps.withApiMeta({
        route,
        success: false,
        errorCode: error && error.code ? error.code : 'NEWS_ROUTE_LOAD_FAILED',
        error: String(error && error.message ? error.message : error),
        telegramReply: `소식 모듈 로드 실패: ${error && error.message ? error.message : error}`,
        preferredModelAlias: 'fast',
        preferredReasoning: 'low',
      }, {
        route,
        commandText: payload,
      });
    }
  }

  if (route === 'report') {
    return handleReportRoute(routed, input, deps);
  }

  if (route === 'work') {
    return buildStructuredRouteResponse('work', payload, {
      routeHint: 'complex-workload',
      preferredReasoning: 'high',
      includeDuelMode: true,
    }, deps);
  }

  if (route === 'inspect') {
    return buildStructuredRouteResponse('inspect', payload, {
      routeHint: 'inspection',
      preferredReasoning: 'medium',
      includeDuelMode: false,
    }, deps);
  }

  if (route === 'deploy') {
    return buildStructuredRouteResponse('deploy', payload, {
      routeHint: 'deployment',
      preferredReasoning: 'high',
      includeDuelMode: false,
    }, deps);
  }

  if (route === 'project') {
    const parsed = deps.parseStructuredCommand('project', payload);
    const payloadData = deps.buildProjectRoutePayload(parsed);
    const degradedMode = deps.buildCodexDegradedMeta();
    const routeHint = 'project-bootstrap';
    return deps.withApiMeta({
      ...payloadData,
      route,
      degradedMode,
      preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
      preferredReasoning: 'high',
      routeHint,
    }, {
      route,
      routeHint,
      commandText: payload,
      templateFields: parsed.fields || {},
    });
  }

  if (route === 'prompt') {
    const out = deps.handlePromptPayload(payload);
    if (out && out.telegramReply) {
      out.telegramReply = deps.appendExternalLinks(out.telegramReply);
    }
    return deps.withApiMeta({
      route: 'prompt',
      ...out,
    }, {
      route: 'prompt',
      commandText: payload,
    });
  }

  if (route === 'link') {
    const reply = deps.buildLinkOnlyReply(payload || '링크');
    return deps.withApiMeta({
      route: 'link',
      success: true,
      telegramReply: reply,
      preferredModelAlias: 'fast',
      preferredReasoning: 'low',
    }, {
      route: 'link',
      commandText: payload,
    });
  }

  if (route === 'status') {
    return deps.withApiMeta({
      route: 'status',
      success: true,
      telegramReply: deps.buildQuickStatusReply(payload),
      preferredModelAlias: 'fast',
      preferredReasoning: 'low',
    }, {
      route: 'status',
      commandText: payload,
    });
  }

  if (route === 'ops') {
    const telegramContext = deps.parseTransportEnvelopeContext(fullText);
    const out = deps.runOpsCommand(payload, {
      rawText: fullText,
      telegramContext,
    });
    if (out && out.telegramReply) {
      out.telegramReply = deps.appendExternalLinks(out.telegramReply);
    }
    return deps.withApiMeta(out, {
      route: 'ops',
      commandText: payload,
    });
  }

  if (route === 'none') {
    const noPrefixInput = payload || fullText;
    const pathReply = deps.inferPathListReply(noPrefixInput);
    const gogGuideReply = deps.buildGogNoPrefixGuide(noPrefixInput);
    const noPrefixReply = pathReply || gogGuideReply || deps.buildNoPrefixReply(noPrefixInput);
    return deps.withApiMeta({
      route: 'none',
      skipped: fullText,
      preferredModelAlias: 'fast',
      preferredReasoning: 'low',
      telegramReply: deps.appendExternalLinks(noPrefixReply),
    }, {
      route: 'none',
      commandText: fullText,
    });
  }

  return deps.withApiMeta({
    route: 'none',
    skipped: fullText,
  }, {
    route: 'none',
    commandText: fullText,
  });
}

module.exports = {
  handleAutoRoutedCommand,
};
