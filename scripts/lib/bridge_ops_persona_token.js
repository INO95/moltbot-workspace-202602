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

function handleOpsPersonaAction(parsed = {}, requestedBy = '', deps = {}) {
  const normalizePersonaTarget = deps.normalizePersonaTarget;
  const readBotPersonaMap = deps.readBotPersonaMap;
  const writeBotPersonaMap = deps.writeBotPersonaMap;
  const readDailyPersonaState = deps.readDailyPersonaState;
  const writeDailyPersonaState = deps.writeDailyPersonaState;
  const applyDailyPersonaStateToConfig = deps.applyDailyPersonaStateToConfig;
  const resolvePresetProfileId = deps.resolvePresetProfileId;
  const dailyPersonaTargetBotIds = Array.isArray(deps.dailyPersonaTargetBotIds)
    ? deps.dailyPersonaTargetBotIds.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : ['bot-daily'];
  const dailyPersonaStateModes = deps.dailyPersonaStateModes && typeof deps.dailyPersonaStateModes === 'object'
    ? deps.dailyPersonaStateModes
    : {
      AUTO: 'auto',
      FORCE_PRESET: 'force_preset',
      FORCE_CUSTOM: 'force_custom',
    };
  const dailyPersonaDefaultTitle = String(deps.dailyPersonaDefaultTitle || '인호님').trim() || '인호님';
  const nowIso = typeof deps.nowIso === 'function'
    ? deps.nowIso
    : () => new Date().toISOString();

  if (typeof normalizePersonaTarget !== 'function') {
    throw new Error('normalizePersonaTarget dependency is required');
  }
  if (typeof readBotPersonaMap !== 'function') {
    throw new Error('readBotPersonaMap dependency is required');
  }
  if (typeof writeBotPersonaMap !== 'function') {
    throw new Error('writeBotPersonaMap dependency is required');
  }

  const fields = parsed && parsed.fields && typeof parsed.fields === 'object'
    ? parsed.fields
    : {};
  const targetBotId = normalizePersonaTarget(fields.대상);
  if (!targetBotId) {
    return {
      route: 'ops',
      templateValid: false,
      success: false,
      action: 'persona',
      errorCode: 'PERSONA_TARGET_REQUIRED',
      telegramReply: '페르소나 대상이 필요합니다. 예: 운영: 액션: 페르소나; 대상: daily; 이름: analyst',
    };
  }

  const taskRaw = String(fields.작업 || '').trim().toLowerCase();
  const presetRaw = String(fields.프리셋 || '').trim();
  const nameRaw = String(fields.이름 || '').trim();
  const hasCustomWriteSignals = Boolean(
    nameRaw
    || String(fields.스타일 || '').trim()
    || String(fields.톤 || '').trim()
    || String(fields.설명 || '').trim()
    || String(fields.금지 || '').trim(),
  );
  const hasPresetWriteSignal = Boolean(presetRaw);
  const hasAnyWriteSignal = hasCustomWriteSignals || hasPresetWriteSignal;
  const isReadOnly = /(조회|상태|show|list|get|확인|info)/.test(taskRaw)
    || (!taskRaw && !hasAnyWriteSignal);
  const isResetRequest = /(자동|기본|초기|원복|복귀|해제|reset|default|auto)/.test(taskRaw)
    && !hasAnyWriteSignal;

  const isDailyTarget = dailyPersonaTargetBotIds.includes(String(targetBotId || '').trim().toLowerCase());
  const canHandleDailyState = isDailyTarget
    && typeof readDailyPersonaState === 'function'
    && typeof writeDailyPersonaState === 'function'
    && typeof applyDailyPersonaStateToConfig === 'function'
    && typeof resolvePresetProfileId === 'function';

  if (canHandleDailyState) {
    const stateRead = readDailyPersonaState();
    const currentState = stateRead && stateRead.state && typeof stateRead.state === 'object'
      ? stateRead.state
      : {
        version: 1,
        mode: dailyPersonaStateModes.AUTO,
        profileId: '',
        custom: {},
        forceAllRoutes: true,
        updatedAt: '',
        updatedBy: '',
      };
    const currentApplied = applyDailyPersonaStateToConfig(currentState);
    const currentMeta = currentApplied && currentApplied.meta && typeof currentApplied.meta === 'object'
      ? currentApplied.meta
      : {};
    const modeLabel = currentMeta.mode === dailyPersonaStateModes.FORCE_PRESET
      ? '강제(프리셋)'
      : currentMeta.mode === dailyPersonaStateModes.FORCE_CUSTOM
        ? '강제(커스텀)'
        : '자동';

    if (isReadOnly) {
      const lines = [
        `페르소나 조회: ${targetBotId}`,
        `- 모드: ${modeLabel}`,
        '- 적용 범위: daily/main 전체 라우트',
        `- 현재 페르소나: ${String(currentMeta.profileName || '-').trim() || '-'}`,
        `- 호출 호칭: ${dailyPersonaDefaultTitle}`,
      ];
      if (currentMeta.mode === dailyPersonaStateModes.FORCE_PRESET) {
        lines.push(`- 프리셋 ID: ${String(currentMeta.profileId || '-').trim() || '-'}`);
      }
      if (currentMeta.mode === dailyPersonaStateModes.FORCE_CUSTOM) {
        const custom = currentState && currentState.custom && typeof currentState.custom === 'object'
          ? currentState.custom
          : {};
        lines.push(`- 이름: ${String(custom.name || '-').trim() || '-'}`);
        lines.push(`- 톤: ${String(custom.tone || '-').trim() || '-'}`);
        lines.push(`- 스타일: ${String(custom.style || '-').trim() || '-'}`);
        lines.push(`- 금지: ${String(custom.forbidden || '-').trim() || '-'}`);
        lines.push(`- 설명: ${String(custom.description || '-').trim() || '-'}`);
      }
      if (stateRead && stateRead.recovered) {
        lines.push('- 상태 파일 복구: 손상 감지 후 기본값 적용');
      }
      if (stateRead && stateRead.path) {
        lines.push(`- 상태 파일: ${stateRead.path}`);
      }
      return {
        route: 'ops',
        templateValid: true,
        success: true,
        action: 'persona',
        target: targetBotId,
        telegramReply: lines.join('\n'),
      };
    }

    if (isResetRequest) {
      const nextState = {
        ...currentState,
        mode: dailyPersonaStateModes.AUTO,
        profileId: '',
        custom: {
          name: '',
          tone: '',
          style: '',
          forbidden: '',
          description: '',
          introTemplate: '',
        },
        forceAllRoutes: true,
        updatedAt: nowIso(),
        updatedBy: requestedBy || 'unknown',
      };
      const written = writeDailyPersonaState(nextState);
      if (!written || written.ok === false) {
        return {
          route: 'ops',
          templateValid: false,
          success: false,
          action: 'persona',
          errorCode: 'PERSONA_SAVE_FAILED',
          telegramReply: '페르소나 저장에 실패했습니다.',
        };
      }
      const applied = applyDailyPersonaStateToConfig(written.state || nextState);
      const meta = applied && applied.meta && typeof applied.meta === 'object' ? applied.meta : {};
      return {
        route: 'ops',
        templateValid: true,
        success: true,
        action: 'persona',
        target: targetBotId,
        telegramReply: [
          `페르소나 적용 완료: ${targetBotId}`,
          '- 모드: 자동',
          `- 현재 페르소나: ${String(meta.profileName || '-').trim() || '-'}`,
          '- 적용 범위: daily/main 전체 라우트',
        ].join('\n'),
      };
    }

    let presetInput = presetRaw;
    if (!presetInput && nameRaw && !String(fields.톤 || '').trim() && !String(fields.스타일 || '').trim()) {
      presetInput = nameRaw;
    }
    const presetId = presetInput ? resolvePresetProfileId(presetInput) : '';
    if (presetInput) {
      if (!presetId) {
        return {
          route: 'ops',
          templateValid: false,
          success: false,
          action: 'persona',
          errorCode: 'PERSONA_PRESET_INVALID',
          telegramReply: '지원하지 않는 프리셋입니다. 사용 가능: Adelia, Sylvia, Neris',
        };
      }
      const nextState = {
        ...currentState,
        mode: dailyPersonaStateModes.FORCE_PRESET,
        profileId: presetId,
        forceAllRoutes: true,
        updatedAt: nowIso(),
        updatedBy: requestedBy || 'unknown',
      };
      const written = writeDailyPersonaState(nextState);
      if (!written || written.ok === false) {
        return {
          route: 'ops',
          templateValid: false,
          success: false,
          action: 'persona',
          errorCode: 'PERSONA_SAVE_FAILED',
          telegramReply: '페르소나 저장에 실패했습니다.',
        };
      }
      const applied = applyDailyPersonaStateToConfig(written.state || nextState);
      const meta = applied && applied.meta && typeof applied.meta === 'object' ? applied.meta : {};
      return {
        route: 'ops',
        templateValid: true,
        success: true,
        action: 'persona',
        target: targetBotId,
        telegramReply: [
          `페르소나 적용 완료: ${targetBotId}`,
          '- 모드: 강제(프리셋)',
          `- 프리셋 ID: ${presetId}`,
          `- 현재 페르소나: ${String(meta.profileName || '-').trim() || '-'}`,
          '- 적용 범위: daily/main 전체 라우트',
        ].join('\n'),
      };
    }

    const currentCustom = currentState && currentState.custom && typeof currentState.custom === 'object'
      ? currentState.custom
      : {};
    const customName = nameRaw || String(currentCustom.name || '').trim();
    if (!customName) {
      return {
        route: 'ops',
        templateValid: false,
        success: false,
        action: 'persona',
        errorCode: 'PERSONA_NAME_REQUIRED',
        telegramReply: '페르소나 이름 또는 프리셋이 필요합니다. 예: 운영: 액션: 페르소나; 대상: daily; 프리셋: Sylvia',
      };
    }
    const nextCustom = {
      name: customName,
      tone: String(fields.톤 || currentCustom.tone || '').trim(),
      style: String(fields.스타일 || currentCustom.style || '').trim(),
      forbidden: String(fields.금지 || currentCustom.forbidden || '').trim(),
      description: String(fields.설명 || currentCustom.description || '').trim(),
      introTemplate: String(currentCustom.introTemplate || '').trim(),
    };
    const nextState = {
      ...currentState,
      mode: dailyPersonaStateModes.FORCE_CUSTOM,
      profileId: '',
      custom: nextCustom,
      forceAllRoutes: true,
      updatedAt: nowIso(),
      updatedBy: requestedBy || 'unknown',
    };
    const written = writeDailyPersonaState(nextState);
    if (!written || written.ok === false) {
      return {
        route: 'ops',
        templateValid: false,
        success: false,
        action: 'persona',
        errorCode: 'PERSONA_SAVE_FAILED',
        telegramReply: '페르소나 저장에 실패했습니다.',
      };
    }
    const applied = applyDailyPersonaStateToConfig(written.state || nextState);
    const meta = applied && applied.meta && typeof applied.meta === 'object' ? applied.meta : {};
    return {
      route: 'ops',
      templateValid: true,
      success: true,
      action: 'persona',
      target: targetBotId,
      telegramReply: [
        `페르소나 적용 완료: ${targetBotId}`,
        '- 모드: 강제(커스텀)',
        `- 이름: ${nextCustom.name}`,
        `- 톤: ${nextCustom.tone || '-'}`,
        `- 스타일: ${nextCustom.style || '-'}`,
        `- 금지: ${nextCustom.forbidden || '-'}`,
        `- 현재 페르소나: ${String(meta.profileName || '-').trim() || '-'}`,
      ].join('\n'),
    };
  }

  const map = readBotPersonaMap();
  const current = map && typeof map[targetBotId] === 'object' ? map[targetBotId] : null;
  if (isReadOnly) {
    if (!current) {
      return {
        route: 'ops',
        templateValid: true,
        success: true,
        action: 'persona',
        target: targetBotId,
        telegramReply: `페르소나 조회: ${targetBotId}\n- 설정 없음`,
      };
    }
    return {
      route: 'ops',
      templateValid: true,
      success: true,
      action: 'persona',
      target: targetBotId,
      telegramReply: [
        `페르소나 조회: ${targetBotId}`,
        `- 이름: ${String(current.name || '').trim() || '-'}`,
        `- 톤: ${String(current.tone || '').trim() || '-'}`,
        `- 스타일: ${String(current.style || '').trim() || '-'}`,
        `- 금지: ${String(current.forbidden || '').trim() || '-'}`,
        `- 설명: ${String(current.description || '').trim() || '-'}`,
      ].join('\n'),
    };
  }

  const name = nameRaw;
  if (!name) {
    return {
      route: 'ops',
      templateValid: false,
      success: false,
      action: 'persona',
      errorCode: 'PERSONA_NAME_REQUIRED',
      telegramReply: '페르소나 이름이 필요합니다. 예: 운영: 액션: 페르소나; 대상: daily; 이름: analyst; 톤: 간결',
    };
  }

  const next = {
    ...(current || {}),
    name,
    tone: String(fields.톤 || (current && current.tone) || '').trim(),
    style: String(fields.스타일 || (current && current.style) || '').trim(),
    forbidden: String(fields.금지 || (current && current.forbidden) || '').trim(),
    description: String(fields.설명 || (current && current.description) || '').trim(),
    updated_at: nowIso(),
    updated_by: requestedBy || 'unknown',
  };
  map[targetBotId] = next;
  const written = writeBotPersonaMap(map);
  if (!written) {
    return {
      route: 'ops',
      templateValid: false,
      success: false,
      action: 'persona',
      errorCode: 'PERSONA_SAVE_FAILED',
      telegramReply: '페르소나 저장에 실패했습니다.',
    };
  }
  return {
    route: 'ops',
    templateValid: true,
    success: true,
    action: 'persona',
    target: targetBotId,
    telegramReply: [
      `페르소나 적용 완료: ${targetBotId}`,
      `- 이름: ${next.name}`,
      `- 톤: ${next.tone || '-'}`,
      `- 스타일: ${next.style || '-'}`,
      `- 금지: ${next.forbidden || '-'}`,
    ].join('\n'),
  };
}

module.exports = {
  handleOpsTokenAction,
  handleOpsPersonaAction,
};
