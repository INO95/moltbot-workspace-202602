#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const anki = require('./anki_connect');

const DEFAULT_DECKS = ['TOEIC_AI', '단어::영단어::2603TOEIC', '단어::영단어::Eng_Voca'];

function parseArgs(argv) {
    const out = {
        count: 20,
        split: [7, 9, 4],
        decks: [...DEFAULT_DECKS],
        priority: 'issue-first',
    };
    for (let i = 0; i < argv.length; i += 1) {
        const token = String(argv[i] || '').trim();
        if (token === '--count' && argv[i + 1]) {
            out.count = Math.max(1, Number(argv[i + 1] || out.count));
            i += 1;
        } else if (token === '--split' && argv[i + 1]) {
            out.split = String(argv[i + 1] || '')
                .split(',')
                .map((v) => Number(v.trim()))
                .filter((v) => Number.isFinite(v) && v >= 0);
            i += 1;
        } else if (token === '--decks' && argv[i + 1]) {
            out.decks = String(argv[i + 1] || '')
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean);
            i += 1;
        } else if (token === '--priority' && argv[i + 1]) {
            out.priority = String(argv[i + 1] || out.priority).trim();
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

function splitQuota(total, requestedSplit, deckCount) {
    const base = Array.from({ length: deckCount }, (_, i) => Number(requestedSplit[i] || 0));
    let sum = base.reduce((a, b) => a + b, 0);
    if (sum === total) return base;
    if (sum === 0) {
        const even = Math.floor(total / deckCount);
        const arr = Array.from({ length: deckCount }, () => even);
        let rem = total - even * deckCount;
        for (let i = 0; i < deckCount && rem > 0; i += 1, rem -= 1) arr[i] += 1;
        return arr;
    }
    // Scale proportionally, then distribute remainder.
    const scaled = base.map((v) => Math.floor((v / sum) * total));
    let rem = total - scaled.reduce((a, b) => a + b, 0);
    const order = [...base.keys()].sort((a, b) => base[b] - base[a]);
    let idx = 0;
    while (rem > 0) {
        const i = order[idx % order.length];
        scaled[i] += 1;
        rem -= 1;
        idx += 1;
    }
    return scaled;
}

function isSentenceLike(text) {
    const t = normalizeInline(text);
    if (!t) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length >= 6) return true;
    if (/[.?!]$/.test(t)) return true;
    if (/[,;:]/.test(t)) return true;
    return false;
}

function isWordLike(text) {
    const t = normalizeInline(text);
    if (!t) return false;
    if (hasKorean(t)) return false;
    if (isSentenceLike(t)) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 5) return false;
    return /^[A-Za-z0-9' -]+$/.test(t);
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
    const cands = wordCandidates(word);
    if (!cands.length) return false;
    return cands.some((c) => ex.includes(c));
}

function parseBasicBack(rawBack) {
    const txt = htmlToText(rawBack);
    const meaningMatch = txt.match(/(?:^|\n)\s*뜻\s*[:：]\s*(.+?)(?=(?:\n\s*품사\s*[:：]|\n\s*예문\s*[:：]|\n\s*해석\s*[:：]|\n\s*💡|$))/i);
    const exampleMatch = txt.match(/(?:^|\n)\s*예문\s*[:：]\s*(.+?)(?=(?:\n\s*예문\s*해석\s*[:：]|\n\s*해석\s*[:：]|\n\s*💡|$))/i);
    const exampleKoMatch = txt.match(/(?:^|\n)\s*(?:예문\s*해석|해석)\s*[:：]\s*(.+?)(?=(?:\n\s*💡|$))/i);
    const tipMatch = txt.match(/(?:^|\n)\s*💡?\s*TOEIC TIP\s*[:：]\s*([\s\S]+)$/i);
    const posMatch = txt.match(/(?:^|\n)\s*품사\s*[:：]\s*(.+?)(?=(?:\n|$))/i);

    const meaningKo = normalizeInline(meaningMatch ? meaningMatch[1] : '');
    const exampleEn = normalizeInline(exampleMatch ? exampleMatch[1] : '');
    const exampleKo = normalizeInline(exampleKoMatch ? exampleKoMatch[1] : '');
    const tip = normalizeInline(tipMatch ? tipMatch[1] : '');
    const partOfSpeech = normalizeInline(posMatch ? posMatch[1] : '');

    return {
        meaningKo,
        exampleEn,
        exampleKo,
        tip,
        partOfSpeech,
        sourceText: txt,
    };
}

function parseSentenceMean(raw) {
    const txt = htmlToText(raw);
    const exampleMatch = txt.match(/(?:^|\n)\s*예문\s*[:：]\s*(.+?)(?=(?:\n\s*해석\s*[:：]|\n\s*💡|$))/i);
    const exampleKoMatch = txt.match(/(?:^|\n)\s*해석\s*[:：]\s*(.+?)(?=(?:\n\s*💡|$))/i);
    const tipMatch = txt.match(/(?:^|\n)\s*💡?\s*TOEIC TIP\s*[:：]\s*([\s\S]+)$/i);
    return {
        exampleEn: normalizeInline(exampleMatch ? exampleMatch[1] : ''),
        exampleKo: normalizeInline(exampleKoMatch ? exampleKoMatch[1] : ''),
        tip: normalizeInline(tipMatch ? tipMatch[1] : ''),
        sourceText: txt,
    };
}

function normalizeFrame(example, word) {
    let k = normalizeInline(example).toLowerCase();
    if (!k) return '';
    for (const c of wordCandidates(word)) {
        const safe = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        k = k.replace(new RegExp(`\\b${safe}\\b`, 'gi'), '[W]');
    }
    k = k
        .replace(/"[^"]+"/g, '"X"')
        .replace(/\[[^\]]+\]/g, '[X]')
        .replace(/\b\d+\b/g, 'N')
        .replace(/\s+/g, ' ')
        .trim();
    return k;
}

