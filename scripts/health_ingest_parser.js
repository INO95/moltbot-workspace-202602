const DEFAULT_AREAS = ['core'];

const AREA_PATTERNS = [
  { area: 'chest', re: /가슴|chest|bench|press/i },
  { area: 'back', re: /등|back|row|pull[-\s]?up|lat/i },
  { area: 'legs', re: /하체|legs|squat|deadlift|lunge|hamstring|quad/i },
  { area: 'shoulders', re: /어깨|shoulder|lateral raise|overhead press/i },
  { area: 'arms', re: /팔|이두|삼두|arm|biceps|triceps|curl|extension/i },
  { area: 'core', re: /코어|복근|core|abs|plank/i },
  { area: 'cardio', re: /러닝|런닝|run|cardio|트레드밀|indoor run|jog|zone\s?2/i },
];

function toNumber(value) {
  const n = Number(String(value == null ? '' : value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalizeDate(raw) {
  const text = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const m = text.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
  if (m) {
    const y = m[1];
    const mo = String(parseInt(m[2], 10)).padStart(2, '0');
    const d = String(parseInt(m[3], 10)).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  return new Date().toISOString().slice(0, 10);
}

function extractFirst(text, re) {
  const m = String(text || '').match(re);
  if (!m) return null;
  return toNumber(m[1]);
}

function extractMax(text, re) {
  const matches = [...String(text || '').matchAll(re)];
  if (!matches.length) return null;
  return Math.max(...matches.map((m) => toNumber(m[1])));
}

function detectSportType(text) {
  const s = String(text || '');
  if (/\b(run|running|indoor run)\b|러닝|런닝|트레드밀|distance|km/i.test(s)) return 'running';
  if (/workout|sets|reps|volume|1rm|kg\/?min|웨이트|운동/i.test(s)) return 'workout';
  return 'workout';
}

function normalizeAreas(text) {
  const found = AREA_PATTERNS.filter((x) => x.re.test(String(text || ''))).map((x) => x.area);
  if (!found.length) return [...DEFAULT_AREAS];
  return [...new Set(found)];
}

function normalizeSession(obj) {
  const sportType = String(obj.sportType || obj.type || '').toLowerCase() === 'running' ? 'running' : 'workout';
  const date = normalizeDate(obj.date);
  const durationMin = Math.max(0, Math.round(toNumber(obj.durationMin || obj.duration || 0)));
  const calories = Math.max(0, Math.round(toNumber(obj.calories || 0)));
  const distanceKm = sportType === 'running' ? round2(Math.max(0, toNumber(obj.distanceKm || obj.distance || 0))) : 0;
  const volumeKg = sportType === 'workout' ? Math.max(0, Math.round(toNumber(obj.volumeKg || obj.volume || 0))) : 0;
  const sets = sportType === 'workout' ? Math.max(0, Math.round(toNumber(obj.sets || 0))) : 0;
  const reps = sportType === 'workout' ? Math.max(0, Math.round(toNumber(obj.reps || 0))) : 0;
  const notes = String(obj.notes || '').trim();
  const areas = Array.isArray(obj.areas) && obj.areas.length ? obj.areas.map((x) => String(x).trim()).filter(Boolean) : normalizeAreas(`${notes} ${obj.area || ''}`);

  return {
    date,
    sportType,
    durationMin,
    calories,
    distanceKm,
    volumeKg,
    sets,
    reps,
    areas,
    notes,
  };
}

function parseFromText(text) {
  const raw = String(text || '').trim();
  const sportType = detectSportType(raw);
  const date = normalizeDate(raw);
  const durationMin = Math.max(0, Math.round(extractFirst(raw, /(\d+(?:\.\d+)?)\s*min/i) || 0));
  const calories = Math.max(0, Math.round(extractFirst(raw, /(\d+(?:\.\d+)?)\s*kcal/i) || 0));

  let session;
  const missingFields = [];
  if (sportType === 'running') {
    const distanceKm = round2(Math.max(0, extractFirst(raw, /(\d+(?:\.\d+)?)\s*km/i) || 0));
    session = {
      date,
      sportType,
      durationMin,
      calories,
      distanceKm,
      volumeKg: 0,
      sets: 0,
      reps: 0,
      areas: ['cardio'],
      notes: raw,
    };
    if (!distanceKm) missingFields.push('distance_km');
  } else {
    const labeledVolume = extractFirst(raw, /volume\s*[:]?\s*(\d+(?:\.\d+)?)\s*kg/i);
    const anyKgMax = extractMax(raw, /(\d+(?:\.\d+)?)\s*kg\b/gi);
    const volumeKg = Math.max(0, Math.round(labeledVolume || anyKgMax || 0));
    const sets = Math.max(0, Math.round(extractFirst(raw, /(\d+)\s*sets/i) || 0));
    const reps = Math.max(0, Math.round(extractFirst(raw, /(\d+)\s*reps/i) || 0));
    session = {
      date,
      sportType,
      durationMin,
      calories,
      distanceKm: 0,
      volumeKg,
      sets,
      reps,
      areas: normalizeAreas(raw),
      notes: raw,
    };
    if (!sets) missingFields.push('sets');
    if (!reps) missingFields.push('reps');
  }

  return {
    ok: true,
    mode: 'text',
    rawText: raw,
    sessions: [session],
    missingFields,
  };
}

function parseFromStructured(input) {
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  const rawText = typeof input === 'string' ? input : JSON.stringify(input);
  const rawSessions = Array.isArray(obj.sessions) ? obj.sessions : [obj];
  const sessions = rawSessions.map(normalizeSession);
  const missingFields = [];
  for (const s of sessions) {
    if (s.sportType === 'running' && !s.distanceKm) missingFields.push('distance_km');
    if (s.sportType === 'workout' && !s.sets) missingFields.push('sets');
    if (s.sportType === 'workout' && !s.reps) missingFields.push('reps');
  }
  return {
    ok: true,
    mode: 'structured',
    rawText,
    sessions,
    missingFields: [...new Set(missingFields)],
  };
}

function parseCaptureInput(input) {
  try {
    if (input && typeof input === 'object') {
      return parseFromStructured(input);
    }
    const text = String(input == null ? '' : input).trim();
    if (!text) {
      return { ok: false, mode: 'text', rawText: '', sessions: [], missingFields: ['empty_input'] };
    }
    if (text.startsWith('{') || text.startsWith('[')) {
      return parseFromStructured(text);
    }
    return parseFromText(text);
  } catch (error) {
    return {
      ok: false,
      mode: 'unknown',
      rawText: typeof input === 'string' ? input : JSON.stringify(input || {}),
      sessions: [],
      missingFields: ['parse_error'],
      error: String(error.message || error),
    };
  }
}

module.exports = {
  parseCaptureInput,
  normalizeAreas,
  detectSportType,
  normalizeDate,
};
