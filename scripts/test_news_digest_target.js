const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { ensureNewsSchema, writeJsonFile, runSql } = require('./news_storage');
const { handleNewsCommand } = require('./news_digest');

async function withEnv(overrides, fn) {
    const keys = Object.keys(overrides);
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
        for (const k of keys) {
            const v = overrides[k];
            if (v == null) delete process.env[k];
            else process.env[k] = String(v);
        }
        return await fn();
    } finally {
        for (const k of keys) {
            if (prev[k] == null) delete process.env[k];
            else process.env[k] = prev[k];
        }
    }
}

async function main() {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const dbPath = path.join(__dirname, '..', 'data', 'tmp', `news_digest_target_${suffix}.sqlite`);
    const sourcesPath = path.join(__dirname, '..', 'data', 'tmp', `news_sources_target_${suffix}.json`);
    const statePath = path.join(__dirname, '..', 'data', 'tmp', `news_state_target_${suffix}.json`);
    const envPath = path.join(__dirname, '..', 'data', 'tmp', `news_env_target_${suffix}.env`);
    const nowIso = new Date('2026-02-14T12:00:00.000Z').toISOString();

    ensureNewsSchema(dbPath);
    writeJsonFile(sourcesPath, {
        mode: 'api_rss_only',
        tokenBudget: { maxFetchedBytesPerRun: 180000, maxItemsPerSourcePerRun: 30 },
        thresholds: { windowMinutes: 120, minMentions: 2, velocityThreshold: 1.1, cooldownHours: 2 },
        eventThresholds: { scoreThreshold: 2.3, minMentions: 3, minVelocity: 1.5 },
        sources: [{ id: 'hn', enabled: true, pollMinutes: 20 }],
        keywords: ['vibe coding'],
    });
    writeJsonFile(statePath, { version: 1, updatedAt: nowIso, sources: {} });
    fs.writeFileSync(envPath, '# test env\\n', 'utf8');

    runSql(dbPath, `
INSERT INTO news_keywords(keyword, enabled, created_at)
VALUES ('vibe coding', 1, '${nowIso}');
INSERT INTO news_trends(
  keyword, window_start, window_end, mention_count, velocity, top_refs_json,
  trend_score, reason_text, level, created_at
)
VALUES
  ('vibe coding', '2026-02-14T10:00:00.000Z', '2026-02-14T12:00:00.000Z', 4, 2.0, '[]', 2.9, 'test', 'medium', '${nowIso}');
`);

    const first = await withEnv({
        MOLTBOT_ENV_FILE: envPath,
        NEWS_TELEGRAM_TARGET: 'research',
        NEWS_QUEUE_FALLBACK: '0',
        TELEGRAM_BOT_TOKEN_TREND: '',
        TELEGRAM_USER_ID_TREND: '',
        TELEGRAM_BOT_TOKEN_RESEARCH: '',
        TELEGRAM_USER_ID_RESEARCH: '',
    }, async () => handleNewsCommand('지금요약', {
        dbPath,
        sourcesPath,
        statePath,
        enqueue: true,
        collectFn: async () => ({ ok: true, summary: { inserted: 0 }, budget: { usageRatio: 0 } }),
        trendFn: async () => ({ ok: true, createdCount: 0, trends: [] }),
    }));

    assert.strictEqual(first.success, false);
    assert.strictEqual(first.errorCode, 'NEWS_TELEGRAM_DELIVERY_FAILED');
    assert.strictEqual(first.delivery.target, 'research');
    assert.strictEqual(first.delivery.queued, false);
    assert.strictEqual(first.delivery.queueFallbackEnabled, false);
    assert.ok(
        /TELEGRAM_BOT_TOKEN_(TREND|RESEARCH)/.test(String(first.delivery.directReason || '')),
    );

    const second = await withEnv({
        MOLTBOT_ENV_FILE: envPath,
        NEWS_TELEGRAM_TARGET: 'dev_bak',
        NEWS_QUEUE_FALLBACK: '0',
        TELEGRAM_BOT_TOKEN_DEV_BAK: '',
        TELEGRAM_USER_ID_DEV_BAK: '',
        TELEGRAM_BOT_TOKEN_MAIN_BAK: '',
        TELEGRAM_USER_ID_MAIN_BAK: '',
    }, async () => handleNewsCommand('지금요약', {
        dbPath,
        sourcesPath,
        statePath,
        enqueue: true,
        collectFn: async () => ({ ok: true, summary: { inserted: 0 }, budget: { usageRatio: 0 } }),
        trendFn: async () => ({ ok: true, createdCount: 0, trends: [] }),
    }));

    assert.strictEqual(second.success, false);
    assert.strictEqual(second.errorCode, 'NEWS_TELEGRAM_DELIVERY_FAILED');
    assert.strictEqual(second.delivery.target, 'dev_bak');
    assert.ok(
        /TELEGRAM_BOT_TOKEN_(DEV_BAK|MAIN_BAK)/.test(String(second.delivery.directReason || '')),
    );

    fs.rmSync(dbPath, { force: true });
    fs.rmSync(sourcesPath, { force: true });
    fs.rmSync(statePath, { force: true });
    fs.rmSync(envPath, { force: true });

    console.log('test_news_digest_target: ok');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
