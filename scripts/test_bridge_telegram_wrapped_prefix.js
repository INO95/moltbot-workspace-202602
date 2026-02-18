const assert = require('assert');
const {
    routeByPrefix,
    normalizeIncomingCommandText,
    normalizeNewsCommandPayload,
} = require('./bridge');

function main() {
    const wrappedWork = '[Telegram BAEK INHO (@ino_0905) id:7704103236 +1m 2026-02-14 18:38 UTC] 작업: 요청: A; 대상: B; 완료기준: C [message_id: 15]';
    const work = routeByPrefix(wrappedWork);
    assert.strictEqual(work.route, 'work');
    assert.strictEqual(work.payload, '요청: A; 대상: B; 완료기준: C');

    const wrappedWord = '[Telegram BAEK INHO (@ino_0905) id:7704103236 +1m 2026-02-14 18:38 UTC] 단어: apple [message_id: 15]';
    const word = routeByPrefix(wrappedWord);
    assert.strictEqual(word.route, 'word');
    assert.strictEqual(word.payload, 'apple');

    const wrappedReply = '[Telegram BAEK INHO (@ino_0905) id:7704103236 +1m 2026-02-14 18:38 UTC] 단어: apple [Replying to Ino_anki_bot id:12] old text [/Replying] [message_id: 15]';
    const normalizedReply = normalizeIncomingCommandText(wrappedReply);
    assert.strictEqual(normalizedReply, '단어: apple');

    assert.strictEqual(normalizeNewsCommandPayload('테크 트렌드 요약'), '지금요약');
    assert.strictEqual(normalizeNewsCommandPayload('요약'), '지금요약');
    assert.strictEqual(normalizeNewsCommandPayload('상태'), '상태');
    assert.strictEqual(normalizeNewsCommandPayload('소스 on hackernews'), '소스 on hackernews');

    console.log('test_bridge_telegram_wrapped_prefix: ok');
}

main();
