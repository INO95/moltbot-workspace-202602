const assert = require('assert');
const { processWordTokens, QUALITY_STYLE_VERSION } = require('./bridge');

function makeQuality(word, overrides = {}) {
    return {
        lemma: String(word || '').toLowerCase(),
        partOfSpeech: 'verb',
        meaningKo: '의미',
        exampleEn: `The team used ${word} in the report.`,
        exampleKo: `팀은 보고서에서 ${word}를 사용했습니다.`,
        toeicTip: 'Part 5에서 품사/문법 함정으로 자주 출제됩니다.',
        confidence: 0.9,
        sourceMode: 'local',
        warnings: [],
        degraded: false,
        styleVersion: QUALITY_STYLE_VERSION,
        ...overrides,
    };
}

async function testSlashAndBatchParsing() {
    const fronts = [];
    const out = await processWordTokens('comply with / adhere to, timely', 'TOEIC_AI', ['moltbot'], {
        qualityFn: async (word) => makeQuality(word),
        addCardFn: async (_deck, front, _back, _tags, _opts) => {
            fronts.push(front);
            return { noteId: fronts.length, duplicate: false, updated: false, action: 'add' };
        },
        syncFn: async () => null,
        qualityPolicy: { enableHybridFallback: false, qualityThreshold: 0.8 },
    });
    assert.strictEqual(out.saved, 3);
    assert.strictEqual(out.failed, 0);
    assert.deepStrictEqual(fronts, ['comply with', 'adhere to', 'timely']);
    assert.strictEqual(out.quality.styleVersion, QUALITY_STYLE_VERSION);
    assert.strictEqual(out.quality.sourceMode, 'local');
}

async function testLowQualityRejection() {
    const out = await processWordTokens('timely', 'TOEIC_AI', ['moltbot'], {
        qualityFn: async () => makeQuality('timely', {
            exampleKo: '',
            warnings: ['missing_example_ko'],
            confidence: 0.2,
            degraded: true,
            hardFail: true,
        }),
        addCardFn: async () => {
            throw new Error('add should not be called');
        },
        syncFn: async () => null,
        qualityPolicy: { enableHybridFallback: false, qualityThreshold: 0.8 },
    });
    assert.strictEqual(out.saved, 0);
    assert.strictEqual(out.failed, 1);
    assert.strictEqual(out.failedQualityCount, 1);
    assert.ok(out.failedTokens[0].includes('low_quality'));
}

async function testSyncWarningSeparated() {
    const out = await processWordTokens('ledger', 'TOEIC_AI', ['moltbot'], {
        qualityFn: async (word) => makeQuality(word),
        addCardFn: async () => ({ noteId: 100, duplicate: false, updated: false, action: 'add' }),
        syncFn: async () => {
            throw new Error('sync unreachable');
        },
        qualityPolicy: { enableHybridFallback: false, qualityThreshold: 0.8 },
    });
    assert.strictEqual(out.saved, 1);
    assert.strictEqual(out.failed, 0);
    assert.strictEqual(out.success, true);
    assert.ok(String(out.syncWarning || '').includes('sync_failed'));
    assert.ok(out.telegramReply.includes('동기화 경고'));
}

async function testDuplicateMetaPropagation() {
    const out = await processWordTokens('timely', 'TOEIC_AI', ['moltbot'], {
        qualityFn: async (word) => makeQuality(word, { sourceMode: 'hybrid' }),
        addCardFn: async () => ({ noteId: 200, duplicate: true, updated: false, action: 'skip' }),
        syncFn: async () => null,
        qualityPolicy: { enableHybridFallback: true, qualityThreshold: 0.8 },
    });
    assert.strictEqual(out.saved, 1);
    assert.strictEqual(out.results[0].duplicate, true);
    assert.strictEqual(out.results[0].quality.sourceMode, 'hybrid');
}

async function testDegradedCardRejected() {
    const out = await processWordTokens('scheme', 'TOEIC_AI', ['moltbot'], {
        qualityFn: async (word) => makeQuality(word, {
            confidence: 0.45,
            degraded: true,
            hardFail: false,
            warnings: ['tip_not_specific'],
        }),
        addCardFn: async () => ({ noteId: 300, duplicate: false, updated: false, action: 'add' }),
        syncFn: async () => null,
        qualityPolicy: { enableHybridFallback: true, qualityThreshold: 0.8 },
    });
    assert.strictEqual(out.saved, 0);
    assert.strictEqual(out.failed, 1);
    assert.strictEqual(out.failedQualityCount, 1);
    assert.ok(out.failedTokens[0].includes('low_quality'));
}

