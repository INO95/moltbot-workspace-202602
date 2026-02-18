const assert = require('assert');
const { processWordTokens } = require('./bridge');

async function main() {
    const result = await processWordTokens('fragle 취약한', 'TOEIC_AI', ['test'], {
        qualityFn: async () => ({
            lemma: 'fragle',
            partOfSpeech: 'adjective',
            meaningKo: '',
            exampleEn: '',
            exampleKo: '',
            toeicTip: '',
            sourceMode: 'local',
            confidence: 0.05,
            degraded: true,
            warnings: ['no_definition_found'],
            hardFail: true,
            styleVersion: 'v2',
        }),
        addCardFn: async () => {
            throw new Error('addCardFn should not be called for low quality token');
        },
        syncFn: async () => {},
    });

    assert.strictEqual(result.saved, 0);
    assert.strictEqual(result.failedQualityCount, 1);
    assert.strictEqual(result.needsClarification, true);
    assert.ok(String(result.telegramReply || '').includes('입력 확인 필요'));

    console.log('test_bridge_word_typo_reask: ok');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
