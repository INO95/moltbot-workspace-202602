const COMMAND_TEMPLATE_SCHEMA = {
  work: {
    displayName: '작업',
    required: ['요청', '대상', '완료기준'],
    optional: ['제약', '우선순위', '기한', 'API'],
    aliases: {
      요청: ['요청', '목표', '작업', 'task', 'goal'],
      대상: ['대상', '범위', 'target', 'scope', 'repo', '파일'],
      완료기준: ['완료기준', '성공기준', 'done', 'acceptance'],
      제약: ['제약', '조건', 'constraint'],
      우선순위: ['우선순위', 'priority'],
      기한: ['기한', 'due', 'deadline'],
      API: ['api', 'API', '모델경로', 'api경로', 'lane'],
    },
  },
  inspect: {
    displayName: '점검',
    required: ['대상', '체크항목'],
    optional: ['출력형식', '심각도기준', 'API'],
    aliases: {
      대상: ['대상', '범위', 'target', 'scope'],
      체크항목: ['체크항목', '점검항목', 'check', 'checklist'],
      출력형식: ['출력형식', '형식', 'format'],
      심각도기준: ['심각도기준', 'severity'],
      API: ['api', 'API', '모델경로', 'api경로', 'lane'],
    },
  },
  deploy: {
    displayName: '배포',
    required: ['대상', '환경', '검증'],
    optional: ['롤백', '승인자', 'API'],
    aliases: {
      대상: ['대상', '서비스', 'target', 'service'],
      환경: ['환경', 'env', 'environment'],
      검증: ['검증', '검증방법', 'verify'],
      롤백: ['롤백', 'rollback'],
      승인자: ['승인자', 'approver'],
      API: ['api', 'API', '모델경로', 'api경로', 'lane'],
    },
  },
  project: {
    displayName: '프로젝트',
    required: ['프로젝트명', '목표', '스택', '경로', '완료기준'],
    optional: ['초기화', '제약', 'API'],
    aliases: {
      프로젝트명: ['프로젝트명', '이름', 'project', 'projectname', 'name'],
      목표: ['목표', '요청', 'objective', 'goal'],
      스택: ['스택', '기술스택', 'stack', 'tech'],
      경로: ['경로', 'path', 'directory', 'dir'],
      완료기준: ['완료기준', 'done', 'acceptance', 'success'],
      초기화: ['초기화', 'init', 'bootstrap'],
      제약: ['제약', 'constraint'],
      API: ['api', 'API', '모델경로', 'api경로', 'lane'],
    },
  },
  ops: {
    displayName: '운영',
    required: ['액션'],
    optional: [
      '대상',
      '사유',
      '작업',
      '경로',
      '대상경로',
      '패턴',
      '저장소',
      '커밋메시지',
      '토큰',
      '옵션',
      '계정',
      '수신자',
      '제목',
      '본문',
      '시간',
      '첨부',
      '장치',
      '식별자',
      '내용',
      'URL',
      '셀렉터',
      '키',
      '값',
      '메서드',
      '명령',
      '이름',
      '스타일',
      '톤',
      '설명',
      '금지',
    ],
    aliases: {
      액션: ['액션', 'action'],
      대상: ['대상', 'target', '서비스'],
      사유: ['사유', 'reason', '메모'],
      작업: ['작업', 'task', 'operation', 'intent'],
      경로: ['경로', 'path', 'source', 'src'],
      대상경로: ['대상경로', 'targetpath', 'destination', 'dst'],
      패턴: ['패턴', 'pattern', 'glob'],
      저장소: ['저장소', 'repository', 'repo'],
      커밋메시지: ['커밋메시지', 'commitmessage', 'message'],
      토큰: ['토큰', 'token', 'approval'],
      옵션: ['옵션', 'option', 'flags'],
      계정: ['계정', 'account', 'mailbox', 'profile'],
      수신자: ['수신자', 'recipient', 'to', 'email'],
      제목: ['제목', 'subject'],
      본문: ['본문', 'body'],
      시간: ['시간', 'time', 'schedule_at', 'when'],
      첨부: ['첨부', 'attachment', 'file'],
      장치: ['장치', 'device', 'camera'],
      식별자: ['식별자', 'id', 'event_id', 'schedule_id'],
      내용: ['내용', 'content', 'note'],
      URL: ['url', 'URL', '링크', '주소'],
      셀렉터: ['셀렉터', 'selector', 'ref'],
      키: ['키', 'key'],
      값: ['값', 'value', 'text'],
      메서드: ['메서드', 'method'],
      명령: ['명령', 'command', 'cmd'],
      이름: ['이름', 'name', 'persona'],
      스타일: ['스타일', 'style'],
      톤: ['톤', 'tone', 'voice'],
      설명: ['설명', 'desc', 'description'],
      금지: ['금지', 'forbidden', 'ban'],
    },
  },
};

function normalizeTemplateKey(route, rawKey, schemaMap = COMMAND_TEMPLATE_SCHEMA) {
  const schema = schemaMap[route];
  if (!schema) return null;
  const key = String(rawKey || '').replace(/\s+/g, '').toLowerCase();
  for (const [canonical, aliases] of Object.entries(schema.aliases || {})) {
    if (aliases.some((alias) => key === String(alias).replace(/\s+/g, '').toLowerCase())) {
      return canonical;
    }
  }
  return null;
}

