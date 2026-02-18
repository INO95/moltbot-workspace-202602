const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const memoJournal = require('./memo_journal');

function makePaths(baseDir) {
    return {
        entriesPath: path.join(baseDir, 'memo_journal_entries.jsonl'),
        dedupePath: path.join(baseDir, 'memo_journal_dedupe.json'),
        dailyPath: path.join(baseDir, 'memo_journal_daily.json'),
        aggregatePath: path.join(baseDir, 'memo_journal_stats.json'),
    };
}

async function main() {
    const sample = `
260210~11

10 화
오픈클로 고치기 : 코덱스 한도 끝나서 다음에-
알고리즘-
현금 출금 만엔-
프로틴, 클렌징밀크 구매 2491 아마존
운동: 벤치 오헤프 러닝30분

11 수
독서
토익 파트6 파트학습
알고리즘 1문
핸드크림 구매 721엔
`;
    const parsed = memoJournal.parseMemoJournalText(sample, { now: '2026-02-17T00:00:00.000Z' });
    assert.strictEqual(parsed.days.length, 2);
    assert.strictEqual(parsed.days[0], '2026-02-10');
    assert.strictEqual(parsed.days[1], '2026-02-11');
    assert.ok(parsed.items.length >= 8, 'expected parsed items');
    assert.ok(parsed.items.some((row) => row.categories.includes('exercise')));
    assert.ok(parsed.items.some((row) => row.categories.includes('finance')));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-journal-test-'));
    const paths = makePaths(tempDir);

    const first = await memoJournal.handleMemoCommand(sample, {
        paths,
        now: '2026-02-17T00:00:00.000Z',
    });
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.action, 'ingest');
    assert.ok(first.added > 0, 'first ingest should add rows');
    assert.ok(String(first.telegramReply || '').includes('메모 기록 완료'));

    const second = await memoJournal.handleMemoCommand(sample, {
        paths,
        now: '2026-02-17T00:00:00.000Z',
    });
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.action, 'ingest');
    assert.strictEqual(second.added, 0, 'second ingest should be deduped');
    assert.ok(second.duplicates > 0, 'duplicates should be counted');

    const statAll = await memoJournal.handleMemoCommand('통계', { paths });
    assert.strictEqual(statAll.success, true);
    assert.strictEqual(statAll.action, 'stats');
    assert.ok(String(statAll.telegramReply || '').includes('메모 누적 통계'));

    const statMonth = await memoJournal.handleMemoCommand('통계 2026-02', { paths });
    assert.strictEqual(statMonth.success, true);
    assert.strictEqual(statMonth.action, 'stats');
    assert.ok(String(statMonth.telegramReply || '').includes('2026-02'));

    const filePath = path.join(tempDir, 'sample_memo.txt');
    fs.writeFileSync(filePath, sample, 'utf8');
    const fromFile = await memoJournal.handleMemoCommand(`파일: ${filePath}`, {
        paths,
        now: '2026-02-17T00:00:00.000Z',
    });
    assert.strictEqual(fromFile.success, true);
    assert.strictEqual(fromFile.action, 'ingest');

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('test_memo_journal: ok');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
