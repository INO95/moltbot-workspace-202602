#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const anki = require('./anki_connect');

const TARGET_DECKS = new Set(['TOEIC_AI', '단어::영단어::2603TOEIC', '단어::영단어::Eng_Voca']);

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

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp14() {
    return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
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

function wordCandidates(word) {
    const w = normalizeInline(word).toLowerCase();
    if (!w) return [];
    const out = [w];
    if (!w.includes(' ')) {
        if (w.endsWith('ies') && w.length > 4) out.push(`${w.slice(0, -3)}y`);
        if (w.endsWith('s') && w.length > 3) out.push(w.slice(0, -1));
        if (w.endsWith('ing') && w.length > 5) {
            const stem = w.slice(0, -3);
            out.push(stem, `${stem}e`);
        }
        if (w.endsWith('ed') && w.length > 4) {
            const stem = w.slice(0, -2);
            out.push(stem, `${stem}e`);
        }
    }
    return [...new Set(out.filter(Boolean))];
}

function mentionsWord(example, word) {
    const ex = normalizeInline(example).toLowerCase();
    if (!ex) return false;
    return wordCandidates(word).some((c) => ex.includes(c));
}

function parseBasicAnswer(rawAnswer) {
    const txt = htmlToText(rawAnswer);
    const meaningMatch = txt.match(/(?:^|\n)\s*뜻\s*[:：]\s*(.+?)(?=(?:\n\s*품사\s*[:：]|\n\s*예문\s*[:：]|\n\s*해석\s*[:：]|\n\s*💡|$))/i);
    const posMatch = txt.match(/(?:^|\n)\s*품사\s*[:：]\s*(.+?)(?=(?:\n|$))/i);
    const meaningKo = normalizeInline(meaningMatch ? meaningMatch[1] : '');
    const partOfSpeech = normalizeInline(posMatch ? posMatch[1] : '');
    return { meaningKo, partOfSpeech, sourceText: txt };
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
    const noteId = Number(raw && raw.noteId);
    return {
        noteId,
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

function findLatestExtractSource() {
    const reportsDir = path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) return '';
    const files = fs.readdirSync(reportsDir)
        .filter((f) => /^anki_20_words_for_gpt_\d{14}\.json$/.test(f))
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.input) {
        throw new Error('Usage: node scripts/anki_apply_gpt_batch.js --input <gpt_output.json> [--source <extract_json>] [--apply]');
    }

    const inputPath = path.resolve(args.input);
    if (!fs.existsSync(inputPath)) {
        throw new Error(`input file not found: ${inputPath}`);
    }

    const sourcePath = args.source
        ? path.resolve(args.source)
        : findLatestExtractSource();

    const sourceMap = new Map();
    if (sourcePath && fs.existsSync(sourcePath)) {
        const sourcePayload = parseJsonRelaxed(fs.readFileSync(sourcePath, 'utf8'));
        for (const [k, v] of buildSourceMap(sourcePayload).entries()) sourceMap.set(k, v);
    }

    const rawInput = parseJsonRelaxed(fs.readFileSync(inputPath, 'utf8'));
    const records = pickRecords(rawInput).map(toRecord);

    const ts = timestamp14();
    const reportPath = path.join(__dirname, '..', 'logs', `anki_apply_20_report_${ts}.json`);

    const report = {
        createdAt: new Date().toISOString(),
        apply: Boolean(args.apply),
        scope: args.scope,
        inputPath,
        sourcePath: sourcePath || null,
        totals: {
            received: records.length,
            valid: 0,
            invalid: 0,
            applied: 0,
            failed: 0,
        },
        invalid: [],
        updates: [],
    };

    const dup = new Set();
    const seen = new Set();
    for (const row of records) {
        if (!Number.isFinite(row.noteId)) continue;
        if (seen.has(row.noteId)) dup.add(row.noteId);
        seen.add(row.noteId);
    }

    const noteIds = [...new Set(records.map((r) => Number(r.noteId)).filter(Number.isFinite))];
    const notesById = new Map();
    for (const batch of chunk(noteIds, 200)) {
        if (!batch.length) continue;
        const notes = await anki.invoke('notesInfo', { notes: batch });
        for (const note of notes) notesById.set(Number(note.noteId), note);
    }

    const allCardIds = [...new Set([...notesById.values()].flatMap((n) => Array.isArray(n.cards) ? n.cards.map(Number) : []))];
    const cardsById = new Map();
    for (const batch of chunk(allCardIds, 200)) {
        if (!batch.length) continue;
        const rows = await anki.invoke('cardsInfo', { cards: batch });
        for (const row of rows) cardsById.set(Number(row.cardId), row);
    }

    const validOps = [];

    for (const row of records) {
        const reasons = [];
        if (!Number.isFinite(row.noteId)) reasons.push('invalid_note_id');
        if (dup.has(row.noteId)) reasons.push('duplicate_note_id');

        const note = notesById.get(row.noteId);
        if (!note) reasons.push('note_not_found');

        let deck = '';
        if (note) {
            const cards = Array.isArray(note.cards) ? note.cards.map((cid) => cardsById.get(Number(cid))).filter(Boolean) : [];
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

        let updateFields = null;

        if (!reasons.length) {
            if (fields.Clean_Word && fields.Sentence_Mean) {
                updateFields = {
                    Example_Sentence: row.exampleEn,
                    Sentence_Mean: buildEngVocaSentenceMean(row.exampleEn, row.exampleKo, row.toeicTip),
                };
            } else if (fields.Question && fields.Answer) {
                const parsed = parseBasicAnswer(fields.Answer.value || '');
                const meaningKo = parsed.meaningKo || (source ? source.currentMeaningKo : '');
                const partOfSpeech = parsed.partOfSpeech || '';
                if (!meaningKo) {
                    reasons.push('unable_to_preserve_meaning');
                } else {
                    updateFields = {
                        Answer: buildBasicAnswer(meaningKo, partOfSpeech, row.exampleEn, row.exampleKo, row.toeicTip),
                    };
                }
            } else {
                reasons.push('unsupported_note_model');
            }
        }

        if (reasons.length) {
            report.totals.invalid += 1;
            report.invalid.push({
                noteId: row.noteId,
                deck,
                model,
                word,
                reasons,
            });
            continue;
        }

        report.totals.valid += 1;
        validOps.push({
            noteId: row.noteId,
            deck,
            model,
            word,
            fields: updateFields,
        });
    }

    for (const op of validOps) {
        if (!args.apply) {
            report.updates.push({
                noteId: op.noteId,
                deck: op.deck,
                model: op.model,
                word: op.word,
                mode: 'dry-run',
                fieldKeys: Object.keys(op.fields || {}),
            });
            continue;
        }
        try {
            await anki.invoke('updateNoteFields', {
                note: {
                    id: Number(op.noteId),
                    fields: op.fields,
                },
            });
            await anki.invoke('addTags', {
                notes: [Number(op.noteId)],
                tags: 'quality:gpt52',
            });
            report.totals.applied += 1;
            report.updates.push({
                noteId: op.noteId,
                deck: op.deck,
                model: op.model,
                word: op.word,
                mode: 'applied',
                fieldKeys: Object.keys(op.fields || {}),
            });
        } catch (error) {
            report.totals.failed += 1;
            report.updates.push({
                noteId: op.noteId,
                deck: op.deck,
                model: op.model,
                word: op.word,
                mode: 'failed',
                reason: String(error.message || error),
            });
        }
    }

    if (args.apply && args.sync) {
        try {
            await anki.syncWithDelay();
        } catch (error) {
            report.updates.push({ mode: 'sync_warning', reason: String(error.message || error) });
        }
    }

    ensureDir(reportPath);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    console.log(JSON.stringify({
        ok: true,
        apply: report.apply,
        reportPath,
        totals: report.totals,
        invalid: report.invalid.length,
        readyToApply: validOps.length,
    }, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}
