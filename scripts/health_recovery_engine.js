const AREA_RULES = {
  chest: { requiredHours: 48, label: '가슴' },
  back: { requiredHours: 48, label: '등' },
  legs: { requiredHours: 72, label: '하체' },
  shoulders: { requiredHours: 48, label: '어깨' },
  arms: { requiredHours: 48, label: '팔' },
  core: { requiredHours: 24, label: '코어' },
  cardio: { requiredHours: 24, label: '유산소' },
};

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateWithRef(value, refDate) {
  const text = String(value == null ? '' : value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ref = toDate(refDate) || new Date();
    const base = toDate(`${text}T00:00:00`);
    if (!base) return null;
    base.setHours(ref.getHours(), ref.getMinutes(), ref.getSeconds(), ref.getMilliseconds());
    return base;
  }
  return toDate(value);
}

function colorByPercent(percent) {
  if (percent < 40) return 'red';
  if (percent < 80) return 'yellow';
  return 'green';
}

function computeRecoveryByArea(lastTrainedByArea, refDate = new Date()) {
  const ref = toDate(refDate) || new Date();
  const byArea = {};

  for (const [area, rule] of Object.entries(AREA_RULES)) {
    const lastRaw = lastTrainedByArea && lastTrainedByArea[area] ? lastTrainedByArea[area] : null;
    const lastDate = toDate(lastRaw);

    if (!lastDate) {
      byArea[area] = {
        area,
        label: rule.label,
        requiredHours: rule.requiredHours,
        elapsedHours: null,
        recoveryPercent: 100,
        ready: true,
        color: 'green',
        status: 'untrained',
        priority: 'train',
        needMoreHours: 0,
        lastTrainedAt: null,
      };
      continue;
    }

    const elapsedHours = Math.max(0, (ref.getTime() - lastDate.getTime()) / 3600000);
    const recoveryPercent = clamp(Math.round((elapsedHours / rule.requiredHours) * 100), 0, 100);
    const needMoreHours = Math.max(0, Math.ceil(rule.requiredHours - elapsedHours));
    const ready = needMoreHours === 0;

    byArea[area] = {
      area,
      label: rule.label,
      requiredHours: rule.requiredHours,
      elapsedHours: Math.round(elapsedHours),
      recoveryPercent,
      ready,
      color: colorByPercent(recoveryPercent),
      status: ready ? 'ready' : 'recovering',
      priority: ready && elapsedHours >= 72 ? 'train' : (!ready ? 'rest' : 'maintain'),
      needMoreHours,
      lastTrainedAt: lastDate.toISOString(),
    };
  }

  const recommendations = Object.values(byArea)
    .map((x) => {
      const score = x.priority === 'train' ? (x.status === 'untrained' ? 300 : 200 + (x.elapsedHours || 0)) : (x.priority === 'rest' ? 10 : 50);
      return { ...x, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => ({
      area: x.area,
      label: x.label,
      priority: x.priority,
      recoveryPercent: x.recoveryPercent,
      message: x.priority === 'rest'
        ? `${x.label} 회복 우선 (${x.needMoreHours}시간 필요)`
        : x.priority === 'train'
          ? `${x.label} 훈련 권장`
          : `${x.label} 가벼운 유지 훈련 권장`,
    }));

  return { byArea, recommendations };
}

function computeRecoveryFromSessions(sessions, refDate = new Date()) {
  const ref = toDate(refDate) || new Date();
  const lastTrainedByArea = {};
  for (const session of sessions || []) {
    const dateText = String(session.date || '').trim();
    if (!dateText) continue;
    const base = toDateWithRef(dateText, ref);
    if (!base) continue;
    const areas = Array.isArray(session.areas) && session.areas.length
      ? session.areas
      : (String(session.sportType || '') === 'running' ? ['cardio'] : ['core']);
    for (const area of areas) {
      if (!AREA_RULES[area]) continue;
      const current = lastTrainedByArea[area] ? toDate(lastTrainedByArea[area]) : null;
      if (!current || base > current) {
        lastTrainedByArea[area] = base.toISOString();
      }
    }
  }

  return computeRecoveryByArea(lastTrainedByArea, ref);
}

module.exports = {
  AREA_RULES,
  computeRecoveryByArea,
  computeRecoveryFromSessions,
};