function riskScore(item, frameFreqMap) {
    const reasons = [];
    let score = 0;
    const ex = normalizeInline(item.currentExampleEn);
    const ko = normalizeInline(item.currentExampleKo);
    const tip = normalizeInline(item.currentTip);
    const meaning = normalizeInline(item.currentMeaningKo);

    if (!ex) {
        score += 35;
        reasons.push('missing_example');
    }
    if (!ko) {
        score += 16;
        reasons.push('missing_translation');
    }
    if (!tip) {
        score += 18;
        reasons.push('missing_tip');
    }
    if (!meaning) {
        score += 12;
        reasons.push('missing_meaning');
    }

    if (ex) {
        const frame = normalizeFrame(ex, item.word);
        const freq = Number(frameFreqMap.get(frame) || 0);
        if (freq >= 2) {
            const add = Math.min(36, (freq - 1) * 8);
            score += add;
            reasons.push(`repeated_frame_x${freq}`);
        }

        if (!mentionsWord(ex, item.word)) {
            score += 15;
            reasons.push('word_not_in_example');
        }

        if (/the manager asked the team to/i.test(ex)) {
            score += 24;
            reasons.push('generic_template_manager');
        }
        if (/the expression\s+".+"\s+appears frequently in policy and contract documents/i.test(ex)) {
            score += 24;
            reasons.push('generic_template_expression');
        }
        if (/must be reviewed by both parties before the contract is finalized/i.test(ex)) {
            score += 22;
            reasons.push('generic_template_contract');
        }
        if (/\ba\s+[aeiou]/i.test(ex)) {
            score += 12;
            reasons.push('grammar_article_mismatch');
        }
        if (ex.length < 35) {
            score += 8;
            reasons.push('example_too_short');
        }
    }

    if (tip && !/(Part|파트|함정|콜로케이션|collocation|전치사|품사|수일치|빈출|자주)/i.test(tip)) {
        score += 10;
        reasons.push('tip_not_actionable');
    }

    if (!ko || (ex && ko && !hasKorean(ko))) {
        score += 8;
        reasons.push('translation_not_korean');
    }

    return {
        score,
        reasons: [...new Set(reasons)],
    };
}

