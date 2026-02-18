const fs = require('fs');
const path = require('path');
const { KNOWN_TOEIC_TERMS, normalizeWordToken } = require('./anki_word_quality');

const DEFAULT_RUNTIME_LEXICON_PATH = path.join(__dirname, '../data/runtime/anki_typo_lexicon.json');
const runtimeLexiconCache = {
  path: '',
  mtimeMs: -1,
  terms: [],
};

function normalizeLexiconTerm(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isValidLexiconTerm(term) {
  const normalized = normalizeLexiconTerm(term);
  if (!normalized) return false;
  if (normalized.length > 90) return false;
  return /^[a-z][a-z\-'\s]*$/.test(normalized);
}

function normalizeLexiconList(values) {
  const out = [];
  const seen = new Set();
  for (const row of (Array.isArray(values) ? values : [])) {
    const term = normalizeLexiconTerm(row);
    if (!isValidLexiconTerm(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

function resolveRuntimeLexiconPath(options = {}) {
  const explicit = String(options.runtimeLexiconPath || process.env.ANKI_TYPO_LEXICON_PATH || '').trim();
  return explicit || DEFAULT_RUNTIME_LEXICON_PATH;
}

function loadRuntimeLexicon(options = {}) {
  const lexiconPath = resolveRuntimeLexiconPath(options);
  const forceReload = Boolean(options.forceReload);

  let stat = null;
  try {
    stat = fs.statSync(lexiconPath);
  } catch (_) {
    runtimeLexiconCache.path = lexiconPath;
    runtimeLexiconCache.mtimeMs = -1;
    runtimeLexiconCache.terms = [];
    return [];
  }

  if (
    !forceReload
    && runtimeLexiconCache.path === lexiconPath
    && runtimeLexiconCache.mtimeMs === Number(stat.mtimeMs || 0)
    && Array.isArray(runtimeLexiconCache.terms)
  ) {
    return runtimeLexiconCache.terms;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(lexiconPath, 'utf8'));
  } catch (_) {
    runtimeLexiconCache.path = lexiconPath;
    runtimeLexiconCache.mtimeMs = Number(stat.mtimeMs || 0);
    runtimeLexiconCache.terms = [];
    return [];
  }
  const terms = normalizeLexiconList(parsed && parsed.terms);
  runtimeLexiconCache.path = lexiconPath;
  runtimeLexiconCache.mtimeMs = Number(stat.mtimeMs || 0);
  runtimeLexiconCache.terms = terms;
  return terms;
}

function buildTypoLexicon(options = {}) {
  const includeRuntime = options.includeRuntimeLexicon !== false;
  const out = [];
  const seen = new Set();
  const pushTerms = (rows) => {
    for (const term of normalizeLexiconList(rows)) {
      if (seen.has(term)) continue;
      seen.add(term);
      out.push(term);
    }
  };
  pushTerms(KNOWN_TOEIC_TERMS);
  pushTerms(options.extraLexicon || []);
  if (includeRuntime) {
    pushTerms(loadRuntimeLexicon(options));
  }
  return out;
}

function normalizeForDistance(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function levenshtein(a, b) {
  const s = normalizeForDistance(a);
  const t = normalizeForDistance(b);
  if (!s) return t.length;
  if (!t) return s.length;
  const rows = s.length + 1;
  const cols = t.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[rows - 1][cols - 1];
}

function typoThreshold(word) {
  const len = normalizeForDistance(word).length;
  if (len <= 5) return 1;
  if (len <= 8) return 2;
  return 3;
}

function extractPrimaryWord(token) {
  const text = String(token || '').trim();
  if (!text) return '';
  const match = text.match(/^([A-Za-z][A-Za-z\-'\s]{0,80})/);
  return normalizeWordToken(match ? match[1] : text);
}

function rankWordTypos(word, limit = 3, options = {}) {
  const target = normalizeWordToken(word);
  if (!target) return [];
  const lexicon = buildTypoLexicon(options);
  if (lexicon.includes(target)) return [];
  const threshold = typoThreshold(target);
  const ranked = [];
  for (const candidate of lexicon) {
    const distance = levenshtein(target, candidate);
    if (distance > threshold) continue;
    if (target[0] && candidate[0] && target[0] !== candidate[0]) continue;
    ranked.push({
      candidate,
      distance,
      lenGap: Math.abs(String(candidate).length - String(target).length),
      similarity: 1 - (distance / Math.max(String(target).length, String(candidate).length, 1)),
    });
  }
  ranked.sort((a, b) => (a.distance - b.distance)
    || (a.lenGap - b.lenGap)
    || (b.similarity - a.similarity)
    || a.candidate.localeCompare(b.candidate));
  return ranked.slice(0, Math.max(1, limit));
}

function guessWordTypos(word, limit = 3, options = {}) {
  return rankWordTypos(word, limit, options).map((row) => row.candidate);
}

function detectTypoSuspicion(word, options = {}) {
  const target = normalizeWordToken(word);
  if (!target) {
    return {
      suspicious: false,
      target: '',
      primary: '',
      suggestions: [],
    };
  }
  if (target.includes(' ')) {
    return {
      suspicious: false,
      target,
      primary: '',
      suggestions: [],
    };
  }
  const lexicon = buildTypoLexicon(options);
  if (lexicon.includes(target)) {
    return {
      suspicious: false,
      target,
      primary: '',
      suggestions: [],
    };
  }

  const ranked = rankWordTypos(target, 3, { ...options, includeRuntimeLexicon: false, extraLexicon: lexicon });
  if (ranked.length === 0) {
    return {
      suspicious: false,
      target,
      primary: '',
      suggestions: [],
    };
  }

  const top = ranked[0];
  const second = ranked[1] || null;
  const strongDistance = Number.isFinite(options.maxDistance)
    ? Number(options.maxDistance)
    : (target.length <= 6 ? 1 : 2);
  const uniqueLead = !second || top.distance < second.distance;
  const highSimilarity = top.similarity >= 0.72;
  const suspicious = top.distance <= strongDistance && highSimilarity && (uniqueLead || top.distance <= 1);
  return {
    suspicious,
    target,
    primary: top.candidate,
    suggestions: ranked.map((row) => row.candidate),
    details: ranked,
  };
}

function analyzeWordFailures(failures = []) {
  const rows = Array.isArray(failures) ? failures : [];
  const clarificationLines = [];
  for (const row of rows) {
    const token = String(row && row.token ? row.token : '').trim();
    const reason = String(row && row.reason ? row.reason : '').trim().toLowerCase();
    if (!token) continue;
    if (reason.startsWith('typo_suspected:')) {
      const suggestions = reason
        .slice('typo_suspected:'.length)
        .split('|')
        .map((v) => String(v || '').trim())
        .filter(Boolean);
      if (suggestions.length > 0) {
        clarificationLines.push(`- "${token}" 오타 가능성: ${suggestions.join(' / ')} 중 어떤 단어인가요?`);
        continue;
      }
    }
    const guess = guessWordTypos(extractPrimaryWord(token), 3);
    if (guess.length > 0) {
      clarificationLines.push(`- "${token}" 오타 가능성: ${guess.join(' / ')} 중 어떤 단어인가요?`);
      continue;
    }
    if (reason === 'parse_failed') {
      clarificationLines.push(`- "${token}" 형식을 다시 보내주세요. 예: 단어: activate 활성화하다`);
      continue;
    }
    if (reason.includes('low_quality') || reason.includes('no_definition_found')) {
      clarificationLines.push(`- "${token}" 단어/뜻을 한 번 더 확인해서 다시 보내주세요.`);
    }
  }
  return {
    needsClarification: clarificationLines.length > 0,
    clarificationLines,
  };
}

module.exports = {
  analyzeWordFailures,
  buildTypoLexicon,
  detectTypoSuspicion,
  extractPrimaryWord,
  guessWordTypos,
  rankWordTypos,
  loadRuntimeLexicon,
  levenshtein,
};
