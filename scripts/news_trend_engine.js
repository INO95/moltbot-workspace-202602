#!/usr/bin/env node
const {
    getPaths,
    readJsonFile,
    ensureNewsSchema,
    ensureKeywordsFromConfig,
    listEnabledKeywords,
    runSql,
    runSqlJson,
    sqlQuote,
} = require('./news_storage');

const KEYWORD_ALIASES = {
    'vibe coding': ['vibecoding'],
    vibecoding: ['vibe coding'],
    'opus 4.6': ['opus4.6'],
    'opus4.6': ['opus 4.6'],
    'gpt 5': ['gpt-5'],
    'gpt-5': ['gpt 5'],
};

function normalizeText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
}

function getKeywordVariants(keyword) {
    const base = normalizeText(keyword);
    const aliases = KEYWORD_ALIASES[base] || [];
    const all = [base, ...aliases.map((x) => normalizeText(x))]
        .map((x) => x.trim())
        .filter(Boolean);
    return [...new Set(all)];
}

function containsKeyword(contentNormalized, keyword) {
    const variants = getKeywordVariants(keyword);
    if (!variants.length) return false;
    return variants.some((variant) => contentNormalized.includes(variant));
}

function parseSourceConfig(paths) {
    const config = readJsonFile(paths.sourcesPath, {});
    const thresholds = config.thresholds || {};
    const eventThresholds = config.eventThresholds || {};
    return {
        keywords: Array.isArray(config.keywords) ? config.keywords : [],
        thresholds: {
            windowMinutes: Number(thresholds.windowMinutes || 120),
            minMentions: Number(thresholds.minMentions || 4),
            velocityThreshold: Number(thresholds.velocityThreshold || 1.6),
            cooldownHours: Number(thresholds.cooldownHours || 2),
        },
        eventThresholds: {
            scoreThreshold: Number(eventThresholds.scoreThreshold || 2.3),
            minMentions: Number(eventThresholds.minMentions || 6),
            minVelocity: Number(eventThresholds.minVelocity || 2.0),
        },
    };
}

function scoreTrend({ mentionCount, velocity, avgEngagement, sourceDiversity }) {
    const mentionWeight = Math.min(4, mentionCount / 3);
    const velocityWeight = Math.min(4, Math.max(0, velocity - 1));
    const engagementWeight = Math.min(3, avgEngagement / 20);
    const sourceDiversityWeight = Math.min(2, sourceDiversity / 2);
    const trendScore = mentionWeight + velocityWeight + engagementWeight + sourceDiversityWeight;
    return {
        mentionWeight,
        velocityWeight,
        engagementWeight,
        sourceDiversityWeight,
        trendScore: Number(trendScore.toFixed(4)),
    };
}

function levelFromScore(score) {
    if (score >= 3.8) return 'high';
    if (score >= 2.3) return 'medium';
    return 'low';
}

function buildReasonText(keyword, mentionCount, velocity, avgComments, communities) {
    const topCommunities = communities.slice(0, 2)
        .map((row) => `${row.community} ${row.count}건`)
        .join(', ');
    const topText = topCommunities ? ` 주요 커뮤니티: ${topCommunities}` : '';
    return `${keyword} 언급 ${mentionCount}건, 증가율 ${velocity.toFixed(2)}배, 평균 댓글 ${avgComments.toFixed(1)}건.${topText}`;
}

function getRowsInWindow(rows, startMs, endMs) {
    return rows.filter((row) => {
        const ts = Date.parse(row.created_at);
        return Number.isFinite(ts) && ts >= startMs && ts < endMs;
    });
}

