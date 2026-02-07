function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function stripWrapping(text) {
  return String(text || '').trim().replace(/^<|>$/g, '');
}

function firstNonEmptyString(values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function extractImagePathFromLines(lines) {
  let imagePath = '';
  const kept = [];
  const markerRe = /^\s*(?:image_path|image|img|screenshot|attachment|첨부)\s*[:=]\s*(.+)\s*$/i;
  const mdImageRe = /!\[[^\]]*]\(([^)]+)\)/;

  for (const line of lines) {
    const m1 = line.match(markerRe);
    if (m1) {
      if (!imagePath) imagePath = stripWrapping(m1[1]);
      continue;
    }
    const m2 = line.match(mdImageRe);
    if (m2) {
      if (!imagePath) imagePath = stripWrapping(m2[1]);
      const lineWithoutImage = line.replace(mdImageRe, '').trim();
      if (lineWithoutImage) kept.push(lineWithoutImage);
      continue;
    }
    kept.push(line);
  }

  return {
    imagePath: imagePath || null,
    lines: kept,
  };
}

function looksStructuredExerciseObject(v) {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v.sessions)) return true;
  if (v.date && (v.sportType || v.type)) return true;
  if (v.distanceKm != null || v.volumeKg != null || v.sets != null || v.reps != null) return true;
  return false;
}

function pickPathLike(value) {
  if (typeof value !== 'string') return '';
  const s = stripWrapping(value);
  if (!s) return '';
  if (/^(\/|\.\/|\.\.\/|https?:\/\/|file:\/\/)/i.test(s)) return s;
  if (/\.(png|jpg|jpeg|webp|gif|heic|bmp)(\?|#|$)/i.test(s)) return s;
  return '';
}

function extractImagePathFromObject(input, seen = new Set()) {
  if (!input || typeof input !== 'object') return '';
  if (seen.has(input)) return '';
  seen.add(input);

  const directKeys = ['imagePath', 'image_path', 'path', 'file_path', 'filePath', 'localPath', 'uri', 'url', 'src'];
  for (const k of directKeys) {
    const picked = pickPathLike(input[k]);
    if (picked) return picked;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const found = extractImagePathFromObject(item, seen);
      if (found) return found;
    }
    return '';
  }

  const nestedKeys = ['attachments', 'media', 'photo', 'image', 'images', 'files', 'file', 'document'];
  for (const key of nestedKeys) {
    const found = extractImagePathFromObject(input[key], seen);
    if (found) return found;
  }

  // 마지막 fallback: 전체 키 순회
  for (const value of Object.values(input)) {
    const found = extractImagePathFromObject(value, seen);
    if (found) return found;
  }
  return '';
}

function parseHealthBridgePayload(input) {
  const raw = String(input == null ? '' : input)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();
  if (!raw) return { mode: 'text', text: '', imagePath: null };

  const parsed = parseJson(raw);
  if (parsed && typeof parsed === 'object') {
    const imagePathRaw = extractImagePathFromObject(parsed);
    const imagePath = imagePathRaw || null;
    const textCandidate = firstNonEmptyString([
      parsed.text,
      parsed.caption,
      parsed.message,
      parsed.content,
      parsed.description,
      parsed.rawText,
    ]);
    if (textCandidate) {
      return { mode: 'text', text: textCandidate, imagePath };
    }
    if (looksStructuredExerciseObject(parsed)) {
      return { mode: 'structured', structured: parsed, imagePath };
    }
    return { mode: 'text', text: raw, imagePath };
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const extracted = extractImagePathFromLines(lines);
  const text = extracted.lines.join('\n').trim();
  return {
    mode: 'text',
    text,
    imagePath: extracted.imagePath,
  };
}

module.exports = {
  parseHealthBridgePayload,
};