async function testTypoSuspicionAutoCorrectsAndSaves() {
    const fronts = [];
    const out = await processWordTokens('fragle', 'TOEIC_AI', ['moltbot'], {
        qualityFn: async (word) => makeQuality(word, { confidence: 0.95 }),
        typoCorrectionFn: async () => ({
            word: 'fragile',
            source: 'rule_fallback',
            confidence: 0.9,
        }),
        addCardFn: async (_deck, front) => {
            fronts.push(front);
            return { noteId: 301, duplicate: false, updated: false, action: 'add' };
        },
        syncFn: async () => null,
        qualityPolicy: { enableHybridFallback: false, qualityThreshold: 0.8 },
    });
    assert.strictEqual(out.saved, 1);
    assert.strictEqual(out.failed, 0);
    assert.deepStrictEqual(fronts, ['fragile']);
    assert.ok(Array.isArray(out.autoCorrections) && out.autoCorrections.length > 0);
    assert.strictEqual(out.autoCorrections[0].from, 'fragle');
    assert.strictEqual(out.autoCorrections[0].to, 'fragile');
    assert.ok(String(out.telegramReply || '').includes('자동 보정'));
}

async function testDetachedKoreanHintFragmentsMerged() {
    const observed = [];
    const out = await processWordTokens('Sip 홀짝거리다, 마시다', 'TOEIC_AI', ['moltbot'], {
        qualityFn: async (word, hint) => {
            observed.push({ word, hint });
            return makeQuality(word, {
                meaningKo: hint || '의미',
            });
        },
        addCardFn: async (_deck, front, _back) => ({ noteId: front.length, duplicate: false, updated: false, action: 'add' }),
        syncFn: async () => null,
        qualityPolicy: { enableHybridFallback: false, qualityThreshold: 0.8 },
    });
    assert.strictEqual(out.saved, 1);
    assert.strictEqual(out.failed, 0);
    assert.strictEqual(observed.length, 1);
    assert.strictEqual(observed[0].word, 'Sip');
    assert.ok(String(observed[0].hint || '').includes('홀짝거리다'));
    assert.ok(String(observed[0].hint || '').includes('마시다'));
}

async function testNoisySymbolHintsAreParsed() {
    const input = [
        'Chimney 굴뚝',
        'Glance 흘깃 보다, 잠깐 보다',
        'Ceiling 천장',
        'Kettle 주전자',
        'Wave (손,팔을) 흔들다',
        'Lamppost 가로등 기둥',
        'Make it to ~에 참석하다',
        'Monthly installment 할부',
        'Price can’t be bit 가격이 싸다',
        'Antibiotics 항생제',
        'Prescription 처방전',
        'Drop off ~에 갖다놓다',
        'Errand 심부름',
        'Hassle 귀찮은 일',
    ].join('\n');
    const fronts = [];
    const out = await processWordTokens(input, 'TOEIC_AI', ['moltbot'], {
        qualityFn: async (word, hint) => makeQuality(word, { meaningKo: hint || '의미' }),
        addCardFn: async (_deck, front) => {
            fronts.push(front);
            return { noteId: fronts.length, duplicate: false, updated: false, action: 'add' };
        },
        syncFn: async () => null,
        qualityPolicy: { enableHybridFallback: false, qualityThreshold: 0.8 },
    });
    assert.strictEqual(out.failed, 0);
    assert.strictEqual(out.saved, 14);
    assert.ok(fronts.includes('Wave'));
    assert.ok(fronts.includes('Make it to'));
    assert.ok(fronts.some((v) => String(v).toLowerCase().includes("can't")));
    assert.ok(fronts.includes('Drop off'));
}

async function run() {
    await testSlashAndBatchParsing();
    await testLowQualityRejection();
    await testSyncWarningSeparated();
    await testDuplicateMetaPropagation();
    await testDegradedCardRejected();
    await testTypoSuspicionAutoCorrectsAndSaves();
    await testDetachedKoreanHintFragmentsMerged();
    await testNoisySymbolHintsAreParsed();
    console.log('test_anki_pipeline: ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
