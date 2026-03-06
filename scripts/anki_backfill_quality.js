#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const anki = require('./anki_connect');
const config = require('../data/config.json');
const {
    createWordQuality,
    evaluateQuality,
    normalizeWordToken,
    normalizeQualityPolicy,
    STYLE_VERSION,
} = require('./anki_word_quality');

const ROOT = path.join(__dirname, '..');
const AUDIT_LOG_REL = path.join('logs', 'anki_quality_pipeline.jsonl');
const LATEST_SUMMARY_REL = path.join('logs', 'anki_quality_pipeline_latest.json');
const TOEIC_CONTEXT_RE = /\b(company|employee|employees|manager|department|contract|policy|regulation|supplier|suppliers|client|customer|shipment|warehouse|invoice|budget|audit|sales|purchase|refund|training|schedule|meeting|report|service|agreement|renewal|support|technical|system|error|help desk|it|labor|union|overtime|applicant|startup|distributor|shipping|campaign|launch|technician|router|flight|flights|weather|benefit|benefits|retention|expense|expenses|travel|vendor|proposal|formatting|inquiry|billing|payment|reimbursement|delivery|logistics|inventory|program|mentoring|workshop|deadline|designers|server|network|job|posting|electronically)\b/i;
const TOEIC_TIP_DETAIL_RE = /(함정|콜로케이션|유사|혼동|vs|전치사|어순|수동태|빈출|자주)/i;

function parseArgs(argv) {
    const out = {
        deck: config.ankiPolicy?.toeicDeck || 'TOEIC_AI',
        apply: false,
        limit: 200,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const token = String(argv[i] || '');
        if (token === '--apply') out.apply = true;
        else if (token === '--dry-run') out.apply = false;
        else if (token === '--deck') out.deck = String(argv[i + 1] || out.deck), i += 1;
        else if (token === '--limit') out.limit = Math.max(1, Number(argv[i + 1] || out.limit)), i += 1;
    }
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

function normalizeSpace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
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
    return decodeHtmlEntities(String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim());
}

function normalizeTag(tag) {
    return String(tag || '').trim().toLowerCase();
}

function normalizeTags(tags) {
    return Array.isArray(tags)
        ? tags.map((tag) => normalizeTag(tag)).filter(Boolean)
        : [];
}

function getSchema(note) {
    const fields = Object.keys(note.fields || {});
    const hasRich = fields.includes('Question') && fields.includes('Answer');
    if (hasRich) return 'rich';
    const hasEngVoca = fields.includes('Clean_Word') && fields.includes('Example_Sentence') && fields.includes('Cleam_Word_Mean');
    if (hasEngVoca) return 'eng_voca';
    return 'unknown';
}

function extractWord(note, schema) {
    if (schema === 'rich') return normalizeSpace(htmlToText(note.fields?.Question?.value || ''));
    if (schema === 'eng_voca') return normalizeSpace(htmlToText(note.fields?.Clean_Word?.value || ''));
    return '';
}

function parseEngVocaTip(sentenceMean) {
    const raw = String(sentenceMean || '');
    const lines = raw.split('\n').map((value) => String(value || '').trim()).filter(Boolean);
    const tipLine = lines.find((line) => /TOEIC TIP/i.test(line));
    if (!tipLine) return '';
    return normalizeSpace(tipLine.replace(/^.*TOEIC TIP[:：]?\s*/i, ''));
}

function assessAnswer(answerHtml, tags = []) {
    const answer = String(answerHtml || '');
    const normalizedTags = normalizeTags(tags);
    const meaningMatch = answer.match(/뜻:\s*<b>([^<]+)<\/b>/i);
    const exampleMatch = answer.match(/예문:\s*<i>([^<]+)<\/i>/i);
    const exampleKoMatch = answer.match(/예문 해석:\s*([^<\n]+(?:<br>[^<\n]+)*)/i);
    const toeicTipMatch = answer.match(/TOEIC TIP:<\/b>\s*([^<\n]+(?:<br>[^<\n]+)*)/i);
    const hasMeaning = Boolean(meaningMatch && String(meaningMatch[1] || '').trim());
    const hasExampleEn = Boolean(exampleMatch && String(exampleMatch[1] || '').trim());
    const hasExampleKo = Boolean(exampleKoMatch && String(exampleKoMatch[1] || '').trim());
    const hasToeicTip = Boolean(toeicTipMatch && String(toeicTipMatch[1] || '').trim());
    const hasGenericTranslation = /해석:\s*[^<\n]+의 의미를 문맥에 맞게 사용하세요\./.test(answer);
    const hasStyleV2 = normalizedTags.includes(`style:${STYLE_VERSION}`.toLowerCase());
    const exampleEn = String(exampleMatch ? exampleMatch[1] : '').trim();
    const toeicTip = String(toeicTipMatch ? toeicTipMatch[1] : '').trim();
    const isToeicContext = hasExampleEn && TOEIC_CONTEXT_RE.test(exampleEn);
    const tipHasDetail = hasToeicTip && TOEIC_TIP_DETAIL_RE.test(toeicTip);
    const score = [hasMeaning, hasExampleEn, hasExampleKo, hasToeicTip].filter(Boolean).length / 4;
    const needsBackfill = score < 1 || hasGenericTranslation || !hasStyleV2 || !isToeicContext || !tipHasDetail;
    return {
        score,
        hasMeaning,
        hasExampleEn,
        hasExampleKo,
        hasToeicTip,
        isToeicContext,
        tipHasDetail,
        hasGenericTranslation,
        needsBackfill,
        parsed: {
            meaningKo: String(meaningMatch ? meaningMatch[1] : '').trim(),
            exampleEn,
            exampleKo: String(exampleKoMatch ? exampleKoMatch[1] : '').trim(),
            toeicTip,
        },
    };
}

