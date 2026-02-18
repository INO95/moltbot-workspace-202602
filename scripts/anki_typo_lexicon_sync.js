#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const config = require('../data/config.json');
const { AnkiConnect } = require('./anki_connect');

const DEFAULT_OUTPUT_PATH = path.join(__dirname, '../data/runtime/anki_typo_lexicon.json');
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_NOTES_PER_DECK = 4000;

const FRONT_FIELD_HINTS = [
  'front',
  'question',
  'word',
  '단어',
  '표제어',
  'headword',
  'term',
];

function parseInteger(input, fallback) {
  const num = Number(input);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function parseArgs(argv) {
  const out = {
    decks: [],
    output: String(process.env.ANKI_TYPO_LEXICON_PATH || '').trim() || DEFAULT_OUTPUT_PATH,
    batch: parseInteger(process.env.ANKI_TYPO_LEXICON_BATCH, DEFAULT_BATCH_SIZE),
    maxNotes: parseInteger(process.env.ANKI_TYPO_LEXICON_MAX_NOTES, DEFAULT_MAX_NOTES_PER_DECK),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--decks' && argv[i + 1]) {
      out.decks = String(argv[i + 1] || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === '--output' && argv[i + 1]) {
      out.output = path.resolve(String(argv[i + 1] || '').trim());
      i += 1;
      continue;
    }
    if (arg === '--batch' && argv[i + 1]) {
      out.batch = parseInteger(argv[i + 1], out.batch);
      i += 1;
      continue;
    }
    if (arg === '--max-notes' && argv[i + 1]) {
      out.maxNotes = parseInteger(argv[i + 1], out.maxNotes);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }
  return out;
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/anki_typo_lexicon_sync.js [--decks "TOEIC_AI,Deck2"] [--output path] [--batch 200] [--max-notes 4000]\n',
  );
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of (Array.isArray(values) ? values : [])) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function defaultDecks() {
  const envDecks = String(process.env.ANKI_TYPO_LEXICON_DECKS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const configDeck = String(config?.ankiPolicy?.toeicDeck || '').trim();
  return uniqueStrings([
    ...envDecks,
    ...(configDeck ? [configDeck] : []),
  ]);
}

function escapeQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function stripHtml(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTerm(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isValidTerm(term) {
  const normalized = normalizeTerm(term);
  if (!normalized) return false;
  if (normalized.length > 90) return false;
  return /^[a-z][a-z\-'\s]*$/.test(normalized);
}

function extractEnglishPrefix(text) {
  const clean = stripHtml(text);
  if (!clean) return '';
  const match = clean.match(/^([A-Za-z][A-Za-z\-'\s]{0,88})/);
  return match ? normalizeTerm(match[1]) : '';
}

function extractTermCandidates(rawFront) {
  const clean = stripHtml(rawFront);
  if (!clean) return [];

  const direct = normalizeTerm(clean);
  const out = [];
  if (isValidTerm(direct)) out.push(direct);

  const prefixSplit = clean.match(/^([A-Za-z][A-Za-z\-'\s]{0,88})\s*(?:[:|]|-)\s*.+$/);
  if (prefixSplit) {
    const left = normalizeTerm(prefixSplit[1]);
    if (isValidTerm(left)) out.push(left);
  }

  const engPrefix = extractEnglishPrefix(clean);
  if (isValidTerm(engPrefix)) out.push(engPrefix);

  for (const token of clean.split(/[,\n\/;]/g)) {
    const normalized = normalizeTerm(token);
    if (isValidTerm(normalized)) out.push(normalized);
  }

  return uniqueStrings(out);
}

function pickFrontField(note) {
  const fields = note && note.fields && typeof note.fields === 'object' ? note.fields : {};
  const entries = Object.entries(fields);
  if (entries.length === 0) return '';
  const lowered = entries.map(([key, value]) => ({
    key,
    keyLower: String(key || '').trim().toLowerCase(),
    value: value && typeof value === 'object' ? String(value.value || '') : '',
  }));
  for (const hint of FRONT_FIELD_HINTS) {
    const row = lowered.find((entry) => entry.keyLower === hint || entry.keyLower.includes(hint));
    if (row && String(row.value || '').trim()) return row.value;
  }
  const first = lowered[0];
  return first ? String(first.value || '') : '';
}

async function fetchDeckNoteIds(client, deckName) {
  const query = `deck:"${escapeQueryValue(deckName)}"`;
  const noteIds = await client.invoke('findNotes', { query });
  if (!Array.isArray(noteIds)) return [];
  return noteIds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
}

async function fetchNotesInfoInBatches(client, noteIds, batchSize) {
  const rows = [];
  for (let i = 0; i < noteIds.length; i += batchSize) {
    const chunk = noteIds.slice(i, i + batchSize);
    if (chunk.length === 0) continue;
    const result = await client.invoke('notesInfo', { notes: chunk });
    if (!Array.isArray(result)) continue;
    rows.push(...result);
  }
  return rows;
}

async function buildDeckLexicon(client, deckName, options = {}) {
  const maxNotes = parseInteger(options.maxNotes, DEFAULT_MAX_NOTES_PER_DECK);
  const batch = parseInteger(options.batch, DEFAULT_BATCH_SIZE);

  const allIds = await fetchDeckNoteIds(client, deckName);
  const noteIds = allIds.slice(0, maxNotes);
  const notes = await fetchNotesInfoInBatches(client, noteIds, batch);

  const terms = [];
  const seen = new Set();
  for (const note of notes) {
    const front = pickFrontField(note);
    for (const candidate of extractTermCandidates(front)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      terms.push(candidate);
    }
  }
  return {
    deckName,
    scannedNotes: noteIds.length,
    totalNotes: allIds.length,
    terms,
  };
}

function writeLexiconFile(outputPath, payload) {
  const target = path.resolve(outputPath || DEFAULT_OUTPUT_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const decks = uniqueStrings(args.decks.length > 0 ? args.decks : defaultDecks());
  if (decks.length === 0) {
    throw new Error('no decks specified. pass --decks or set ankiPolicy.toeicDeck');
  }

  const client = new AnkiConnect();
  const mergedTerms = [];
  const mergedSeen = new Set();
  const deckStats = [];
  for (const deckName of decks) {
    const row = await buildDeckLexicon(client, deckName, {
      maxNotes: args.maxNotes,
      batch: args.batch,
    });
    deckStats.push({
      deckName: row.deckName,
      scannedNotes: row.scannedNotes,
      totalNotes: row.totalNotes,
      termCount: row.terms.length,
    });
    for (const term of row.terms) {
      if (mergedSeen.has(term)) continue;
      mergedSeen.add(term);
      mergedTerms.push(term);
    }
  }

  const output = writeLexiconFile(args.output, {
    updatedAt: new Date().toISOString(),
    decks,
    config: {
      maxNotesPerDeck: args.maxNotes,
      batchSize: args.batch,
    },
    stats: deckStats,
    termCount: mergedTerms.length,
    terms: mergedTerms,
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    output,
    decks,
    stats: deckStats,
    termCount: mergedTerms.length,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildDeckLexicon,
  extractTermCandidates,
  pickFrontField,
};
