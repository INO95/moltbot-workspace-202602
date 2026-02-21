const anki = require('./anki_connect');
const config = require('../data/config.json');
const {
    createWordQuality,
    evaluateQuality,
    normalizeWordToken,
    normalizeQualityPolicy,
    STYLE_VERSION,
} = require('./anki_word_quality');

const TOEIC_CONTEXT_RE = /\b(company|employee|employees|manager|department|contract|policy|regulation|supplier|suppliers|client|customer|shipment|warehouse|invoice|budget|audit|sales|purchase|refund|training|schedule|meeting|report|service|agreement|renewal|support|technical|system|error|help desk|it|labor|union|overtime|applicant|startup|distributor|shipping|campaign|launch|technician|router|flight|flights|weather|benefit|benefits|retention|expense|expenses|travel|vendor|proposal|formatting|inquiry|billing|payment|reimbursement|delivery|logistics|inventory|program|mentoring|workshop|deadline|designers|server|network|job|posting|electronically)\b/i;
const TOEIC_TIP_DETAIL_RE = /(함정|콜로케이션|유사|혼동|vs|전치사|어순|수동태|빈출|자주)/i;

function parseArgs(argv) {
    const out = {
        deck: config.ankiPolicy?.toeicDeck || 'TOEIC_AI',
        apply: false,
        limit: 200,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = String(argv[i] || '');
        if (a === '--apply') out.apply = true;
        else if (a === '--dry-run') out.apply = false;
        else if (a === '--deck') out.deck = String(argv[i + 1] || out.deck), i += 1;
        else if (a === '--limit') out.limit = Math.max(1, Number(argv[i + 1] || out.limit)), i += 1;
    }
    return out;
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
    const lines = raw.split('\n').map((v) => String(v || '').trim()).filter(Boolean);
    const tipLine = lines.find((line) => /TOEIC TIP/i.test(line));
    if (!tipLine) return '';
    return normalizeSpace(tipLine.replace(/^.*TOEIC TIP[:：]?\s*/i, ''));
}

function assessAnswer(answerHtml, tags = []) {
    const answer = String(answerHtml || '');
    const normalizedTags = Array.isArray(tags) ? tags.map((v) => String(v || '').trim().toLowerCase()) : [];
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
    const normalizedTags = Array.isArray(tags) ? tags.map((v) => String(v || '').trim().toLowerCase()) : [];
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const qualityPolicy = normalizeQualityPolicy(config.ankiQualityPolicy || {});
    const query = `deck:"${String(args.deck).replace(/"/g, '\\"')}"`;
    const noteIds = await anki.invoke('findNotes', { query });
    const targetIds = noteIds.slice(0, args.limit);
    const notesInfo = targetIds.length > 0 ? await anki.invoke('notesInfo', { notes: targetIds }) : [];
    const candidates = [];

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
        if (!assessment.needsBackfill) continue;
        candidates.push({
            noteId: Number(note.noteId),
            question,
            schema,
            assessment,
        });
    }

    const output = {
        ok: true,
        mode: args.apply ? 'apply' : 'dry-run',
        deck: args.deck,
        scanned: notesInfo.length,
        candidates: candidates.length,
        updated: 0,
        failed: 0,
        failures: [],
        sample: candidates.slice(0, 15),
    };

    if (!args.apply || candidates.length === 0) {
        console.log(JSON.stringify(output, null, 2));
        return;
    }

    for (const row of candidates) {
        try {
            const quality = await createWordQuality(row.question, '', { policy: qualityPolicy });
            const qualityEval = evaluateQuality({
                partOfSpeech: quality.partOfSpeech,
                meaningKo: quality.meaningKo,
                exampleEn: quality.exampleEn,
                exampleKo: quality.exampleKo,
                toeicTip: quality.toeicTip,
                lemma: quality.lemma || normalizeWordToken(row.question),
            }, qualityPolicy.qualityThreshold, row.question);
            if (quality.degraded || !qualityEval.ok) {
                output.failed += 1;
                output.failures.push({
                    noteId: row.noteId,
                    word: row.question,
                    reason: quality.degraded ? 'quality_degraded' : `quality_not_enough:${qualityEval.warnings.slice(0, 3).join(',')}`,
                });
                continue;
            }
            const answer = buildToeicAnswer(quality);
            const fields = row.schema === 'eng_voca'
                ? buildEngVocaFields(quality)
                : { Answer: answer };
            await anki.invoke('updateNoteFields', {
                note: {
                    id: row.noteId,
                    fields,
                },
            });
            await anki.invoke('addTags', {
                notes: [row.noteId],
                tags: `style:${STYLE_VERSION} backfilled`,
            });
            output.updated += 1;
        } catch (error) {
            output.failed += 1;
            output.failures.push({
                noteId: row.noteId,
                word: row.question,
                reason: String(error.message || error),
            });
        }
    }

    try {
        await anki.syncWithDelay();
    } catch (error) {
        output.syncWarning = String(error.message || error);
    }
    console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}