function assessEngVocaNote(note, tags = []) {
    const normalizedTags = normalizeTags(tags);
    const meaningKo = normalizeSpace(htmlToText(note.fields?.Cleam_Word_Mean?.value || ''));
    const exampleEn = normalizeSpace(htmlToText(note.fields?.Example_Sentence?.value || ''));
    const sentenceMeanRaw = htmlToText(String(note.fields?.Sentence_Mean?.value || ''));
    const sentenceMean = normalizeSpace(sentenceMeanRaw);
    const toeicTip = parseEngVocaTip(sentenceMeanRaw);
    const hasMeaning = Boolean(meaningKo);
    const hasExampleEn = Boolean(exampleEn);
    const hasExampleKo = Boolean(sentenceMean);
    const hasToeicTip = Boolean(toeicTip);
    const hasStyleV2 = normalizedTags.includes(`style:${STYLE_VERSION}`.toLowerCase());
    const isToeicContext = hasExampleEn && TOEIC_CONTEXT_RE.test(exampleEn);
    const tipHasDetail = hasToeicTip && TOEIC_TIP_DETAIL_RE.test(toeicTip);
    const genericPhraseExample = /^the\s+.+\s+must be reviewed by both parties before the contract is finalized\.?$/i.test(exampleEn);
    const score = [hasMeaning, hasExampleEn, hasExampleKo, hasToeicTip].filter(Boolean).length / 4;
    const needsBackfill = score < 1 || !hasStyleV2 || !isToeicContext || !tipHasDetail || genericPhraseExample;
    return {
        score,
        hasMeaning,
        hasExampleEn,
        hasExampleKo,
        hasToeicTip,
        isToeicContext,
        tipHasDetail,
        hasGenericTranslation: false,
        genericPhraseExample,
        needsBackfill,
        parsed: {
            meaningKo,
            exampleEn,
            exampleKo: sentenceMean,
            toeicTip,
        },
    };
}

function buildToeicAnswer({ meaningKo, exampleEn, exampleKo, toeicTip, partOfSpeech }) {
    const pos = partOfSpeech ? `품사: ${partOfSpeech}<br>` : '';
    return [
        `뜻: <b>${meaningKo}</b>`,
        '<hr>',
        `${pos}예문: <i>${exampleEn}</i>`,
        `예문 해석: ${exampleKo}`,
        '<hr>',
        `💡 <b>TOEIC TIP:</b> ${toeicTip}`,
    ].join('<br>');
}