async function fetchDeckNotes(deck) {
    const query = `deck:"${String(deck || '').replace(/"/g, '\\"')}"`;
    const ids = await anki.invoke('findNotes', { query });
    const out = [];
    for (const batch of chunk(ids, 200)) {
        if (!batch.length) continue;
        const notes = await anki.invoke('notesInfo', { notes: batch });
        for (const note of notes) out.push(note);
    }
    return out;
}

function noteToCandidate(deck, note) {
    const fields = note.fields || {};
    const model = String(note.modelName || '');

    if (fields.Clean_Word) {
        const word = normalizeInline(htmlToText(fields.Clean_Word.value || ''));
        const meaning = normalizeInline(htmlToText(fields.Cleam_Word_Mean ? fields.Cleam_Word_Mean.value : ''));
        const exField = normalizeInline(htmlToText(fields.Example_Sentence ? fields.Example_Sentence.value : ''));
        const parsed = parseSentenceMean(fields.Sentence_Mean ? fields.Sentence_Mean.value : '');
        const exampleEn = exField || parsed.exampleEn;
        const exampleKo = parsed.exampleKo;
        const tip = parsed.tip;
        if (!isWordLike(word)) return null;
        return {
            noteId: Number(note.noteId),
            deck,
            model,
            word,
            currentMeaningKo: meaning,
            currentExampleEn: exampleEn,
            currentExampleKo: exampleKo,
            currentTip: tip,
        };
    }

    if (fields.Question && fields.Answer) {
        const word = normalizeInline(htmlToText(fields.Question.value || ''));
        if (!isWordLike(word)) return null;
        const parsed = parseBasicBack(fields.Answer.value || '');
        return {
            noteId: Number(note.noteId),
            deck,
            model,
            word,
            currentMeaningKo: parsed.meaningKo,
            currentExampleEn: parsed.exampleEn,
            currentExampleKo: parsed.exampleKo,
            currentTip: parsed.tip,
            currentPartOfSpeech: parsed.partOfSpeech,
        };
    }

    return null;
}

