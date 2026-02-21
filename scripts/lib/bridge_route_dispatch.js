function listPrefixes(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchPrefix(rawInput, rawPrefix) {
  const input = String(rawInput || '');
  const prefix = String(rawPrefix || '').trim();
  if (!prefix) return null;

  // Support variants like "링크: ...", "링크 : ...", "링크：...", and optionally no-colon form.
  const colonMatch = prefix.match(/^(.*?)[：:]$/);
  if (colonMatch) {
    const stem = String(colonMatch[1] || '').trim();
    if (!stem) return null;
    // No-colon form must keep a word boundary so "메모장", "작업으로" don't match "메모:", "작업:".
    const re = new RegExp(`^\\s*${escapeRegExp(stem)}(?:\\s*[:：]\\s*|(?=\\s|$)\\s*)`, 'i');
    const m = input.match(re);
    return m ? m[0].length : null;
  }
  const re = new RegExp(`^\\s*${escapeRegExp(prefix)}\\s+`, 'i');
  const m = input.match(re);
  return m ? m[0].length : null;
}

function buildRoutingRules(prefixes = {}) {
  return [
    { route: 'word', prefixes: listPrefixes(prefixes.word || '단어:').concat(listPrefixes(prefixes.learn || '학습:')) },
    { route: 'memo', prefixes: listPrefixes(prefixes.memo || '메모:').concat(listPrefixes(prefixes.record || '기록:')) },
    { route: 'finance', prefixes: listPrefixes(prefixes.finance || '가계:').concat(listPrefixes(prefixes.ledger || '가계부:')) },
    { route: 'todo', prefixes: listPrefixes(prefixes.todo || '투두:').concat(listPrefixes(prefixes.task || '할일:')) },
    { route: 'routine', prefixes: listPrefixes(prefixes.routine || '루틴:') },
    { route: 'workout', prefixes: listPrefixes(prefixes.workout || '운동:') },
    { route: 'media', prefixes: listPrefixes(prefixes.media || '콘텐츠:') },
    { route: 'place', prefixes: listPrefixes(prefixes.place || '식당:').concat(listPrefixes(prefixes.restaurant || '맛집:')) },
    { route: 'news', prefixes: listPrefixes(prefixes.news || '소식:') },
    { route: 'report', prefixes: listPrefixes(prefixes.report || '리포트:').concat(listPrefixes(prefixes.summary || '요약:')) },
    { route: 'work', prefixes: listPrefixes(prefixes.work || '작업:').concat(listPrefixes(prefixes.do || '실행:')) },
    { route: 'inspect', prefixes: listPrefixes(prefixes.inspect || '점검:').concat(listPrefixes(prefixes.check || '검토:')) },
    { route: 'deploy', prefixes: listPrefixes(prefixes.deploy || '배포:').concat(listPrefixes(prefixes.ship || '출시:')) },
    { route: 'project', prefixes: listPrefixes(prefixes.project || '프로젝트:') },
    { route: 'prompt', prefixes: listPrefixes(prefixes.prompt || '프롬프트:').concat(listPrefixes(prefixes.ask || '질문:')) },
    { route: 'link', prefixes: listPrefixes(prefixes.link || '링크:') },
    { route: 'status', prefixes: listPrefixes(prefixes.status || '상태:') },
    { route: 'ops', prefixes: listPrefixes(prefixes.ops || '운영:') },
  ];
}

function isStructuredTemplatePayload(payload) {
  const raw = String(payload || '').trim();
  if (!raw) return false;
  return /(?:^|[;\n])\s*[^:：\n]{1,40}\s*[:：]\s*\S+/.test(raw);
}

function shouldRetryNaturalInference(route, payload) {
  const key = String(route || '').trim().toLowerCase();
  if (!['work', 'inspect', 'project'].includes(key)) return false;
  return !isStructuredTemplatePayload(payload);
}

function routeByPrefix(text, deps = {}) {
  const normalizeIncomingCommandText = typeof deps.normalizeIncomingCommandText === 'function'
    ? deps.normalizeIncomingCommandText
    : (value) => String(value || '').trim();
  const parseApproveShorthand = typeof deps.parseApproveShorthand === 'function'
    ? deps.parseApproveShorthand
    : () => null;
  const parseDenyShorthand = typeof deps.parseDenyShorthand === 'function'
    ? deps.parseDenyShorthand
    : () => null;
  const parseNaturalApprovalShorthand = typeof deps.parseNaturalApprovalShorthand === 'function'
    ? deps.parseNaturalApprovalShorthand
    : () => null;
  const readPendingApprovalsState = typeof deps.readPendingApprovalsState === 'function'
    ? deps.readPendingApprovalsState
    : () => [];
  const hasAnyApprovalHint = typeof deps.hasAnyApprovalHint === 'function'
    ? deps.hasAnyApprovalHint
    : () => false;
  const inferNaturalLanguageRoute = typeof deps.inferNaturalLanguageRoute === 'function'
    ? deps.inferNaturalLanguageRoute
    : () => null;

  const rawInput = String(text || '').trim();
  const input = normalizeIncomingCommandText(rawInput) || rawInput;
  const prefixes = deps.commandPrefixes && typeof deps.commandPrefixes === 'object'
    ? deps.commandPrefixes
    : {};
  const rules = buildRoutingRules(prefixes);

  for (const rule of rules) {
    for (const prefix of rule.prefixes) {
      const offset = matchPrefix(input, prefix);
      if (offset != null) {
        const payload = input.slice(offset).trim();
        if (shouldRetryNaturalInference(rule.route, payload)) {
          const inferred = inferNaturalLanguageRoute(input, {
            env: deps.env && typeof deps.env === 'object' ? deps.env : process.env,
          });
          if (
            inferred
            && String(inferred.route || '').trim().toLowerCase() === String(rule.route || '').trim().toLowerCase()
            && String(inferred.payload || '').trim()
          ) {
            return inferred;
          }
        }
        return { route: rule.route, payload };
      }
    }
  }

  const approve = parseApproveShorthand(input);
  if (approve) {
    return { route: 'ops', payload: approve.normalizedPayload };
  }

  const deny = parseDenyShorthand(input);
  if (deny) {
    return { route: 'ops', payload: deny.normalizedPayload };
  }

  const naturalApproval = parseNaturalApprovalShorthand(input);
  if (naturalApproval) {
    const pending = readPendingApprovalsState();
    const hasPending = Array.isArray(pending) && pending.length > 0;
    if (hasPending || hasAnyApprovalHint()) {
      return { route: 'ops', payload: naturalApproval.normalizedPayload };
    }
  }

  const inferred = inferNaturalLanguageRoute(input, {
    env: deps.env && typeof deps.env === 'object' ? deps.env : process.env,
  });
  if (inferred) return inferred;
  return { route: 'none', payload: input };
}

module.exports = {
  matchPrefix,
  buildRoutingRules,
  routeByPrefix,
};
