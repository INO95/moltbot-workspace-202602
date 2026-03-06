const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runExtractQualityBatch } = require('./anki_extract_quality_batch');
const { runApplyGptBatch } = require('./anki_apply_gpt_batch');
const { runBackfillQuality } = require('./anki_backfill_quality');
const { STYLE_VERSION } = require('./anki_word_quality');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeTempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'anki-quality-pipeline-'));
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

function deckQueryName(query) {
    const match = String(query || '').match(/deck:"([^"]+)"/);
    return match ? match[1] : '';
}

function noteHasDeck(note, deckName, cardsById) {
    if (!deckName) return false;
    return (Array.isArray(note.cards) ? note.cards : [])
        .some((cardId) => {
            const row = cardsById.get(Number(cardId));
            return row && String(row.deckName || '') === deckName;
        });
}

function makeMockAnki({ notes, cards }) {
    const state = {
        notes: new Map(notes.map((note) => [Number(note.noteId), clone(note)])),
        cards: new Map(cards.map((card) => [Number(card.cardId), clone(card)])),
        calls: {
            findNotes: [],
            notesInfo: [],
            cardsInfo: [],
            updateNoteFields: [],
            addTags: [],
            sync: 0,
        },
    };

    return {
        state,
        async invoke(action, payload = {}) {
            if (action === 'findNotes') {
                state.calls.findNotes.push(clone(payload));
                const deckName = deckQueryName(payload.query);
                return [...state.notes.values()]
                    .filter((note) => noteHasDeck(note, deckName, state.cards))
                    .map((note) => Number(note.noteId));
            }
            if (action === 'notesInfo') {
                state.calls.notesInfo.push(clone(payload));
                return (Array.isArray(payload.notes) ? payload.notes : [])
                    .map((noteId) => state.notes.get(Number(noteId)))
                    .filter(Boolean)
                    .map((note) => clone(note));
            }
            if (action === 'cardsInfo') {
                state.calls.cardsInfo.push(clone(payload));
                return (Array.isArray(payload.cards) ? payload.cards : [])
                    .map((cardId) => state.cards.get(Number(cardId)))
                    .filter(Boolean)
                    .map((card) => clone(card));
            }
            if (action === 'updateNoteFields') {
                state.calls.updateNoteFields.push(clone(payload));
                const noteId = Number(payload.note && payload.note.id);
                const note = state.notes.get(noteId);
                if (!note) throw new Error(`note_not_found:${noteId}`);
                const updates = payload.note && payload.note.fields ? payload.note.fields : {};
                for (const [key, value] of Object.entries(updates)) {
                    note.fields[key] = { value: String(value || '') };
                }
                return { ok: true };
            }
            if (action === 'addTags') {
                state.calls.addTags.push(clone(payload));
                const noteIds = Array.isArray(payload.notes) ? payload.notes : [];
                const tags = String(payload.tags || '').split(/\s+/).filter(Boolean);
                for (const noteIdRaw of noteIds) {
                    const note = state.notes.get(Number(noteIdRaw));
                    if (!note) continue;
                    const current = new Set(Array.isArray(note.tags) ? note.tags : []);
                    for (const tag of tags) current.add(tag);
                    note.tags = [...current];
                }
                return { ok: true };
            }
            throw new Error(`unsupported_action:${action}`);
        },
        async syncWithDelay() {
            state.calls.sync += 1;
            return { ok: true };
        },
    };
}

function makeRichNote(noteId, cardId, deckName, word, answer, tags = []) {
    return {
        noteId,
        modelName: 'Basic',
        cards: [cardId],
        tags,
        fields: {
            Question: { value: word },
            Answer: { value: answer },
        },
    };
}

function makeEngVocaNote(noteId, cardId, deckName, word, meaningKo, exampleEn, sentenceMean, tags = []) {
    return {
        noteId,
        modelName: 'Eng_Voca',
        cards: [cardId],
        tags,
        fields: {
            Clean_Word: { value: word },
            Cleam_Word_Mean: { value: meaningKo },
            Example_Sentence: { value: exampleEn },
            Sentence_Mean: { value: sentenceMean },
        },
    };
}

function makeCard(cardId, deckName) {
    return {
        cardId,
        deckName,
    };
}

function buildSentenceMean(exampleEn, exampleKo, toeicTip) {
    return [
        `예문: ${exampleEn}`,
        '',
        `해석: ${exampleKo}`,
        '',
        '💡 TOEIC TIP:',
        toeicTip,
    ].join('<br>');
}