function writeJson(filePath, payload) {
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function writeText(filePath, text) {
    ensureDir(filePath);
    fs.writeFileSync(filePath, String(text || ''), 'utf8');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const quotas = splitQuota(args.count, args.split, args.decks.length);
    const ts = timestamp14();
    const jsonPath = path.join(__dirname, '..', 'reports', `anki_20_words_for_gpt_${ts}.json`);
    const mdPath = path.join(__dirname, '..', 'reports', `anki_20_words_for_gpt_${ts}.md`);

    const deckCandidates = [];
    const allCandidates = [];

    for (let i = 0; i < args.decks.length; i += 1) {
        const deck = args.decks[i];
        const notes = await fetchDeckNotes(deck);
        const candidates = [];
        for (const note of notes) {
            const row = noteToCandidate(deck, note);
            if (row) candidates.push(row);
        }

        const frameFreq = new Map();
        for (const row of candidates) {
            const key = normalizeFrame(row.currentExampleEn, row.word);
            if (!key) continue;
            frameFreq.set(key, Number(frameFreq.get(key) || 0) + 1);
        }

        for (const row of candidates) {
            const risk = riskScore(row, frameFreq);
            row.riskScore = risk.score;
            row.riskReasons = risk.reasons;
            row.frameKey = normalizeFrame(row.currentExampleEn, row.word);
            row.frameFrequency = Number(frameFreq.get(row.frameKey) || 0);
            allCandidates.push(row);
        }

        const sorted = [...candidates]
            .map((row) => {
                const risk = riskScore(row, frameFreq);
                return {
                    ...row,
                    riskScore: risk.score,
                    riskReasons: risk.reasons,
                    frameKey: normalizeFrame(row.currentExampleEn, row.word),
                    frameFrequency: Number(frameFreq.get(normalizeFrame(row.currentExampleEn, row.word)) || 0),
                };
            })
            .sort((a, b) => b.riskScore - a.riskScore || a.noteId - b.noteId);

        deckCandidates.push({
            deck,
            quota: Number(quotas[i] || 0),
            candidates: sorted,
            scannedNotes: notes.length,
            eligibleWordCards: sorted.length,
        });
    }

    const selected = [];
    const selectedIds = new Set();

    for (const row of deckCandidates) {
        for (const item of row.candidates) {
            if (selected.length >= args.count) break;
            if (selectedIds.has(item.noteId)) continue;
            if (selected.filter((v) => v.deck === row.deck).length >= row.quota) continue;
            selected.push(item);
            selectedIds.add(item.noteId);
        }
    }

    const leftovers = allCandidates
        .filter((row) => !selectedIds.has(row.noteId))
        .sort((a, b) => b.riskScore - a.riskScore || a.noteId - b.noteId);
    for (const row of leftovers) {
        if (selected.length >= args.count) break;
        selected.push(row);
        selectedIds.add(row.noteId);
    }

    const gptInput = selected.map((row) => ({
        noteId: row.noteId,
        deck: row.deck,
        word: row.word,
        currentMeaningKo: row.currentMeaningKo || '',
        currentExampleEn: row.currentExampleEn || '',
        currentExampleKo: row.currentExampleKo || '',
        currentTip: row.currentTip || '',
    }));

    const payload = {
        createdAt: new Date().toISOString(),
        count: selected.length,
        requestedCount: args.count,
        split: quotas,
        decks: args.decks,
        priority: args.priority,
        selection: selected,
        gptInput,
        expectedGptOutputSchema: {
            type: 'array',
            item: {
                noteId: 'number',
                exampleEn: 'string',
                exampleKo: 'string',
                toeicTip: 'string',
            },
        },
    };
    writeJson(jsonPath, payload);

    const lines = [];
    lines.push(`# Anki 20-Card GPT Batch (${new Date().toISOString()})`);
    lines.push('');
    lines.push(`- Count: ${selected.length}`);
    lines.push(`- Split: ${args.decks.map((deck, i) => `${deck}=${quotas[i] || 0}`).join(', ')}`);
    lines.push(`- Priority: ${args.priority}`);
    lines.push('');
    lines.push('## Selected Cards');
    lines.push('');

    for (let i = 0; i < selected.length; i += 1) {
        const row = selected[i];
        lines.push(`${i + 1}. [${row.deck}] noteId=${row.noteId} word=${row.word}`);
        lines.push(`   - riskScore=${row.riskScore}`);
        lines.push(`   - reasons=${(row.riskReasons || []).join(', ') || 'n/a'}`);
        lines.push(`   - currentExampleEn=${row.currentExampleEn || '(empty)'}`);
        lines.push(`   - currentExampleKo=${row.currentExampleKo || '(empty)'}`);
        lines.push(`   - currentTip=${row.currentTip || '(empty)'}`);
    }

    lines.push('');
    lines.push('## GPT Output Contract');
    lines.push('');
    lines.push('Return JSON array with objects:');
    lines.push('- noteId (number)');
    lines.push('- exampleEn (string)');
    lines.push('- exampleKo (string)');
    lines.push('- toeicTip (string)');

    writeText(mdPath, lines.join('\n'));

    console.log(JSON.stringify({
        ok: true,
        jsonPath,
        mdPath,
        selected: selected.length,
        split: quotas,
        deckStats: deckCandidates.map((row) => ({
            deck: row.deck,
            quota: row.quota,
            scannedNotes: row.scannedNotes,
            eligibleWordCards: row.eligibleWordCards,
        })),
    }, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}