async function runTrendEngine(options = {}) {
    const paths = getPaths(options);
    const config = parseSourceConfig(paths);
    const now = options.now ? new Date(options.now) : new Date();
    const nowMs = now.getTime();
    const windowMinutes = Number(options.windowMinutes || config.thresholds.windowMinutes || 120);
    const windowMs = windowMinutes * 60 * 1000;
    const currentStartMs = nowMs - windowMs;
    const previousStartMs = currentStartMs - windowMs;

    ensureNewsSchema(paths.dbPath);
    ensureKeywordsFromConfig(paths.dbPath, config.keywords);

    const keywords = listEnabledKeywords(paths.dbPath);
    if (!keywords.length) {
        return {
            ok: true,
            createdCount: 0,
            trends: [],
            windowMinutes,
            windowStart: new Date(currentStartMs).toISOString(),
            windowEnd: new Date(nowMs).toISOString(),
        };
    }

    const rows = runSqlJson(
        paths.dbPath,
        `
SELECT source, community, title, body, comments_text, score, comments, url, created_at
FROM news_items
WHERE created_at >= ${sqlQuote(new Date(previousStartMs).toISOString())}
  AND created_at < ${sqlQuote(new Date(nowMs).toISOString())};
`
    );

    const normalizedRows = rows.map((row) => ({
        ...row,
        normalized: normalizeText(`${row.title || ''} ${row.body || ''} ${row.comments_text || ''}`),
        engagement: Number(row.score || 0) + Number(row.comments || 0),
    }));

    const currentRows = getRowsInWindow(normalizedRows, currentStartMs, nowMs);
    const previousRows = getRowsInWindow(normalizedRows, previousStartMs, currentStartMs);

    const minMentions = Number(config.thresholds.minMentions || 4);
    const minVelocity = Number(config.thresholds.velocityThreshold || 1.6);
    const createdAtIso = now.toISOString();
    const windowStartIso = new Date(currentStartMs).toISOString();
    const windowEndIso = new Date(nowMs).toISOString();

    const insertedTrends = [];

    for (const keyword of keywords) {
        const currentHits = currentRows.filter((row) => containsKeyword(row.normalized, keyword));
        if (!currentHits.length) continue;

        const previousCount = previousRows.filter((row) => containsKeyword(row.normalized, keyword)).length;
        const mentionCount = currentHits.length;
        const velocity = Number((mentionCount / Math.max(previousCount, 1)).toFixed(4));
        if (mentionCount < minMentions) continue;
        if (velocity < minVelocity) continue;

        const avgEngagement = currentHits.reduce((sum, row) => sum + row.engagement, 0) / Math.max(1, mentionCount);
        const avgComments = currentHits.reduce((sum, row) => sum + Number(row.comments || 0), 0) / Math.max(1, mentionCount);
        const sourceDiversity = new Set(currentHits.map((row) => row.source)).size;

        const communityCountMap = new Map();
        for (const row of currentHits) {
            const key = String(row.community || 'unknown');
            communityCountMap.set(key, (communityCountMap.get(key) || 0) + 1);
        }
        const communities = [...communityCountMap.entries()]
            .map(([community, count]) => ({ community, count }))
            .sort((a, b) => b.count - a.count);

        const scoreParts = scoreTrend({ mentionCount, velocity, avgEngagement, sourceDiversity });
        const level = levelFromScore(scoreParts.trendScore);
        const reasonText = buildReasonText(keyword, mentionCount, velocity, avgComments, communities);

        const topRefs = currentHits
            .slice()
            .sort((a, b) => b.engagement - a.engagement)
            .slice(0, 5)
            .map((row) => ({
                source: row.source,
                community: row.community,
                title: row.title,
                url: row.url,
                score: Number(row.score || 0),
                comments: Number(row.comments || 0),
                created_at: row.created_at,
            }));

        const dup = runSqlJson(
            paths.dbPath,
            `
SELECT id FROM news_trends
WHERE keyword = ${sqlQuote(keyword)}
  AND window_start = ${sqlQuote(windowStartIso)}
  AND window_end = ${sqlQuote(windowEndIso)}
LIMIT 1;
`
        );
        if (dup.length) continue;

        runSql(
            paths.dbPath,
            `
INSERT INTO news_trends (
  keyword,
  window_start,
  window_end,
  mention_count,
  velocity,
  top_refs_json,
  trend_score,
  reason_text,
  level,
  created_at
)
VALUES (
  ${sqlQuote(keyword)},
  ${sqlQuote(windowStartIso)},
  ${sqlQuote(windowEndIso)},
  ${mentionCount},
  ${velocity},
  ${sqlQuote(JSON.stringify(topRefs))},
  ${scoreParts.trendScore},
  ${sqlQuote(reasonText)},
  ${sqlQuote(level)},
  ${sqlQuote(createdAtIso)}
);
`
        );

        insertedTrends.push({
            keyword,
            window_start: windowStartIso,
            window_end: windowEndIso,
            mention_count: mentionCount,
            velocity,
            trend_score: scoreParts.trendScore,
            level,
            reason_text: reasonText,
            top_refs_json: topRefs,
        });
    }

    return {
        ok: true,
        dbPath: paths.dbPath,
        windowMinutes,
        windowStart: windowStartIso,
        windowEnd: windowEndIso,
        createdCount: insertedTrends.length,
        trends: insertedTrends,
    };
}

async function main() {
    const result = await runTrendEngine({
        windowMinutes: process.env.NEWS_WINDOW_MINUTES ? Number(process.env.NEWS_WINDOW_MINUTES) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = {
    runTrendEngine,
    normalizeText,
    containsKeyword,
};
