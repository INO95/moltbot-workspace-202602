#!/usr/bin/env node
const axios = require('axios');

const {
    getPaths,
    readJsonFile,
    ensureNewsSchema,
    ensureKeywordsFromConfig,
    insertNewsItems,
    listRecentFingerprints,
} = require('./news_storage');
const { readFetchState, writeFetchState, getSourceState, shouldPoll } = require('./news_fetch_state');
const { getSourceCollector } = require('./news_sources_registry');

class BudgetExceededError extends Error {
    constructor(scope, detail) {
        super(`${scope} budget exceeded`);
        this.code = 'NEWS_BUDGET_EXCEEDED';
        this.scope = scope;
        this.detail = detail;
    }
}

function nowIso() {
    return new Date().toISOString();
}

function clipText(value, maxLen = 160) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function normalizeIso(value, fallbackIso) {
    const date = value ? new Date(value) : new Date(fallbackIso);
    if (!Number.isFinite(date.getTime())) return fallbackIso;
    return date.toISOString();
}

function canonicalizeUrl(rawUrl) {
    const text = String(rawUrl || '').trim();
    if (!text) return '';
    try {
        const u = new URL(text);
        const cleaned = new URL(`${u.origin}${u.pathname}`);
        const allowed = [];
        for (const [key, value] of u.searchParams.entries()) {
            if (/^utm_/i.test(key)) continue;
            if (/^(fbclid|gclid|si)$/i.test(key)) continue;
            allowed.push([key, value]);
        }
        allowed.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
        for (const [key, value] of allowed) cleaned.searchParams.append(key, value);
        const normalized = `${cleaned.origin}${cleaned.pathname}${cleaned.search}`;
        return normalized.toLowerCase();
    } catch (error) {
        return text.toLowerCase();
    }
}

function normalizeTitle(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
}

function makeFingerprint(item) {
    const canonicalUrl = canonicalizeUrl(item.url);
    if (canonicalUrl) return `url:${canonicalUrl}`;
    return `title:${normalizeTitle(item.title)}`;
}

function normalizeSourceConfig(rawConfig = {}) {
    const tokenBudget = rawConfig.tokenBudget || {};
    const thresholds = rawConfig.thresholds || {};
    const eventThresholds = rawConfig.eventThresholds || {};

    return {
        mode: String(rawConfig.mode || 'api_rss_only'),
        tokenBudget: {
            maxFetchedBytesPerRun: Number(tokenBudget.maxFetchedBytesPerRun || 180000),
            maxItemsPerSourcePerRun: Number(tokenBudget.maxItemsPerSourcePerRun || 30),
        },
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
        keywords: Array.isArray(rawConfig.keywords) ? rawConfig.keywords : [],
        sources: Array.isArray(rawConfig.sources) ? rawConfig.sources : [],
    };
}

function createBudgetedHttpClient({ sourceId, sourceLimitBytes, globalLimitBytes, getGlobalBytes, addGlobalBytes, sourceState }) {
    let sourceBytes = 0;
    const etagByUrl = { ...(sourceState.etagByUrl || {}) };
    const lastModifiedByUrl = { ...(sourceState.lastModifiedByUrl || {}) };

    async function request(url, { kind = 'json', headers = {}, stateKey } = {}) {
        const key = stateKey || url;
        const reqHeaders = {
            'User-Agent': 'moltbot-news/2.0',
            ...headers,
        };
        if (etagByUrl[key]) reqHeaders['If-None-Match'] = etagByUrl[key];
        if (lastModifiedByUrl[key]) reqHeaders['If-Modified-Since'] = lastModifiedByUrl[key];

        const response = await axios({
            method: 'get',
            url,
            headers: reqHeaders,
            timeout: 15000,
            responseType: 'text',
            transformResponse: [(value) => value],
            validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
        });

        if (response.status === 304) {
            return {
                notModified: true,
                status: 304,
                headers: response.headers || {},
                data: kind === 'json' ? null : '',
                bytes: 0,
            };
        }

        const rawBody = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || '');
        const bytes = Buffer.byteLength(rawBody || '', 'utf8');
        if (sourceBytes + bytes > sourceLimitBytes) {
            throw new BudgetExceededError('source', { sourceId, sourceBytes, bytes, sourceLimitBytes });
        }
        if (getGlobalBytes() + bytes > globalLimitBytes) {
            throw new BudgetExceededError('global', { sourceId, globalBytes: getGlobalBytes(), bytes, globalLimitBytes });
        }

        sourceBytes += bytes;
        addGlobalBytes(bytes);

        if (response.headers && response.headers.etag) etagByUrl[key] = String(response.headers.etag);
        if (response.headers && response.headers['last-modified']) {
            lastModifiedByUrl[key] = String(response.headers['last-modified']);
        }

        if (kind === 'text') {
            return {
                notModified: false,
                status: response.status,
                headers: response.headers || {},
                data: rawBody,
                bytes,
            };
        }

        let parsed;
        try {
            parsed = rawBody ? JSON.parse(rawBody) : null;
        } catch (error) {
            throw new Error(`json_parse_failed(${sourceId}): ${error.message}`);
        }

        return {
            notModified: false,
            status: response.status,
            headers: response.headers || {},
            data: parsed,
            bytes,
        };
    }

    return {
        getJson: (url, options = {}) => request(url, { ...options, kind: 'json' }),
        getText: (url, options = {}) => request(url, { ...options, kind: 'text' }),
        getBytesUsed: () => sourceBytes,
        getStatePatch: () => ({ etagByUrl, lastModifiedByUrl }),
    };
}

