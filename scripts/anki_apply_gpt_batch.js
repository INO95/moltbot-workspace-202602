#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const anki = require('./anki_connect');

const ROOT = path.join(__dirname, '..');
const TARGET_DECKS = new Set(['TOEIC_AI', '단어::영단어::2603TOEIC', '단어::영단어::Eng_Voca']);
const AUDIT_LOG_REL = path.join('logs', 'anki_quality_pipeline.jsonl');
const LATEST_SUMMARY_REL = path.join('logs', 'anki_quality_pipeline_latest.json');
const EXTRACT_JSON_REL = path.join('reports', 'anki_20_words_for_gpt_latest.json');

function parseArgs(argv) {
    const out = {
        input: '',
        source: '',
        apply: false,
        sync: true,
        scope: 'example_only',
    };
    for (let i = 0; i < argv.length; i += 1) {
        const token = String(argv[i] || '').trim();
        if (token === '--input' && argv[i + 1]) {
            out.input = String(argv[i + 1] || '').trim();
            i += 1;
        } else if (token === '--source' && argv[i + 1]) {
            out.source = String(argv[i + 1] || '').trim();
            i += 1;
        } else if (token === '--apply') {
            out.apply = true;
        } else if (token === '--dry-run') {
            out.apply = false;
        } else if (token === '--no-sync') {
            out.sync = false;
        } else if (token === '--scope' && argv[i + 1]) {
            out.scope = String(argv[i + 1] || out.scope).trim();
            i += 1;
        }
    }
    return out;
}

