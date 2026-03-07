#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const anki = require('./anki_connect');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DECKS = ['TOEIC_AI', '단어::영단어::2603TOEIC', '단어::영단어::Eng_Voca'];
const AUDIT_LOG_REL = path.join('logs', 'anki_quality_pipeline.jsonl');
const LATEST_SUMMARY_REL = path.join('logs', 'anki_quality_pipeline_latest.json');
const EXTRACT_JSON_REL = path.join('reports', 'anki_20_words_for_gpt_latest.json');
const EXTRACT_MD_REL = path.join('reports', 'anki_20_words_for_gpt_latest.md');

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
                .map((value) => Number(value.trim()))
                .filter((value) => Number.isFinite(value) && value >= 0);
            i += 1;
        } else if (token === '--decks' && argv[i + 1]) {
            out.decks = String(argv[i + 1] || '')
                .split(',')
                .map((value) => value.trim())
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

function sha256(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
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

function splitQuota(total, requestedSplit, deckCount) {
    const base = Array.from({ length: deckCount }, (_, index) => Number(requestedSplit[index] || 0));
    const sum = base.reduce((acc, cur) => acc + cur, 0);
    if (sum === total) return base;
    if (sum === 0) {
        const even = Math.floor(total / deckCount);
        const out = Array.from({ length: deckCount }, () => even);
        let remainder = total - even * deckCount;
        for (let i = 0; i < deckCount && remainder > 0; i += 1, remainder -= 1) out[i] += 1;
        return out;
    }
    const scaled = base.map((value) => Math.floor((value / sum) * total));
    let remainder = total - scaled.reduce((acc, cur) => acc + cur, 0);
    const order = [...base.keys()].sort((left, right) => base[right] - base[left]);
    let index = 0;
    while (remainder > 0) {
        const target = order[index % order.length];
        scaled[target] += 1;
        remainder -= 1;
        index += 1;
    }
    return scaled;
}

function isSentenceLike(text) {
    const normalized = normalizeInline(text);
    if (!normalized) return false;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length >= 6) return true;
    if (/[.?!]$/.test(normalized)) return true;
    if (/[,;:]/.test(normalized)) return true;
    return false;
}

function isWordLike(text) {
    const normalized = normalizeInline(text);
    if (!normalized) return false;
    if (hasKorean(normalized)) return false;
    if (isSentenceLike(normalized)) return false;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length > 5) return false;
    return /^[A-Za-z0-9' -]+$/.test(normalized);
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
    const candidates = wordCandidates(word);
    if (!candidates.length) return false;
    return candidates.some((candidate) => normalized.includes(candidate));
}

function parseBasicBack(rawBack) {
    const text = htmlToText(rawBack);
    const meaningMatch = text.match(/(?:^|\n)\s*뜻\s*[:：]\s*(.+?)(?=(?:\n\s*품사\s*[:：]|\n\s*예문\s*[:：]|\n\s*해석\s*[:：]|\n\s*💡|$))/i);
    const exampleMatch = text.match(/(?:^|\n)\s*예문\s*[:：]\s*(.+?)(?=(?:\n\s*예문\s*해석\s*[:：]|\n\s*해석\s*[:：]|\n\s*💡|$))/i);
    const exampleKoMatch = text.match(/(?:^|\n)\s*(?:예문\s*해석|해석)\s*[:：]\s*(.+?)(?=(?:\n\s*💡|$))/i);
    const tipMatch = text.match(/(?:^|\n)\s*💡?\s*TOEIC TIP\s*[:：]\s*([\s\S]+)$/i);
    const posMatch = text.match(/(?:^|\n)\s*품사\s*[:：]\s*(.+?)(?=(?:\n|$))/i);

    return {
        meaningKo: normalizeInline(meaningMatch ? meaningMatch[1] : ''),
        exampleEn: normalizeInline(exampleMatch ? exampleMatch[1] : ''),
        exampleKo: normalizeInline(exampleKoMatch ? exampleKoMatch[1] : ''),
        tip: normalizeInline(tipMatch ? tipMatch[1] : ''),
        partOfSpeech: normalizeInline(posMatch ? posMatch[1] : ''),
        sourceText: text,
    };
}

function parseSentenceMean(raw) {
    const text = htmlToText(raw);
    const exampleMatch = text.match(/(?:^|\n)\s*예문\s*[:：]\s*(.+?)(?=(?:\n\s*해석\s*[:：]|\n\s*💡|$))/i);
    const exampleKoMatch = text.match(/(?:^|\n)\s*해석\s*[:：]\s*(.+?)(?=(?:\n\s*💡|$))/i);
    const tipMatch = text.match(/(?:^|\n)\s*💡?\s*TOEIC TIP\s*[:：]\s*([\s\S]+)$/i);
    return {
        exampleEn: normalizeInline(exampleMatch ? exampleMatch[1] : ''),
        exampleKo: normalizeInline(exampleKoMatch ? exampleKoMatch[1] : ''),
        tip: normalizeInline(tipMatch ? tipMatch[1] : ''),
        sourceText: text,
    };
}

function normalizeFrame(example, word) {
    let key = normalizeInline(example).toLowerCase();
    if (!key) return '';
    for (const candidate of wordCandidates(word)) {
        const safe = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        key = key.replace(new RegExp(`\\b${safe}\\b`, 'gi'), '[W]');
    }
    return key
        .replace(/"[^"]+"/g, '"X"')
        .replace(/\[[^\]]+\]/g, '[X]')
        .replace(/\b\d+\b/g, 'N')
        .replace(/\s+/g, ' ')
        .trim();
}