async function testExtractWritesStableLatestAndAuditLog() {
    const rootDir = makeTempRoot();
    const notes = [
        makeRichNote(
            1,
            101,
            'TOEIC_AI',
            'timely',
            '뜻: <b>시기적절한</b><br><hr><br>예문: <i></i><br>예문 해석: <br><hr><br>💡 <b>TOEIC TIP:</b> '
        ),
        makeEngVocaNote(
            2,
            102,
            '단어::영단어::2603TOEIC',
            'shipment',
            '배송',
            'The shipment arrived.',
            '예문: The shipment arrived.<br>해석: 배송이 도착했다.',
            []
        ),
    ];
    const cards = [
        makeCard(101, 'TOEIC_AI'),
        makeCard(102, '단어::영단어::2603TOEIC'),
    ];
    const mockAnki = makeMockAnki({ notes, cards });

    const first = await runExtractQualityBatch([
        '--count', '2',
        '--decks', 'TOEIC_AI,단어::영단어::2603TOEIC',
        '--split', '1,1',
    ], {
        rootDir,
        anki: mockAnki,
        now: () => new Date('2026-03-07T00:00:00.000Z'),
        runId: 'extract-1',
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(path.basename(first.reportPaths.jsonPath), 'anki_20_words_for_gpt_latest.json');
    assert.strictEqual(path.basename(first.reportPaths.mdPath), 'anki_20_words_for_gpt_latest.md');

    const payload = readJson(first.reportPaths.jsonPath);
    assert.strictEqual(payload.mode, 'audit');
    assert.strictEqual(payload.count, 2);

    const second = await runExtractQualityBatch([
        '--count', '2',
        '--decks', 'TOEIC_AI,단어::영단어::2603TOEIC',
        '--split', '1,1',
    ], {
        rootDir,
        anki: mockAnki,
        now: () => new Date('2026-03-07T00:10:00.000Z'),
        runId: 'extract-2',
    });

    const reportFiles = fs.readdirSync(path.join(rootDir, 'reports')).sort();
    assert.deepStrictEqual(reportFiles, ['anki_20_words_for_gpt_latest.json', 'anki_20_words_for_gpt_latest.md']);

    const auditRows = readJsonl(path.join(rootDir, 'logs', 'anki_quality_pipeline.jsonl'));
    assert.strictEqual(auditRows.length, 2);
    assert.strictEqual(auditRows[0].stage, 'extract');
    assert.strictEqual(auditRows[1].stage, 'extract');

    const latest = readJson(path.join(rootDir, 'logs', 'anki_quality_pipeline_latest.json'));
    assert.strictEqual(latest.stages.extract.run_id, 'extract-2');
    assert.strictEqual(latest.stages.extract.selection_fingerprint, second.selectionFingerprint);
}

async function testApplyDryRunClassifiesWithoutMutation() {
    const rootDir = makeTempRoot();
    const inputPath = path.join(rootDir, 'input.json');
    const sourcePath = path.join(rootDir, 'reports', 'anki_20_words_for_gpt_latest.json');

    const timelyExample = 'The timely update reduced billing errors before the audit.';
    const timelyExampleKo = '시기적절한 업데이트는 감사 전에 청구 오류를 줄였다.';
    const timelyTip = 'TOEIC Part 7에서 일정과 감사 문맥의 형용사 함정을 확인하세요.';
    const shipmentExample = 'The shipment arrived before noon.';
    const shipmentExampleKo = '배송은 정오 전에 도착했다.';
    const shipmentTip = 'TOEIC Part 1에서 배송 일정과 상태 표현이 자주 나온다.';

    writeJson(inputPath, [
        { noteId: 101, exampleEn: timelyExample, exampleKo: timelyExampleKo, toeicTip: timelyTip },
        { noteId: 102, exampleEn: 'The audit started early.', exampleKo: '감사는 일찍 시작됐다.', toeicTip: '' },
        { noteId: 103, exampleEn: shipmentExample, exampleKo: shipmentExampleKo, toeicTip: shipmentTip },
    ]);
    writeJson(sourcePath, {
        gptInput: [
            { noteId: 101, deck: 'TOEIC_AI', word: 'timely', currentMeaningKo: '시기적절한' },
            { noteId: 102, deck: 'TOEIC_AI', word: 'audit', currentMeaningKo: '감사' },
            { noteId: 103, deck: '단어::영단어::Eng_Voca', word: 'shipment', currentMeaningKo: '배송' },
        ],
    });

    const notes = [
        makeRichNote(
            101,
            201,
            'TOEIC_AI',
            'timely',
            '뜻: <b>시기적절한</b><br>예문: <i>Old example.</i><br>예문 해석: 오래된 예문<br>💡 <b>TOEIC TIP:</b> Old tip'
        ),
        makeRichNote(
            102,
            202,
            'TOEIC_AI',
            'audit',
            '뜻: <b>감사</b><br>예문: <i>Old audit example.</i><br>예문 해석: 오래된 감사 예문<br>💡 <b>TOEIC TIP:</b> Old tip'
        ),
        makeEngVocaNote(
            103,
            203,
            '단어::영단어::Eng_Voca',
            'shipment',
            '배송',
            shipmentExample,
            buildSentenceMean(shipmentExample, shipmentExampleKo, shipmentTip),
            ['quality:gpt52']
        ),
    ];
    const cards = [
        makeCard(201, 'TOEIC_AI'),
        makeCard(202, 'TOEIC_AI'),
        makeCard(203, '단어::영단어::Eng_Voca'),
    ];
    const mockAnki = makeMockAnki({ notes, cards });

    const result = await runApplyGptBatch(['--input', 'input.json', '--dry-run'], {
        rootDir,
        anki: mockAnki,
        now: () => new Date('2026-03-07T01:00:00.000Z'),
        runId: 'apply-dry-1',
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.totals, {
        received: 3,
        invalid: 1,
        ready: 1,
        skipped_unchanged: 1,
        applied: 0,
        failed: 0,
    });
    assert.strictEqual(mockAnki.state.calls.updateNoteFields.length, 0);
    assert.strictEqual(mockAnki.state.calls.addTags.length, 0);
    assert.strictEqual(mockAnki.state.calls.sync, 0);

    const latest = readJson(path.join(rootDir, 'logs', 'anki_quality_pipeline_latest.json'));
    assert.strictEqual(latest.stages.apply_gpt.run_id, 'apply-dry-1');
    assert.strictEqual(latest.stages.apply_gpt.totals.ready, 1);
    assert.strictEqual(latest.stages.apply_gpt.totals.skipped_unchanged, 1);
}

async function testApplyIsIdempotentAcrossReruns() {
    const rootDir = makeTempRoot();
    const inputPath = path.join(rootDir, 'input.json');
    const sourcePath = path.join(rootDir, 'reports', 'anki_20_words_for_gpt_latest.json');

    const exampleEn = 'The timely reminder prevented a billing dispute with the client.';
    const exampleKo = '시기적절한 알림은 고객과의 청구 분쟁을 막았다.';
    const toeicTip = 'TOEIC Part 7에서 청구 일정과 형용사 함정을 함께 확인하세요.';

    writeJson(inputPath, [
        { noteId: 301, exampleEn, exampleKo, toeicTip },
    ]);
    writeJson(sourcePath, {
        gptInput: [
            { noteId: 301, deck: 'TOEIC_AI', word: 'timely', currentMeaningKo: '시기적절한' },
        ],
    });

    const notes = [
        makeRichNote(
            301,
            401,
            'TOEIC_AI',
            'timely',
            '뜻: <b>시기적절한</b><br>예문: <i>Old example.</i><br>예문 해석: 오래된 예문<br>💡 <b>TOEIC TIP:</b> Old tip'
        ),
    ];
    const cards = [makeCard(401, 'TOEIC_AI')];
    const mockAnki = makeMockAnki({ notes, cards });

    const first = await runApplyGptBatch(['--input', 'input.json', '--apply'], {
        rootDir,
        anki: mockAnki,
        now: () => new Date('2026-03-07T02:00:00.000Z'),
        runId: 'apply-1',
    });
    assert.strictEqual(first.sourcePath, sourcePath);
    assert.strictEqual(first.totals.ready, 1);
    assert.strictEqual(first.totals.applied, 1);
    assert.strictEqual(mockAnki.state.calls.updateNoteFields.length, 1);
    assert.strictEqual(mockAnki.state.calls.addTags.length, 1);
    assert.strictEqual(mockAnki.state.calls.sync, 1);

    const second = await runApplyGptBatch(['--input', 'input.json', '--apply'], {
        rootDir,
        anki: mockAnki,
        now: () => new Date('2026-03-07T02:10:00.000Z'),
        runId: 'apply-2',
    });
    assert.deepStrictEqual(second.totals, {
        received: 1,
        invalid: 0,
        ready: 0,
        skipped_unchanged: 1,
        applied: 0,
        failed: 0,
    });
    assert.strictEqual(mockAnki.state.calls.updateNoteFields.length, 1);
    assert.strictEqual(mockAnki.state.calls.addTags.length, 1);
    assert.strictEqual(mockAnki.state.calls.sync, 1);
}

async function testBackfillDryRunApplyAndIdempotentRerun() {
    const rootDir = makeTempRoot();
    const notes = [
        makeRichNote(
            501,
            601,
            'TOEIC_AI',
            'timely',
            '뜻: <b>시기적절한</b><br><hr><br>예문: <i></i><br>예문 해석: <br><hr><br>💡 <b>TOEIC TIP:</b> '
        ),
        makeRichNote(
            502,
            602,
            'TOEIC_AI',
            'scheme',
            '뜻: <b>계획</b><br><hr><br>예문: <i></i><br>예문 해석: <br><hr><br>💡 <b>TOEIC TIP:</b> '
        ),
    ];
    const cards = [
        makeCard(601, 'TOEIC_AI'),
        makeCard(602, 'TOEIC_AI'),
    ];
    const mockAnki = makeMockAnki({ notes, cards });

    const qualityFn = async (word) => {
        if (word === 'scheme') {
            return {
                partOfSpeech: 'noun',
                meaningKo: '계획',
                exampleEn: '',
                exampleKo: '',
                toeicTip: '',
                lemma: 'scheme',
                degraded: true,
            };
        }
        return {
            partOfSpeech: 'adjective',
            meaningKo: '시기적절한',
            exampleEn: 'The timely reminder prevented a billing dispute with the client.',
            exampleKo: '시기적절한 알림은 고객과의 청구 분쟁을 막았다.',
            toeicTip: 'TOEIC Part 7에서 청구 일정과 형용사 함정을 확인하세요.',
            lemma: 'timely',
            degraded: false,
        };
    };
    const evaluateFn = (quality) => ({
        ok: Boolean(quality && quality.exampleEn && quality.exampleKo && quality.toeicTip),
        warnings: quality && quality.exampleEn ? [] : ['missing_example'],
    });

    const dryRun = await runBackfillQuality(['--dry-run', '--deck', 'TOEIC_AI', '--limit', '10'], {
        rootDir,
        anki: mockAnki,
        now: () => new Date('2026-03-07T03:00:00.000Z'),
        runId: 'backfill-dry-1',
        createWordQuality: qualityFn,
        evaluateQuality: evaluateFn,
        qualityPolicy: { qualityThreshold: 0.82 },
    });
    assert.deepStrictEqual(dryRun.totals, {
        scanned: 2,
        candidates: 2,
        ready: 1,
        skipped_unchanged: 0,
        quality_blocked: 1,
        applied: 0,
        failed: 0,
    });
    assert.strictEqual(mockAnki.state.calls.updateNoteFields.length, 0);
    assert.strictEqual(mockAnki.state.calls.addTags.length, 0);
    assert.strictEqual(mockAnki.state.calls.sync, 0);

    const applyRun = await runBackfillQuality(['--apply', '--deck', 'TOEIC_AI', '--limit', '10'], {
        rootDir,
        anki: mockAnki,
        now: () => new Date('2026-03-07T03:10:00.000Z'),
        runId: 'backfill-apply-1',
        createWordQuality: qualityFn,
        evaluateQuality: evaluateFn,
        qualityPolicy: { qualityThreshold: 0.82 },
    });
    assert.strictEqual(applyRun.totals.ready, 1);
    assert.strictEqual(applyRun.totals.applied, 1);
    assert.strictEqual(applyRun.totals.quality_blocked, 1);
    assert.strictEqual(mockAnki.state.calls.updateNoteFields.length, 1);
    assert.strictEqual(mockAnki.state.calls.addTags.length, 1);
    assert.strictEqual(mockAnki.state.calls.sync, 1);

    const rerun = await runBackfillQuality(['--apply', '--deck', 'TOEIC_AI', '--limit', '10'], {
        rootDir,
        anki: mockAnki,
        now: () => new Date('2026-03-07T03:20:00.000Z'),
        runId: 'backfill-apply-2',
        createWordQuality: qualityFn,
        evaluateQuality: evaluateFn,
        qualityPolicy: { qualityThreshold: 0.82 },
    });
    assert.deepStrictEqual(rerun.totals, {
        scanned: 2,
        candidates: 2,
        ready: 0,
        skipped_unchanged: 1,
        quality_blocked: 1,
        applied: 0,
        failed: 0,
    });
    assert.strictEqual(mockAnki.state.calls.updateNoteFields.length, 1);
    assert.strictEqual(mockAnki.state.calls.addTags.length, 1);
    assert.strictEqual(mockAnki.state.calls.sync, 1);

    const updatedNote = mockAnki.state.notes.get(501);
    assert.ok(Array.isArray(updatedNote.tags) && updatedNote.tags.includes(`style:${STYLE_VERSION}`));
    assert.ok(updatedNote.tags.includes('backfilled'));

    const latest = readJson(path.join(rootDir, 'logs', 'anki_quality_pipeline_latest.json'));
    assert.strictEqual(latest.stages.backfill.run_id, 'backfill-apply-2');
    assert.strictEqual(latest.stages.backfill.totals.skipped_unchanged, 1);
}

async function run() {
    await testExtractWritesStableLatestAndAuditLog();
    await testApplyDryRunClassifiesWithoutMutation();
    await testApplyIsIdempotentAcrossReruns();
    await testBackfillDryRunApplyAndIdempotentRerun();
    console.log('test_anki_quality_pipeline: ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
