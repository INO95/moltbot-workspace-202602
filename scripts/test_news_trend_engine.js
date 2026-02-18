const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { ensureNewsSchema, runSql, runSqlJson, writeJsonFile } = require('./news_storage');
const { runTrendEngine } = require('./news_trend_engine');

function isoAt(base, minutesOffset) {
    return new Date(base.getTime() + minutesOffset * 60 * 1000).toISOString();
}

async function main() {
    const now = new Date('2026-02-14T12:00:00.000Z');
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const dbPath = path.join(__dirname, '..', 'data', 'tmp', `news_trend_test_${suffix}.sqlite`);
    const sourcesPath = path.join(__dirname, '..', 'data', 'tmp', `news_sources_test_${suffix}.json`);

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    ensureNewsSchema(dbPath);

    writeJsonFile(sourcesPath, {
        mode: 'api_rss_only',
        thresholds: {
            windowMinutes: 120,
            minMentions: 2,
            velocityThreshold: 1.1,
            cooldownHours: 2,
        },
        eventThresholds: {
            scoreThreshold: 2.3,
            minMentions: 3,
            minVelocity: 1.5,
        },
        keywords: ['vibe coding', 'openai'],
        sources: [],
    });

    runSql(dbPath, `
INSERT INTO news_keywords(keyword, enabled, created_at)
VALUES ('vibe coding', 1, '${now.toISOString()}'),
       ('openai', 1, '${now.toISOString()}');
`);

    runSql(dbPath, `
INSERT INTO news_items(
  source, community, post_id, title, body, comments_text, author,
  created_at, score, comments, url, fetched_at
)
VALUES
  ('forem', 'dev.to/ai', '1', 'Vibe Coding with Cursor', 'vibecoding workflow notes', '', 'u1', '${isoAt(now, -20)}', 10, 5, 'https://dev.to/a', '${now.toISOString()}'),
  ('hn', 'hackernews', '2', 'OpenAI and vibe coding trends', 'vibe coding tools', '', 'u2', '${isoAt(now, -40)}', 8, 3, 'https://news.ycombinator.com/item?id=2', '${now.toISOString()}'),
  ('zenn', 'zenn:ai', '3', 'OpenAI API tips', 'openai batching', '', 'u3', '${isoAt(now, -170)}', 1, 1, 'https://zenn.dev/x', '${now.toISOString()}');
`);

    const result = await runTrendEngine({
        dbPath,
        sourcesPath,
        now: now.toISOString(),
    });

    assert.strictEqual(result.ok, true);
    assert.ok(result.createdCount >= 1, `expected at least 1 trend, got ${result.createdCount}`);
    assert.ok(result.trends.some((trend) => trend.keyword === 'vibe coding'));

    const rows = runSqlJson(dbPath, `SELECT keyword, mention_count FROM news_trends ORDER BY id DESC LIMIT 5;`);
    assert.ok(rows.length >= 1, 'news_trends should contain rows');

    fs.rmSync(dbPath, { force: true });
    fs.rmSync(sourcesPath, { force: true });
    console.log(JSON.stringify({ ok: true, createdCount: result.createdCount }));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