function riskScore(item, frameFreqMap) {
    const reasons = [];
    let score = 0;
    const exampleEn = normalizeInline(item.currentExampleEn);
    const exampleKo = normalizeInline(item.currentExampleKo);
    const tip = normalizeInline(item.currentTip);
    const meaning = normalizeInline(item.currentMeaningKo);

    if (!exampleEn) {
        score += 35;
        reasons.push('missing_example');
    }
    if (!exampleKo) {
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

    if (exampleEn) {
        const frame = normalizeFrame(exampleEn, item.word);
        const frequency = Number(frameFreqMap.get(frame) || 0);
        if (frequency >= 2) {
            score += Math.min(36, (frequency - 1) * 8);
            reasons.push(`repeated_frame_x${frequency}`);
        }
        if (!mentionsWord(exampleEn, item.word)) {
            score += 15;
            reasons.push('word_not_in_example');
        }
        if (/the manager asked the team to/i.test(exampleEn)) {
            score += 24;
            reasons.push('generic_template_manager');
        }
        if (/the expression\s+".+"\s+appears frequently in policy and contract documents/i.test(exampleEn)) {
            score += 24;
            reasons.push('generic_template_expression');
        }
        if (/must be reviewed by both parties before the contract is finalized/i.test(exampleEn)) {
            score += 22;
            reasons.push('generic_template_contract');
        }
        if (/\ba\s+[aeiou]/i.test(exampleEn)) {
            score += 12;
            reasons.push('grammar_article_mismatch');
        }
        if (exampleEn.length < 35) {
            score += 8;
            reasons.push('example_too_short');
        }
    }

    if (tip && !/(Part|파트|함정|콜로케이션|collocation|전치사|품사|수일치|빈출|자주)/i.test(tip)) {
        score += 10;
        reasons.push('tip_not_actionable');
    }

    if (!exampleKo || (exampleEn && exampleKo && !hasKorean(exampleKo))) {
        score += 8;
        reasons.push('translation_not_korean');
    }

    return {
        score,
        reasons: [...new Set(reasons)],
    };
}

async function fetchDeckNotes(ankiClient, deck) {
    const query = `deck:"${String(deck || '').replace(/"/g, '\\"')}"`;
    const noteIds = await ankiClient.invoke('findNotes', { query });
    const out = [];
    for (const batch of chunk(noteIds, 200)) {
        if (!batch.length) continue;
        const notes = await ankiClient.invoke('notesInfo', { notes: batch });
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
        const exampleField = normalizeInline(htmlToText(fields.Example_Sentence ? fields.Example_Sentence.value : ''));
        const parsed = parseSentenceMean(fields.Sentence_Mean ? fields.Sentence_Mean.value : '');
        const exampleEn = exampleField || parsed.exampleEn;
        if (!isWordLike(word)) return null;
        return {
            noteId: Number(note.noteId),
            deck,
            model,
            word,
            currentMeaningKo: meaning,
            currentExampleEn: exampleEn,
            currentExampleKo: parsed.exampleKo,
            currentTip: parsed.tip,
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

function summarizeSelection(row) {
    return {
        noteId: Number(row.noteId),
        deck: String(row.deck || ''),
        word: String(row.word || ''),
        riskScore: Number(row.riskScore || 0),
        riskReasons: Array.isArray(row.riskReasons) ? row.riskReasons : [],
    };
}

function buildMarkdownSummary(selected, args, quotas, nowIso) {
    const lines = [];
    lines.push(`# Anki 20-Card GPT Batch (${nowIso})`);
    lines.push('');
    lines.push(`- Count: ${selected.length}`);
    lines.push(`- Split: ${args.decks.map((deck, index) => `${deck}=${quotas[index] || 0}`).join(', ')}`);
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
    return lines.join('\n');
}

async function runExtractQualityBatch(argv, deps = {}) {
    const args = parseArgs(argv);
    const ankiClient = deps.anki || anki;
    const rootDir = resolveRootDir(deps.rootDir);
    const nowFn = createNowFn(deps.now);
    const now = nowFn();
    const nowIso = now.toISOString();
    const runId = deps.runId || createRunId();
    const quotas = splitQuota(args.count, args.split, args.decks.length);
    const jsonPath = path.join(rootDir, EXTRACT_JSON_REL);
    const mdPath = path.join(rootDir, EXTRACT_MD_REL);

    const deckCandidates = [];
    const allCandidates = [];

    for (let i = 0; i < args.decks.length; i += 1) {
        const deck = args.decks[i];
        const notes = await fetchDeckNotes(ankiClient, deck);
        const candidates = [];
        for (const note of notes) {
            const row = noteToCandidate(deck, note);
            if (row) candidates.push(row);
        }

        const frameFreqMap = new Map();
        for (const row of candidates) {
            const key = normalizeFrame(row.currentExampleEn, row.word);
            if (!key) continue;
            frameFreqMap.set(key, Number(frameFreqMap.get(key) || 0) + 1);
        }

        const scored = candidates
            .map((row) => {
                const risk = riskScore(row, frameFreqMap);
                return {
                    ...row,
                    riskScore: risk.score,
                    riskReasons: risk.reasons,
                    frameKey: normalizeFrame(row.currentExampleEn, row.word),
                    frameFrequency: Number(frameFreqMap.get(normalizeFrame(row.currentExampleEn, row.word)) || 0),
                };
            })
            .sort((left, right) => right.riskScore - left.riskScore || left.noteId - right.noteId);

        deckCandidates.push({
            deck,
            quota: Number(quotas[i] || 0),
            candidates: scored,
            scannedNotes: notes.length,
            eligibleWordCards: scored.length,
        });

        for (const row of scored) allCandidates.push(row);
    }

    const selected = [];
    const selectedIds = new Set();

    for (const row of deckCandidates) {
        for (const item of row.candidates) {
            if (selected.length >= args.count) break;
            if (selectedIds.has(item.noteId)) continue;
            if (selected.filter((value) => value.deck === row.deck).length >= row.quota) continue;
            selected.push(item);
            selectedIds.add(item.noteId);
        }
    }

    const leftovers = allCandidates
        .filter((row) => !selectedIds.has(row.noteId))
        .sort((left, right) => right.riskScore - left.riskScore || left.noteId - right.noteId);
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
        createdAt: nowIso,
        mode: 'audit',
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
    writeJsonAtomic(jsonPath, payload);
    writeFileAtomic(mdPath, `${buildMarkdownSummary(selected, args, quotas, nowIso)}\n`);

    const selectionFingerprint = sha256(JSON.stringify(gptInput));
    const deckStats = deckCandidates.map((row) => ({
        deck: row.deck,
        quota: row.quota,
        scannedNotes: row.scannedNotes,
        eligibleWordCards: row.eligibleWordCards,
    }));
    const auditEvent = {
        schema_version: '1.0',
        ts: nowIso,
        run_id: runId,
        stage: 'extract',
        mode: 'audit',
        ok: true,
        totals: {
            requested: args.count,
            selected: selected.length,
            decks: args.decks.length,
        },
        artifacts: {
            json_path: jsonPath,
            md_path: mdPath,
        },
        deck_stats: deckStats,
        selection_fingerprint: selectionFingerprint,
        sample: selected.slice(0, 5).map(summarizeSelection),
    };
    const auditLogPath = path.join(rootDir, AUDIT_LOG_REL);
    appendJsonl(auditLogPath, auditEvent);
    const latestSummaryPath = updateLatestSummary(rootDir, 'extract', {
        stage: 'extract',
        run_id: runId,
        ts: nowIso,
        mode: 'audit',
        ok: true,
        totals: auditEvent.totals,
        artifacts: auditEvent.artifacts,
        deck_stats: deckStats,
        selection_fingerprint: selectionFingerprint,
        sample: auditEvent.sample,
    });

    return {
        ok: true,
        stage: 'extract',
        mode: 'audit',
        mutatesAnki: false,
        writesReport: true,
        writesAudit: true,
        reportPaths: {
            jsonPath,
            mdPath,
        },
        auditLogPath,
        latestSummaryPath,
        selected: selected.length,
        split: quotas,
        deckStats,
        selectionFingerprint,
    };
}

async function main() {
    const result = await runExtractQualityBatch(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}

module.exports = {
    runExtractQualityBatch,
    parseArgs,
};