function normalizeItem(item, fetchedAtIso) {
    const title = clipText(item.title || '', 220);
    if (!title) return null;

    return {
        source: clipText(item.source || 'unknown', 32),
        community: clipText(item.community || 'general', 64),
        post_id: clipText(item.post_id || '', 128),
        title,
        body: clipText(item.body || '', 160),
        comments_text: clipText(item.comments_text || '', 160),
        author: clipText(item.author || '', 80),
        created_at: normalizeIso(item.created_at, fetchedAtIso),
        score: Number.isFinite(Number(item.score)) ? Math.round(Number(item.score)) : 0,
        comments: Number.isFinite(Number(item.comments)) ? Math.round(Number(item.comments)) : 0,
        url: clipText(canonicalizeUrl(item.url), 500),
        fetched_at: fetchedAtIso,
    };
}

async function collectNews(options = {}) {
    const paths = getPaths(options);
    const config = normalizeSourceConfig(readJsonFile(paths.sourcesPath, {}));
    const state = readFetchState(paths.statePath);
    const runAt = options.now ? new Date(options.now) : new Date();
    const runAtIso = runAt.toISOString();

    ensureNewsSchema(paths.dbPath);
    ensureKeywordsFromConfig(paths.dbPath, config.keywords);

    const enabledSources = config.sources.filter((source) => source && source.enabled !== false);
    const totalBudget = Math.max(12000, Number(config.tokenBudget.maxFetchedBytesPerRun || 180000));
    const maxItemsDefault = Math.max(1, Number(config.tokenBudget.maxItemsPerSourcePerRun || 30));
    const lookbackSinceIso = new Date(runAt.getTime() - (7 * 24 * 60 * 60 * 1000)).toISOString();
    const knownFingerprints = listRecentFingerprints(paths.dbPath, lookbackSinceIso);

    let totalBytesUsed = 0;
    let insertedTotal = 0;
    let duplicateTotal = 0;
    let skippedByPoll = 0;
    const sourceSummaries = [];

    for (const source of enabledSources) {
        const sourceId = String(source.id || '').trim();
        if (!sourceId) continue;

        const sourceState = getSourceState(state, sourceId);
        if (!options.force && !shouldPoll(sourceState, source.pollMinutes, runAt.getTime())) {
            skippedByPoll += 1;
            sourceSummaries.push({
                id: sourceId,
                ok: true,
                skipped: true,
                reason: 'poll_interval',
                inserted: 0,
                duplicates: 0,
                bytes: 0,
            });
            continue;
        }

        const enabledCount = Math.max(1, enabledSources.length);
        const defaultPerSourceBudget = Math.max(8000, Math.floor(totalBudget / enabledCount));
        const sourceBudget = Math.max(4000, Number(source.maxFetchedBytes || defaultPerSourceBudget));
        const maxItems = Math.max(1, Math.min(maxItemsDefault, Number(source.maxItems || maxItemsDefault)));

        const http = createBudgetedHttpClient({
            sourceId,
            sourceLimitBytes: sourceBudget,
            globalLimitBytes: totalBudget,
            getGlobalBytes: () => totalBytesUsed,
            addGlobalBytes: (bytes) => { totalBytesUsed += bytes; },
            sourceState,
        });

        try {
            const collectFn = getSourceCollector(sourceId);
            const result = await collectFn({
                source,
                sourceState,
                maxItems,
                http,
                now: runAt,
            });

            const normalizedItems = [];
            const sourceDuplicates = [];
            const rawItems = Array.isArray(result.items) ? result.items : [];
            for (const rawItem of rawItems) {
                const item = normalizeItem(rawItem, runAtIso);
                if (!item || !item.post_id) continue;
                const fp = makeFingerprint(item);
                if (!fp || knownFingerprints.has(fp)) {
                    sourceDuplicates.push(item);
                    continue;
                }
                knownFingerprints.add(fp);
                normalizedItems.push(item);
            }

            const insertedResult = options.dryRun
                ? { inserted: normalizedItems.length, skipped: sourceDuplicates.length }
                : insertNewsItems(paths.dbPath, normalizedItems);

            insertedTotal += insertedResult.inserted;
            duplicateTotal += (insertedResult.skipped + sourceDuplicates.length);

            const statePatch = {
                ...sourceState,
                ...(result.statePatch || {}),
                ...(http.getStatePatch() || {}),
                lastRunAt: runAtIso,
                lastError: null,
            };
            state.sources[sourceId] = statePatch;

            sourceSummaries.push({
                id: sourceId,
                ok: true,
                skipped: false,
                inserted: insertedResult.inserted,
                duplicates: insertedResult.skipped + sourceDuplicates.length,
                rawFetched: rawItems.length,
                accepted: normalizedItems.length,
                bytes: http.getBytesUsed(),
            });
        } catch (error) {
            const isSkippedError = error && error.code === 'NEWS_SOURCE_SKIPPED';
            const isBudgetError = error && error.code === 'NEWS_BUDGET_EXCEEDED';
            const errorText = String(error && (error.message || error.reason) ? (error.message || error.reason) : error);

            if (isSkippedError) {
                const reason = String(error.reason || 'collector_skipped');
                state.sources[sourceId] = {
                    ...sourceState,
                    ...(http.getStatePatch() || {}),
                    lastRunAt: runAtIso,
                    lastError: reason,
                };

                sourceSummaries.push({
                    id: sourceId,
                    ok: true,
                    skipped: true,
                    reason,
                    error: errorText,
                    bytes: http.getBytesUsed(),
                    inserted: 0,
                    duplicates: 0,
                });
                continue;
            }

            state.sources[sourceId] = {
                ...sourceState,
                ...(http.getStatePatch() || {}),
                lastRunAt: runAtIso,
                lastError: errorText,
            };

            sourceSummaries.push({
                id: sourceId,
                ok: false,
                skipped: false,
                reason: isBudgetError ? 'budget_exceeded' : 'collect_failed',
                error: errorText,
                bytes: http.getBytesUsed(),
                inserted: 0,
                duplicates: 0,
            });

            if (isBudgetError && error.scope === 'global') break;
        }
    }

    writeFetchState(paths.statePath, state);

    return {
        ok: true,
        mode: config.mode,
        runAt: runAtIso,
        dbPath: paths.dbPath,
        sourcesPath: paths.sourcesPath,
        statePath: paths.statePath,
        budget: {
            maxFetchedBytesPerRun: totalBudget,
            usedBytes: totalBytesUsed,
            usageRatio: Number((totalBytesUsed / totalBudget).toFixed(4)),
        },
        summary: {
            enabledSources: enabledSources.length,
            skippedByPoll,
            inserted: insertedTotal,
            duplicates: duplicateTotal,
            sourceResults: sourceSummaries,
        },
    };
}

async function main() {
    const force = process.argv.includes('--force');
    const dryRun = process.argv.includes('--dry-run');
    const result = await collectNews({ force, dryRun });
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = {
    collectNews,
    BudgetExceededError,
    canonicalizeUrl,
    normalizeTitle,
};