function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function writeFileAtomic(filePath, text) {
    ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, String(text || ''), 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function writeJsonAtomic(filePath, payload) {
    writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function appendJsonl(filePath, row) {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function createNowFn(now) {
    if (typeof now === 'function') {
        return () => {
            const value = now();
            return value instanceof Date ? value : new Date(value);
        };
    }
    if (now) {
        return () => (now instanceof Date ? now : new Date(now));
    }
    return () => new Date();
}

function createRunId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `anki-quality-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveRootDir(input) {
    return input ? path.resolve(String(input)) : ROOT;
}

function updateLatestSummary(rootDir, stage, payload) {
    const summaryPath = path.join(rootDir, LATEST_SUMMARY_REL);
    const current = readJson(summaryPath, {
        schema_version: '1.0',
        updatedAt: null,
        stages: {},
    });
    const next = {
        ...current,
        schema_version: '1.0',
        updatedAt: payload.ts || new Date().toISOString(),
        stages: {
            ...(current && current.stages ? current.stages : {}),
            [stage]: payload,
        },
    };
    writeJsonAtomic(summaryPath, next);
    return summaryPath;
}

function decodeHtmlEntities(text) {
    return String(text || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#39;/gi, '\'')
        .replace(/&quot;/gi, '"');
}

function htmlToText(html) {
    return decodeHtmlEntities(String(html || ''))
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeInline(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function hasKorean(text) {
    return /[가-힣]/.test(String(text || ''));
}

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeTag(tag) {
    return String(tag || '').trim().toLowerCase();
}

function normalizeTags(tags) {
    return Array.isArray(tags)
        ? tags.map((tag) => normalizeTag(tag)).filter(Boolean)
        : [];
}

function wordCandidates(word) {
    const normalized = normalizeInline(word).toLowerCase();
    if (!normalized) return [];
    const out = [normalized];
    if (!normalized.includes(' ')) {
        if (normalized.endsWith('ies') && normalized.length > 4) out.push(`${normalized.slice(0, -3)}y`);
        if (normalized.endsWith('s') && normalized.length > 3) out.push(normalized.slice(0, -1));
        if (normalized.endsWith('ing') && normalized.length > 5) {
            const stem = normalized.slice(0, -3);
            out.push(stem, `${stem}e`);
        }
        if (normalized.endsWith('ed') && normalized.length > 4) {
            const stem = normalized.slice(0, -2);
            out.push(stem, `${stem}e`);
        }
    }
    return [...new Set(out.filter(Boolean))];
}

function mentionsWord(example, word) {
    const normalized = normalizeInline(example).toLowerCase();
    if (!normalized) return false;
    return wordCandidates(word).some((candidate) => normalized.includes(candidate));
}

function parseBasicAnswer(rawAnswer) {
    const text = htmlToText(rawAnswer);
    const meaningMatch = text.match(/(?:^|\n)\s*뜻\s*[:：]\s*(.+?)(?=(?:\n\s*품사\s*[:：]|\n\s*예문\s*[:：]|\n\s*해석\s*[:：]|\n\s*💡|$))/i);
    const posMatch = text.match(/(?:^|\n)\s*품사\s*[:：]\s*(.+?)(?=(?:\n|$))/i);
    return {
        meaningKo: normalizeInline(meaningMatch ? meaningMatch[1] : ''),
        partOfSpeech: normalizeInline(posMatch ? posMatch[1] : ''),
    };
}

function parseJsonRelaxed(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('empty input json');
    if (text.startsWith('```')) {
        const cleaned = text
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```\s*$/i, '');
        return JSON.parse(cleaned);
    }
    return JSON.parse(text);
}

function pickRecords(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.items)) return payload.items;
    if (payload && Array.isArray(payload.records)) return payload.records;
    if (payload && Array.isArray(payload.output)) return payload.output;
    if (payload && Array.isArray(payload.result)) return payload.result;
    throw new Error('input json must be an array or contain items/records/output/result array');
}

function toRecord(raw) {
    return {
        noteId: Number(raw && raw.noteId),
        exampleEn: normalizeInline(raw && raw.exampleEn),
        exampleKo: normalizeInline(raw && raw.exampleKo),
        toeicTip: normalizeInline(raw && raw.toeicTip),
    };
}

function inferDeckFromCards(cardsInfoRows = []) {
    for (const row of cardsInfoRows) {
        const deckName = String(row.deckName || '').trim();
        if (TARGET_DECKS.has(deckName)) return deckName;
    }
    return '';
}

function findLatestExtractSource(rootDir = ROOT) {
    const reportsDir = path.join(rootDir, 'reports');
    const stable = path.join(rootDir, EXTRACT_JSON_REL);
    if (fs.existsSync(stable)) return stable;
    if (!fs.existsSync(reportsDir)) return '';
    const files = fs.readdirSync(reportsDir)
        .filter((fileName) => /^anki_20_words_for_gpt_\d{14}\.json$/.test(fileName))
        .sort()
        .reverse();
    return files.length ? path.join(reportsDir, files[0]) : '';
}

function buildSourceMap(sourcePayload) {
    const map = new Map();
    const rows = Array.isArray(sourcePayload && sourcePayload.gptInput)
        ? sourcePayload.gptInput
        : Array.isArray(sourcePayload)
            ? sourcePayload
            : [];
    for (const row of rows) {
        const noteId = Number(row.noteId);
        if (!Number.isFinite(noteId)) continue;
        map.set(noteId, {
            noteId,
            deck: normalizeInline(row.deck),
            word: normalizeInline(row.word),
            currentMeaningKo: normalizeInline(row.currentMeaningKo),
        });
    }
    return map;
}

function buildBasicAnswer(meaningKo, partOfSpeech, exampleEn, exampleKo, toeicTip) {
    const lines = [];
    if (meaningKo) lines.push(`뜻: <b>${escapeHtml(meaningKo)}</b>`);
    if (partOfSpeech) lines.push(`품사: ${escapeHtml(partOfSpeech)}`);
    lines.push(`예문: <i>${escapeHtml(exampleEn)}</i>`);
    lines.push(`예문 해석: ${escapeHtml(exampleKo)}`);
    lines.push(`💡 <b>TOEIC TIP:</b> ${escapeHtml(toeicTip)}`);
    return lines.join('<br>');
}

function buildEngVocaSentenceMean(exampleEn, exampleKo, toeicTip) {
    return [
        `예문: ${escapeHtml(exampleEn)}`,
        '',
        `해석: ${escapeHtml(exampleKo)}`,
        '',
        '💡 TOEIC TIP:',
        escapeHtml(toeicTip),
    ].join('<br>');
}

function buildDesiredUpdate(note, row, source) {
    const fields = note && note.fields ? note.fields : {};
    if (fields.Clean_Word && fields.Sentence_Mean) {
        return {
            fields: {
                Example_Sentence: row.exampleEn,
                Sentence_Mean: buildEngVocaSentenceMean(row.exampleEn, row.exampleKo, row.toeicTip),
            },
            reasons: [],
        };
    }
    if (fields.Question && fields.Answer) {
        const parsed = parseBasicAnswer(fields.Answer.value || '');
        const meaningKo = parsed.meaningKo || (source ? source.currentMeaningKo : '');
        const partOfSpeech = parsed.partOfSpeech || '';
        if (!meaningKo) {
            return {
                fields: null,
                reasons: ['unable_to_preserve_meaning'],
            };
        }
        return {
            fields: {
                Answer: buildBasicAnswer(meaningKo, partOfSpeech, row.exampleEn, row.exampleKo, row.toeicTip),
            },
            reasons: [],
        };
    }
    return {
        fields: null,
        reasons: ['unsupported_note_model'],
    };
}

function diffFieldKeys(note, desiredFields) {
    const currentFields = note && note.fields ? note.fields : {};
    const changed = [];
    for (const [key, value] of Object.entries(desiredFields || {})) {
        const currentValue = currentFields[key] && Object.prototype.hasOwnProperty.call(currentFields[key], 'value')
            ? currentFields[key].value
            : '';
        if (String(currentValue || '').trim() !== String(value || '').trim()) changed.push(key);
    }
    return changed;
}

function diffTags(noteTags, desiredTags) {
    const current = new Set(normalizeTags(noteTags));
    return desiredTags.filter((tag) => !current.has(normalizeTag(tag)));
}

function pushSample(target, row, limit = 15) {
    if (target.length >= limit) return;
    target.push(row);
}

async function runApplyGptBatch(argv, deps = {}) {
    const args = parseArgs(argv);
    if (!args.input) {
        throw new Error('Usage: node scripts/anki_apply_gpt_batch.js --input <gpt_output.json> [--source <extract_json>] [--apply]');
    }

    const ankiClient = deps.anki || anki;
    const rootDir = resolveRootDir(deps.rootDir);
    const nowFn = createNowFn(deps.now);
    const nowIso = nowFn().toISOString();
    const runId = deps.runId || createRunId();
    const inputPath = path.resolve(rootDir, args.input);
    if (!fs.existsSync(inputPath)) {
        throw new Error(`input file not found: ${inputPath}`);
    }

    const sourcePath = args.source
        ? path.resolve(rootDir, args.source)
        : findLatestExtractSource(rootDir);

    const sourceMap = new Map();
    if (sourcePath && fs.existsSync(sourcePath)) {
        const sourcePayload = parseJsonRelaxed(fs.readFileSync(sourcePath, 'utf8'));
        for (const [key, value] of buildSourceMap(sourcePayload).entries()) sourceMap.set(key, value);
    }

    const rawInput = parseJsonRelaxed(fs.readFileSync(inputPath, 'utf8'));
    const records = pickRecords(rawInput).map(toRecord);
    const noteIds = [...new Set(records.map((row) => Number(row.noteId)).filter(Number.isFinite))];
    const notesById = new Map();

    for (const batch of chunk(noteIds, 200)) {
        if (!batch.length) continue;
        const notes = await ankiClient.invoke('notesInfo', { notes: batch });
        for (const note of notes) notesById.set(Number(note.noteId), note);
    }

    const allCardIds = [...new Set(
        [...notesById.values()]
            .flatMap((note) => (Array.isArray(note.cards) ? note.cards.map(Number) : []))
            .filter(Number.isFinite)
    )];
    const cardsById = new Map();
    for (const batch of chunk(allCardIds, 200)) {
        if (!batch.length) continue;
        const rows = await ankiClient.invoke('cardsInfo', { cards: batch });
        for (const row of rows) cardsById.set(Number(row.cardId), row);
    }

    const duplicateNoteIds = new Set();
    const seenNoteIds = new Set();
    for (const row of records) {
        if (!Number.isFinite(row.noteId)) continue;
        if (seenNoteIds.has(row.noteId)) duplicateNoteIds.add(row.noteId);
        seenNoteIds.add(row.noteId);
    }

    const totals = {
        received: records.length,
        invalid: 0,
        ready: 0,
        skipped_unchanged: 0,
        applied: 0,
        failed: 0,
    };
    const invalid = [];
    const operations = [];
    const sample = [];

    for (const row of records) {
        const reasons = [];
        if (!Number.isFinite(row.noteId)) reasons.push('invalid_note_id');
        if (duplicateNoteIds.has(row.noteId)) reasons.push('duplicate_note_id');

        const note = notesById.get(row.noteId);
        if (!note) reasons.push('note_not_found');

        let deck = '';
        if (note) {
            const cards = Array.isArray(note.cards)
                ? note.cards.map((cardId) => cardsById.get(Number(cardId))).filter(Boolean)
                : [];
            deck = inferDeckFromCards(cards);
            if (!deck) reasons.push('note_not_in_target_decks');
        }

        const source = sourceMap.get(row.noteId) || null;
        const fields = note && note.fields ? note.fields : {};
        const model = String(note && note.modelName ? note.modelName : '');

        let word = '';
        if (fields.Clean_Word) {
            word = normalizeInline(htmlToText(fields.Clean_Word.value || ''));
        } else if (fields.Question) {
            word = normalizeInline(htmlToText(fields.Question.value || ''));
        }
        if (!word && source && source.word) word = source.word;
        if (!word) reasons.push('missing_word_context');

        if (!row.exampleEn) reasons.push('missing_example_en');
        if (!row.exampleKo) reasons.push('missing_example_ko');
        if (!row.toeicTip) reasons.push('missing_toeic_tip');
        if (row.exampleEn && word && !mentionsWord(row.exampleEn, word)) reasons.push('example_missing_target_word');
        if (row.exampleKo && !hasKorean(row.exampleKo)) reasons.push('example_ko_not_korean');
        if (row.toeicTip && !/(Part|파트|TOEIC)/i.test(row.toeicTip)) reasons.push('tip_missing_toeic_part');
        if (row.toeicTip && !/(함정|콜로케이션|collocation|전치사|품사|수일치|빈출|자주)/i.test(row.toeicTip)) reasons.push('tip_lacks_exam_trap');
        if (source && source.deck && deck && source.deck !== deck) reasons.push('source_deck_mismatch');

        const desired = reasons.length ? { fields: null, reasons: [] } : buildDesiredUpdate(note, row, source);
        for (const reason of desired.reasons || []) reasons.push(reason);

        if (reasons.length) {
            totals.invalid += 1;
            const invalidRow = {
                noteId: row.noteId,
                deck,
                model,
                word,
                status: 'invalid',
                reasons,
            };
            invalid.push(invalidRow);
            pushSample(sample, invalidRow);
            continue;
        }

        const desiredTags = ['quality:gpt52'];
        const fieldDiffKeys = diffFieldKeys(note, desired.fields);
        const missingTags = diffTags(note.tags || [], desiredTags);
        const op = {
            noteId: row.noteId,
            deck,
            model,
            word,
            desiredFields: desired.fields,
            fieldDiffKeys,
            desiredTags,
            missingTags,
            status: fieldDiffKeys.length || missingTags.length ? 'ready' : 'skipped_unchanged',
        };
        operations.push(op);
        if (op.status === 'ready') {
            totals.ready += 1;
        } else {
            totals.skipped_unchanged += 1;
        }
        pushSample(sample, {
            noteId: op.noteId,
            deck: op.deck,
            word: op.word,
            status: op.status,
            fieldDiffKeys: op.fieldDiffKeys,
            missingTags: op.missingTags,
        });
    }

    if (args.apply) {
        for (const op of operations) {
            if (op.status !== 'ready') continue;
            try {
                if (op.fieldDiffKeys.length) {
                    const fields = {};
                    for (const key of op.fieldDiffKeys) fields[key] = op.desiredFields[key];
                    await ankiClient.invoke('updateNoteFields', {
                        note: {
                            id: Number(op.noteId),
                            fields,
                        },
                    });
                }
                if (op.missingTags.length) {
                    await ankiClient.invoke('addTags', {
                        notes: [Number(op.noteId)],
                        tags: op.missingTags.join(' '),
                    });
                }
                totals.applied += 1;
                op.status = 'applied';
            } catch (error) {
                totals.failed += 1;
                op.status = 'failed';
                op.reason = String(error.message || error);
            }
        }

        if (args.sync && totals.applied > 0) {
            try {
                await ankiClient.syncWithDelay();
            } catch (error) {
                pushSample(sample, {
                    status: 'sync_warning',
                    reason: String(error.message || error),
                });
            }
        }
    }

    const auditEvent = {
        schema_version: '1.0',
        ts: nowIso,
        run_id: runId,
        stage: 'apply_gpt',
        mode: args.apply ? 'apply' : 'dry-run',
        ok: totals.failed === 0,
        totals,
        artifacts: {
            input_path: inputPath,
            source_path: sourcePath || null,
        },
        sample,
    };
    const auditLogPath = path.join(rootDir, AUDIT_LOG_REL);
    appendJsonl(auditLogPath, auditEvent);
    const latestSummaryPath = updateLatestSummary(rootDir, 'apply_gpt', {
        stage: 'apply_gpt',
        run_id: runId,
        ts: nowIso,
        mode: args.apply ? 'apply' : 'dry-run',
        ok: auditEvent.ok,
        totals,
        artifacts: auditEvent.artifacts,
        sample,
    });

    return {
        ok: auditEvent.ok,
        stage: 'apply_gpt',
        mode: args.apply ? 'apply' : 'dry-run',
        inputPath,
        sourcePath: sourcePath || null,
        scope: args.scope,
        mutatesAnki: Boolean(args.apply),
        totals,
        invalid,
        auditLogPath,
        latestSummaryPath,
    };
}

async function main() {
    const result = await runApplyGptBatch(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}

module.exports = {
    runApplyGptBatch,
    parseArgs,
    findLatestExtractSource,
};
