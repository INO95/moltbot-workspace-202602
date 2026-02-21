const assert = require('assert');
const { extractTermCandidates, pickFrontField } = require('./anki_typo_lexicon_sync');

function main() {
  const terms = extractTermCandidates("Prompt: 즉각적인");
  assert.ok(terms.includes('prompt'));

  const phraseTerms = extractTermCandidates("comply with / adhere to");
  assert.ok(phraseTerms.includes('comply with'));
  assert.ok(phraseTerms.includes('adhere to'));

  const front = pickFrontField({
    fields: {
      Question: { value: 'timely' },
      Answer: { value: '시기적절한' },
    },
  });
  assert.strictEqual(front, 'timely');

  console.log('test_anki_typo_lexicon_sync: ok');
}

main();
