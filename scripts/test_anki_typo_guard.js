const assert = require('assert');
const { analyzeWordFailures, detectTypoSuspicion, guessWordTypos } = require('./anki_typo_guard');

function main() {
    const candidates = guessWordTypos('fragle');
    assert.ok(candidates.includes('fragile'), 'fragle should suggest fragile');
    const signal = detectTypoSuspicion('fragle');
    assert.strictEqual(signal.suspicious, true);
    assert.strictEqual(signal.primary, 'fragile');
    const customSignal = detectTypoSuspicion('answr', {
        includeRuntimeLexicon: false,
        extraLexicon: ['answer'],
    });
    assert.strictEqual(customSignal.suspicious, true);
    assert.ok(customSignal.suggestions.includes('answer'));

    const reviewed = analyzeWordFailures([
        { token: 'fragle 취약한', reason: 'low_quality:no_definition_found' },
        { token: '1234', reason: 'parse_failed' },
        { token: 'promt', reason: 'typo_suspected:prompt|persist' },
    ]);
    assert.strictEqual(reviewed.needsClarification, true);
    assert.ok(reviewed.clarificationLines.some((line) => line.includes('fragile')));
    assert.ok(reviewed.clarificationLines.some((line) => line.includes('prompt')));
    assert.ok(reviewed.clarificationLines.some((line) => line.includes('형식을 다시 보내주세요')));

    console.log('test_anki_typo_guard: ok');
}

main();