function buildEngVocaFields(quality) {
    return {
        Example_Sentence: String(quality.exampleEn || '').trim(),
        Cleam_Word_Mean: String(quality.meaningKo || '').trim(),
        Sentence_Mean: `${String(quality.exampleKo || '').trim()}\n💡 TOEIC TIP: ${String(quality.toeicTip || '').trim()}`.trim(),
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

function hasManagedBackfillTag(tags) {
    return normalizeTags(tags).includes('backfilled');
}

function summarizeAssessment(assessment) {
    return {
        needsBackfill: Boolean(assessment && assessment.needsBackfill),
        hasMeaning: Boolean(assessment && assessment.hasMeaning),
        hasExampleEn: Boolean(assessment && assessment.hasExampleEn),
        hasExampleKo: Boolean(assessment && assessment.hasExampleKo),
        hasToeicTip: Boolean(assessment && assessment.hasToeicTip),
        isToeicContext: Boolean(assessment && assessment.isToeicContext),
        tipHasDetail: Boolean(assessment && assessment.tipHasDetail),
    };
}

function pushSample(target, row, limit = 15) {
    if (target.length >= limit) return;
    target.push(row);
}

async function runBackfillQuality(argv, deps = {}) {
    const args = parseArgs(argv);
    const rootDir = resolveRootDir(deps.rootDir);
    const nowFn = createNowFn(deps.now);
    const nowIso = nowFn().toISOString();
    const runId = deps.runId || createRunId();
    const ankiClient = deps.anki || anki;
    const qualityFn = deps.createWordQuality || createWordQuality;
    const evaluateFn = deps.evaluateQuality || evaluateQuality;
    const styleVersion = deps.styleVersion || STYLE_VERSION;
    const qualityPolicy = deps.qualityPolicy || normalizeQualityPolicy(config.ankiQualityPolicy || {});
    const query = `deck:"${String(args.deck).replace(/"/g, '\\"')}"`;
    const noteIds = await ankiClient.invoke('findNotes', { query });
    const targetIds = noteIds.slice(0, args.limit);
    const notesInfo = targetIds.length > 0 ? await ankiClient.invoke('notesInfo', { notes: targetIds }) : [];

    const totals = {
        scanned: notesInfo.length,
        candidates: 0,
        ready: 0,
        skipped_unchanged: 0,
        quality_blocked: 0,
        applied: 0,
        failed: 0,
    };
    const sample = [];
    const operations = [];

    for (const note of notesInfo) {
        const schema = getSchema(note);
        const question = extractWord(note, schema);
        if (!question) continue;
        const assessment = schema === 'rich'
            ? assessAnswer(String(note.fields?.Answer?.value || '').trim(), note.tags || [])
            : schema === 'eng_voca'
                ? assessEngVocaNote(note, note.tags || [])
                : null;
        if (!assessment) continue;
        const managed = hasManagedBackfillTag(note.tags || []);
        if (!assessment.needsBackfill && !managed) continue;

        totals.candidates += 1;

        try {
            const quality = await qualityFn(question, '', { policy: qualityPolicy });
            const qualityEval = evaluateFn({
                partOfSpeech: quality.partOfSpeech,
                meaningKo: quality.meaningKo,
                exampleEn: quality.exampleEn,
                exampleKo: quality.exampleKo,
                toeicTip: quality.toeicTip,
                lemma: quality.lemma || normalizeWordToken(question),
            }, qualityPolicy.qualityThreshold, question);

            if (quality.degraded || !qualityEval.ok) {
                totals.quality_blocked += 1;
                pushSample(sample, {
                    noteId: Number(note.noteId),
                    word: question,
                    schema,
                    status: 'quality_blocked',
                    assessment: summarizeAssessment(assessment),
                    reason: quality.degraded
                        ? 'quality_degraded'
                        : `quality_not_enough:${qualityEval.warnings.slice(0, 3).join(',')}`,
                });
                continue;
            }

            const desiredFields = schema === 'eng_voca'
                ? buildEngVocaFields(quality)
                : { Answer: buildToeicAnswer(quality) };
            const desiredTags = [`style:${styleVersion}`, 'backfilled'];
            const fieldDiffKeys = diffFieldKeys(note, desiredFields);
            const missingTags = diffTags(note.tags || [], desiredTags);
            const status = fieldDiffKeys.length || missingTags.length ? 'ready' : 'skipped_unchanged';

            if (status === 'ready') totals.ready += 1;
            else totals.skipped_unchanged += 1;

            operations.push({
                noteId: Number(note.noteId),
                question,
                schema,
                desiredFields,
                fieldDiffKeys,
                missingTags,
                status,
            });
            pushSample(sample, {
                noteId: Number(note.noteId),
                word: question,
                schema,
                status,
                assessment: summarizeAssessment(assessment),
                fieldDiffKeys,
                missingTags,
            });
        } catch (error) {
            totals.failed += 1;
            pushSample(sample, {
                noteId: Number(note.noteId),
                word: question,
                schema,
                status: 'failed',
                assessment: summarizeAssessment(assessment),
                reason: String(error.message || error),
            });
        }
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
                            id: op.noteId,
                            fields,
                        },
                    });
                }
                if (op.missingTags.length) {
                    await ankiClient.invoke('addTags', {
                        notes: [op.noteId],
                        tags: op.missingTags.join(' '),
                    });
                }
                totals.applied += 1;
                op.status = 'applied';
            } catch (error) {
                totals.failed += 1;
                op.status = 'failed';
                op.reason = String(error.message || error);
                pushSample(sample, {
                    noteId: op.noteId,
                    word: op.question,
                    schema: op.schema,
                    status: 'failed',
                    reason: op.reason,
                });
            }
        }

        if (totals.applied > 0) {
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
        stage: 'backfill',
        mode: args.apply ? 'apply' : 'dry-run',
        ok: totals.failed === 0,
        totals,
        artifacts: {
            deck: args.deck,
            limit: args.limit,
        },
        sample,
    };
    const auditLogPath = path.join(rootDir, AUDIT_LOG_REL);
    appendJsonl(auditLogPath, auditEvent);
    const latestSummaryPath = updateLatestSummary(rootDir, 'backfill', {
        stage: 'backfill',
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
        stage: 'backfill',
        mode: args.apply ? 'apply' : 'dry-run',
        deck: args.deck,
        totals,
        auditLogPath,
        latestSummaryPath,
    };
}

async function main() {
    const result = await runBackfillQuality(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}

module.exports = {
    runBackfillQuality,
    parseArgs,
};