function parseTemplateFields(route, payloadText, schemaMap = COMMAND_TEMPLATE_SCHEMA) {
  const fields = {};
  const tokens = String(payloadText || '')
    .split(/\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const matched = token.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
    if (!matched) continue;
    const canonical = normalizeTemplateKey(route, matched[1], schemaMap);
    if (!canonical) continue;
    const value = String(matched[2] || '').trim();
    if (!value) continue;
    fields[canonical] = value;
  }
  return fields;
}

function buildTemplateGuide(route, schemaMap = COMMAND_TEMPLATE_SCHEMA) {
  const schema = schemaMap[route];
  if (!schema) return '지원하지 않는 템플릿입니다.';
  const prefix = route === 'work'
    ? '작업'
    : route === 'inspect'
      ? '점검'
      : route === 'deploy'
        ? '배포'
        : route === 'ops'
          ? '운영'
          : route === 'project'
            ? '프로젝트'
            : route;
  const required = schema.required.map((k) => `${k}: ...`).join('\n');
  const optional = schema.optional.map((k) => `${k}: ...`).join('\n');
  return [
    `[${schema.displayName} 템플릿]`,
    required,
    optional ? `\n(선택)\n${optional}` : '',
    '\n예시:',
    `${prefix}: ${schema.required.map((k) => `${k}: ...`).join('; ')}`,
  ].join('\n');
}

function parseStructuredCommand(route, payloadText, schemaMap = COMMAND_TEMPLATE_SCHEMA) {
  const schema = schemaMap[route];
  if (!schema) return { ok: false, error: 'unknown template route' };

  const payload = String(payloadText || '').trim();
  if (!payload || /^(도움말|help|템플릿)$/i.test(payload)) {
    return {
      ok: false,
      missing: schema.required,
      telegramReply: buildTemplateGuide(route, schemaMap),
    };
  }

  const fields = parseTemplateFields(route, payload, schemaMap);
  if (fields.API) {
    const apiValue = String(fields.API || '').trim().toLowerCase();
    if (!['auto', 'oauth', 'key'].includes(apiValue)) {
      return {
        ok: false,
        missing: [],
        telegramReply: `${schema.displayName} 템플릿 오류: API 값은 auto|oauth|key 만 허용됩니다.`,
      };
    }
    fields.API = apiValue;
  }
  const missing = schema.required.filter((key) => !fields[key]);
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      telegramReply: [
        `${schema.displayName} 템플릿 누락: ${missing.join(', ')}`,
        buildTemplateGuide(route, schemaMap),
      ].join('\n\n'),
    };
  }

  const ordered = [...schema.required, ...schema.optional]
    .filter((key) => fields[key])
    .map((key) => `${key}: ${fields[key]}`)
    .join('\n');
  const needsApproval = route === 'deploy';
  return {
    ok: true,
    fields,
    normalizedInstruction: ordered,
    telegramReply: `${schema.displayName} 템플릿 확인 완료`,
    needsApproval,
  };
}

function handlePromptPayload(payloadText, deps = {}) {
  const promptBuilder = deps.promptBuilder
    || require('../prompt_builder');

  const payload = String(payloadText || '').trim();

  if (payload.startsWith('답변')) {
    const body = payload.replace(/^답변\s*/, '');
    const [sessionIdRaw, patchRaw = ''] = body.split('|');
    const sessionId = String(sessionIdRaw || '').trim();
    if (!sessionId) {
      return { error: 'sessionId가 필요합니다. 예: 프롬프트: 답변 pf_xxx | 출력형식: 표' };
    }
    const patch = {};
    for (const token of patchRaw.split(/[;\n]/).map((x) => x.trim()).filter(Boolean)) {
      const parts = token.split(/[:：]/);
      if (parts.length < 2) continue;
      const keyRaw = parts[0].toLowerCase();
      const value = parts.slice(1).join(':').trim();
      if (!value) continue;
      if (/(목적|goal|요청)/.test(keyRaw)) patch.goal = value;
      else if (/(제약|constraint|조건)/.test(keyRaw)) patch.constraints = value;
      else if (/(출력|format|형식)/.test(keyRaw)) patch.outputFormat = value;
      else if (/(금지|forbidden)/.test(keyRaw)) patch.forbidden = value;
      else if (/(성공|criteria|완료)/.test(keyRaw)) patch.successCriteria = value;
    }
    const updated = promptBuilder.updateSession(sessionId, patch);
    return {
      mode: 'update',
      sessionId,
      domain: updated.domain || 'general',
      completeness: updated.completeness,
      missingQuestions: updated.missingQuestions,
    };
  }

  if (payload.startsWith('완성') || payload.startsWith('최종')) {
    const sessionId = payload.replace(/^(완성|최종)\s*/, '').trim();
    if (!sessionId) {
      return { error: 'sessionId가 필요합니다. 예: 프롬프트: 완성 pf_xxx' };
    }
    const result = promptBuilder.finalizeSession(sessionId);
    return { mode: 'finalize', ...result };
  }

  const fields = promptBuilder.parseFreeTextToFields(payload);
  const session = promptBuilder.createSession(fields);
  return {
    mode: 'start',
    sessionId: session.id,
    domain: session.domain || 'general',
    completeness: session.completeness,
    missingQuestions: session.missingQuestions,
    usage: [
      `프롬프트: 답변 ${session.id} | 제약: ...; 출력형식: ...`,
      `프롬프트: 완성 ${session.id}`,
    ],
  };
}

module.exports = {
  COMMAND_TEMPLATE_SCHEMA,
  normalizeTemplateKey,
  parseTemplateFields,
  buildTemplateGuide,
  parseStructuredCommand,
  handlePromptPayload,
};
