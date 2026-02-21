function parseReportModeCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return { matched: false, valid: false, mode: '' };
  const matched = raw.match(/^\/report\s+(.+)$/i);
  if (!matched) return { matched: false, valid: false, mode: '' };
  const modeRaw = String(matched[1] || '').trim().toLowerCase();
  if (modeRaw === 'ko' || modeRaw === 'ko+en') {
    return { matched: true, valid: true, mode: modeRaw };
  }
  return { matched: true, valid: false, mode: modeRaw };
}

function parsePersonaInfoCommand(text, options = {}) {
  const normalizeIncomingCommandText = typeof options.normalizeIncomingCommandText === 'function'
    ? options.normalizeIncomingCommandText
    : null;
  const raw = normalizeIncomingCommandText
    ? (normalizeIncomingCommandText(text) || String(text || '').trim())
    : String(text || '').trim();
  if (!raw) return { matched: false };
  if (/^\/?persona(?:\s+status)?$/i.test(raw)) {
    return { matched: true, route: '' };
  }
  if (/^\/?persona\s+(status|info|state)$/i.test(raw)) {
    return { matched: true, route: '' };
  }
  if (/^(페르소나|캐릭터)\s*(상태|조회|정보|info|설정|확인)?$/i.test(raw)) {
    return { matched: true, route: '' };
  }
  if (
    /(페르소나|캐릭터)/i.test(raw)
    && /(상태|조회|정보|확인|뭐야|뭐지|어때|알려)/i.test(raw)
    && !/(바꿔|변경|전환|switch|set|맞춰|설정해|모드로)/i.test(raw)
  ) {
    return { matched: true, route: '' };
  }
  return { matched: false };
}

module.exports = {
  parseReportModeCommand,
  parsePersonaInfoCommand,
};
