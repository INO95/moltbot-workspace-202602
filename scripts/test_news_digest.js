const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { ensureNewsSchema, writeJsonFile, runSql, runSqlJson } = require('./news_storage');
const { handleNewsCommand, buildDigestText } = require('./news_digest');

async function main() {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const dbPath = path.join(__dirname, '..', 'data', 'tmp', `news_digest_test_${suffix}.sqlite`);
    const sourcesPath = path.join(__dirname, '..', 'data', 'tmp', `news_sources_test_${suffix}.json`);
    const statePath = path.join(__dirname, '..', 'data', 'tmp', `news_state_test_${suffix}.json`);
    const nowIso = new Date('2026-02-14T12:00:00.000Z').toISOString();

    ensureNewsSchema(dbPath);
    writeJsonFile(sourcesPath, {
        mode: 'api_rss_only',
        tokenBudget: { maxFetchedBytesPerRun: 180000, maxItemsPerSourcePerRun: 30 },
        thresholds: { windowMinutes: 120, minMentions: 2, velocityThreshold: 1.1, cooldownHours: 2 },
        eventThresholds: { scoreThreshold: 2.3, minMentions: 3, minVelocity: 1.5 },
        sources: [
            { id: 'hn', enabled: true, pollMinutes: 20 },
            { id: 'forem', enabled: true, pollMinutes: 30 },
        ],
        keywords: ['vibe coding'],
    });
    writeJsonFile(statePath, { version: 1, updatedAt: nowIso, sources: {} });

    runSql(dbPath, `
INSERT INTO news_keywords(keyword, enabled, created_at)
VALUES ('vibe coding', 1, '${nowIso}');
INSERT INTO news_items(
  source, community, post_id, title, body, comments_text, author,
  created_at, score, comments, url, fetched_at
)
VALUES
  ('hn', 'hackernews', '1', 'Vibe coding thread', 'vibecoding ideas', '', 'a', '${nowIso}', 3, 1, 'https://example.com/1', '${nowIso}');
INSERT INTO news_trends(
  keyword, window_start, window_end, mention_count, velocity, top_refs_json,
  trend_score, reason_text, level, created_at
)
VALUES
  ('vibe coding', '2026-02-14T10:00:00.000Z', '2026-02-14T12:00:00.000Z', 4, 2.0, '[]', 2.9, 'test', 'medium', '${nowIso}');
`);

    const status = await handleNewsCommand('상태', { dbPath, sourcesPath, statePath });
    assert.strictEqual(status.success, true);
    assert.ok(status.telegramReply.includes('소식 트래커 상태'));
    assert.strictEqual(status.preferredModelAlias, 'fast');
    assert.strictEqual(status.activeModelStage, 'collect');

    const addKw = await handleNewsCommand('키워드 추가 codex', { dbPath, sourcesPath, statePath });
    assert.strictEqual(addKw.success, true);
    const kwRows = runSqlJson(dbPath, `SELECT keyword, enabled FROM news_keywords WHERE keyword='codex';`);
    assert.strictEqual(kwRows.length, 1);
    assert.strictEqual(Number(kwRows[0].enabled), 1);

    const disableKw = await handleNewsCommand('키워드 제외 codex', { dbPath, sourcesPath, statePath });
    assert.strictEqual(disableKw.success, true);
    const kwRows2 = runSqlJson(dbPath, `SELECT keyword, enabled FROM news_keywords WHERE keyword='codex';`);
    assert.strictEqual(Number(kwRows2[0].enabled), 0);

    const toggleSource = await handleNewsCommand('소스 off hn', { dbPath, sourcesPath, statePath });
    assert.strictEqual(toggleSource.success, true);
    const sourceConfig = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
    const hn = sourceConfig.sources.find((row) => row.id === 'hn');
    assert.strictEqual(hn.enabled, false);

    const digest = await handleNewsCommand('지금요약', {
        dbPath,
        sourcesPath,
        statePath,
        collectFn: async () => ({ ok: true, summary: { inserted: 0 }, budget: { usageRatio: 0 } }),
        trendFn: async () => ({ ok: true, createdCount: 0, trends: [] }),
    });
    assert.strictEqual(digest.success, true);
    assert.ok(digest.telegramReply.includes('테크 트렌드 칼럼'));
    assert.strictEqual(digest.preferredModelAlias, 'gpt');
    assert.strictEqual(digest.activeModelStage, 'write');

    const digestNoDup = buildDigestText([
        { keyword: 'ai', mention_count: 10, velocity: 2.3, trend_score: 5.2, level: 'high' },
        { keyword: 'ai', mention_count: 8, velocity: 2.0, trend_score: 4.0, level: 'medium' },
        { keyword: 'agent', mention_count: 4, velocity: 1.8, trend_score: 3.1, level: 'medium' },
    ], [], nowIso);
    assert.ok(digestNoDup.includes('테크 트렌드 칼럼'));
    assert.ok(!/\d+위\s+/g.test(digestNoDup), 'ranking format must be removed');
    assert.ok(digestNoDup.includes('ai'));
    assert.ok(digestNoDup.includes('agent'));

    const digestWithHistory = buildDigestText([
        { keyword: 'ai', mention_count: 12, velocity: 2.5, trend_score: 5.8, level: 'high', top_refs_json: [] },
        { keyword: 'agent', mention_count: 6, velocity: 2.1, trend_score: 4.4, level: 'high', top_refs_json: [] },
        { keyword: 'openclaw', mention_count: 3, velocity: 1.9, trend_score: 3.2, level: 'medium', top_refs_json: [] },
        { keyword: 'codex', mention_count: 2, velocity: 1.5, trend_score: 2.4, level: 'low', top_refs_json: [] },
    ], [], nowIso, {
        previousDigest: {
            last_digest_trends: {
                ai: { mention_count: 9, velocity: 2.0, trend_score: 4.9, top_refs_json: [] },
            },
        },
        digestPolicy: {
            overlapKeywordsMin: 1,
            maxRepeatFocus: 2,
            personalizationEnabled: true,
            personalizationMaxItems: 1,
        },
        interestKeywords: ['agent', 'openclaw', 'codex'],
    });
    assert.ok(digestWithHistory.includes('전 리포트와 겹치는 축(ai)'));
    assert.ok(digestWithHistory.includes('Δ'));
    assert.ok(digestWithHistory.includes('관심사 맞춤'));

    fs.rmSync(dbPath, { force: true });
    fs.rmSync(sourcesPath, { force: true });
    fs.rmSync(statePath, { force: true });

    console.log(JSON.stringify({ ok: true }));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
