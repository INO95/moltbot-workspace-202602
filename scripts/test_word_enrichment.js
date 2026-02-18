const assert = require('assert');
const {
  processWordTokens,
  fallbackExample,
  buildWordCandidates,
} = require('./bridge');
const { createWordQuality } = require('./anki_word_quality');

async function testRejectWeakEnrichment() {
  let addCalls = 0;
  const out = await processWordTokens('foobarbazzz', 'TOEIC_AI', ['moltbot'], {
    enrichFn: async () => ({
      meaning: '(의미 보강 필요)',
      example: fallbackExample('foobarbazzz'),
    }),
    addCardFn: async () => {
      addCalls += 1;
      return 123;
    },
    syncFn: async () => null,
  });

  assert.strictEqual(addCalls, 0, 'weak enrichment should not be added');
  assert.strictEqual(out.saved, 0, 'saved must be 0 for weak enrichment');
  assert.strictEqual(out.failed, 1, 'failed must increase for weak enrichment');
  assert.ok(out.failedTokens.some((v) => {
    const t = String(v);
    return t.includes('no_definition_found') || t.includes('low_quality');
  }));
}

function testCandidateLemmatization() {
  const c1 = buildWordCandidates('studies');
  assert.ok(c1.includes('study'), 'studies should include study');

  const c2 = buildWordCandidates('activated');
  assert.ok(c2.includes('activate') || c2.includes('activat'), 'activated should include a lemma candidate');
}

async function run() {
  await testRejectWeakEnrichment();
  testCandidateLemmatization();
  const phrase = await createWordQuality('comply with', '', {
    policy: { enableHybridFallback: false, qualityThreshold: 0.8 },
  });
  assert.ok(phrase.meaningKo && !phrase.meaningKo.includes('(의미 보강 필요)'), 'phrase meaning should be filled');
  assert.ok(String(phrase.exampleEn).toLowerCase().includes('comply with'), 'phrase example should include target phrase');
  assert.ok(/compli|adhere|conform|abide|Part|파트/.test(String(phrase.toeicTip)), 'toeic tip should be specific');
  console.log('test_word_enrichment: ok');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
