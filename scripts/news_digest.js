#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    getPaths,
    readJsonFile,
    writeJsonFile,
    ensureNewsSchema,
    runSql,
    runSqlJson,
    sqlQuote,
    normalizeKeyword,
} = require('./news_storage');
const { readFetchState } = require('./news_fetch_state');
const { collectNews } = require('./news_collector_api_rss');
const { runTrendEngine } = require('./news_trend_engine');
const { loadRuntimeEnv } = require('./env_runtime');

const DEFAULT_DIGEST_STAGE_MODELS = Object.freeze({
    collect: Object.freeze({
        alias: 'fast',
        model: 'openai-codex/gpt-5.1-codex-mini',
        reasoning: 'low',
    }),
    write: Object.freeze({
        alias: 'gpt',
        model: 'openai/gpt-5.2-pro',
        reasoning: 'high',
    }),
});

const ALLOWED_REASONING_LEVELS = new Set(['low', 'medium', 'high']);
const MODEL_SWITCH_LOCK_DIR = path.join(__dirname, '../data/locks');
const MODEL_SWITCH_LOCK_PATH = path.join(MODEL_SWITCH_LOCK_DIR, 'codex_model_switch.lock');
const DEFAULT_MODEL_WRITER_TIMEOUT_MS = 120000;
const DEFAULT_DIGEST_TIMEZONE = 'America/Los_Angeles';

function normalizeReasoningLevel(value, fallback = 'low') {
    const raw = String(value || '').trim().toLowerCase();
    if (ALLOWED_REASONING_LEVELS.has(raw)) return raw;
    return String(fallback || 'low').trim().toLowerCase() || 'low';
}

function normalizeDigestTimezone(value, fallback = DEFAULT_DIGEST_TIMEZONE) {
    const raw = String(value || '').trim();
    const safeFallback = String(fallback || DEFAULT_DIGEST_TIMEZONE).trim() || DEFAULT_DIGEST_TIMEZONE;
    if (!raw) return safeFallback;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: raw }).format(new Date());
        return raw;
    } catch (_) {
        return safeFallback;
    }
}

function normalizeDigestStageModel(raw, fallback) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const seed = fallback && typeof fallback === 'object' ? fallback : {};
    return {
        alias: String(source.alias || seed.alias || '').trim() || String(seed.alias || 'fast'),
        model: String(source.model || seed.model || '').trim() || String(seed.model || 'openai/gpt-5.2-pro'),
        reasoning: normalizeReasoningLevel(source.reasoning, seed.reasoning || 'low'),
    };
}

function normalizeDigestModelStages(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        collect: normalizeDigestStageModel(source.collect, DEFAULT_DIGEST_STAGE_MODELS.collect),
        write: normalizeDigestStageModel(source.write, DEFAULT_DIGEST_STAGE_MODELS.write),
    };
}

function parseConfig(paths) {
    const config = readJsonFile(paths.sourcesPath, {});
    const thresholds = config.thresholds || {};
    const eventThresholds = config.eventThresholds || {};
    const digestPolicy = config.digestPolicy || {};
    return {
        mode: String(config.mode || 'api_rss_only'),
        tokenBudget: config.tokenBudget || {
            maxFetchedBytesPerRun: 180000,
            maxItemsPerSourcePerRun: 30,
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
        eventAlertsEnabled: config.eventAlertsEnabled !== false,
        digestPolicy: {
            similarityLookbackHours: Math.max(1, Number(digestPolicy.similarityLookbackHours || 8)),
            overlapKeywordsMin: Math.max(1, Number(digestPolicy.overlapKeywordsMin || 2)),
            maxRepeatFocus: Math.max(1, Number(digestPolicy.maxRepeatFocus || 2)),
            personalizationEnabled: digestPolicy.personalizationEnabled !== false,
            personalizationMaxItems: Math.max(1, Number(digestPolicy.personalizationMaxItems || 2)),
            personalizationSource: String(digestPolicy.personalizationSource || 'web').trim().toLowerCase() || 'web',
            reportTimezone: normalizeDigestTimezone(digestPolicy.reportTimezone || DEFAULT_DIGEST_TIMEZONE),
            modelWriterEnabled: digestPolicy.modelWriterEnabled !== false,
            modelWriterTimeoutMs: Math.max(10000, Number(digestPolicy.modelWriterTimeoutMs || DEFAULT_MODEL_WRITER_TIMEOUT_MS)),
            preferenceKeywords: Array.isArray(digestPolicy.preferenceKeywords)
                ? digestPolicy.preferenceKeywords.map((kw) => normalizeKeyword(kw)).filter(Boolean)
                : [],
            modelStages: normalizeDigestModelStages(digestPolicy.modelStages),
        },
        keywords: Array.isArray(config.keywords) ? config.keywords : [],
        sources: Array.isArray(config.sources) ? config.sources : [],
    };
}

function nowIso() {
    return new Date().toISOString();
}

function formatIsoInTimezone(iso, timezone, includeZone = false) {
    const date = new Date(String(iso || ''));
    if (Number.isNaN(date.getTime())) return '';
    const tz = normalizeDigestTimezone(timezone, DEFAULT_DIGEST_TIMEZONE);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const get = (type) => {
        const hit = parts.find((p) => p.type === type);
        return hit ? String(hit.value || '') : '';
    };
    const base = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
    if (!includeZone) return base;
    const zoneParts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'short',
        hour: '2-digit',
    }).formatToParts(date);
    const zone = String((zoneParts.find((p) => p.type === 'timeZoneName') || {}).value || '').trim();
    return zone ? `${base} ${zone}` : base;
}

function getDigestStatePath(paths, overrides = {}) {
    const explicit = overrides.digestStatePath || process.env.NEWS_DIGEST_STATE_PATH;
    if (explicit) return path.resolve(explicit);
    const baseDir = path.dirname(String(paths && paths.statePath ? paths.statePath : path.join(process.cwd(), 'data', 'news', 'news_fetch_state.json')));
    return path.join(baseDir, 'news_digest_state.json');
}

function shouldUsePreviousDigest(state, lookbackHours) {
    const lastAt = Date.parse(state && state.last_digest_at ? state.last_digest_at : '');
    if (!Number.isFinite(lastAt)) return false;
    const hours = Math.max(1, Number(lookbackHours || 8));
    return (Date.now() - lastAt) <= (hours * 60 * 60 * 1000);
}

function firstNonEmpty(...values) {
    for (const value of values) {
        const text = String(value || '').trim();
        if (text) return text;
    }
    return '';
}

function withStageModelMeta(result, config, stage = 'collect') {
    const normalizedStage = String(stage || '').trim().toLowerCase() === 'write' ? 'write' : 'collect';
    const stages = normalizeDigestModelStages(config && config.digestPolicy ? config.digestPolicy.modelStages : null);
    const active = stages[normalizedStage] || DEFAULT_DIGEST_STAGE_MODELS.collect;
    const base = result && typeof result === 'object' ? result : {};
    return {
        ...base,
        modelStagePolicy: stages,
        activeModelStage: normalizedStage,
        preferredModelAlias: firstNonEmpty(base.preferredModelAlias, active.alias),
        preferredReasoning: normalizeReasoningLevel(firstNonEmpty(base.preferredReasoning, active.reasoning), active.reasoning),
        preferredModel: firstNonEmpty(base.preferredModel, active.model),
    };
}

function sleepBusy(ms) {
    const until = Date.now() + Math.max(1, Number(ms || 1));
    while (Date.now() < until) {
        // Busy wait is acceptable for short-lived lock polling.
    }
}

function ensureModelSwitchLockDir() {
    if (!fs.existsSync(MODEL_SWITCH_LOCK_DIR)) {
        fs.mkdirSync(MODEL_SWITCH_LOCK_DIR, { recursive: true });
    }
}

function acquireModelSwitchLock(timeoutMs = 180000) {
    ensureModelSwitchLockDir();
    const startedAt = Date.now();
    while (true) {
        try {
            const fd = fs.openSync(MODEL_SWITCH_LOCK_PATH, 'wx');
            fs.writeFileSync(fd, String(process.pid), 'utf8');
            return fd;
        } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error;
            if (Date.now() - startedAt > timeoutMs) {
                throw new Error(`digest writer lock timeout: ${MODEL_SWITCH_LOCK_PATH}`);
            }
            sleepBusy(200);
        }
    }
}

function releaseModelSwitchLock(fd) {
    try {
        if (typeof fd === 'number') fs.closeSync(fd);
    } catch (_) {
        // no-op
    }
    try {
        if (fs.existsSync(MODEL_SWITCH_LOCK_PATH)) fs.unlinkSync(MODEL_SWITCH_LOCK_PATH);
    } catch (_) {
        // no-op
    }
}

function resolveOpenClawCliRoot() {
    const candidates = [
        path.join(__dirname, '..'),
        process.cwd(),
        '/app',
        '/home/node/app',
    ];
    const seen = new Set();
    for (const root of candidates) {
        const normalized = String(root || '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        const cliPath = path.join(normalized, 'dist', 'index.js');
        if (fs.existsSync(cliPath)) return normalized;
    }
    return '';
}

function resolveOpenClawDockerContainer() {
    const candidates = [
        process.env.NEWS_DIGEST_WRITER_CONTAINER,
        process.env.OPENCLAW_CLI_DOCKER_CONTAINER,
        process.env.OPENCLAW_DOCKER_CONTAINER,
        'moltbot-research',
        'moltbot-dev',
        'moltbot-daily',
        'moltbot-anki',
    ];
    const seen = new Set();
    for (const raw of candidates) {
        const name = String(raw || '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const inspected = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', name], {
            encoding: 'utf8',
            timeout: 5000,
        });
        if (inspected.error || inspected.status !== 0) continue;
        if (String(inspected.stdout || '').trim() === 'true') return name;
    }
    return '';
}

function resolveOpenClawCliBackend() {
    const localRoot = resolveOpenClawCliRoot();
    if (localRoot) {
        return {
            mode: 'local',
            rootDir: localRoot,
        };
    }
    const dockerContainer = resolveOpenClawDockerContainer();
    if (dockerContainer) {
        return {
            mode: 'docker',
            container: dockerContainer,
        };
    }
    return null;
}

function runOpenClawCli(args, options = {}) {
    const backend = (options && options.cliBackend && typeof options.cliBackend === 'object')
        ? options.cliBackend
        : resolveOpenClawCliBackend();
    if (!backend) {
        throw new Error('openclaw_cli_missing');
    }
    const timeoutMs = Math.max(10000, Number(options.timeoutMs || DEFAULT_MODEL_WRITER_TIMEOUT_MS));
    let res;
    if (backend.mode === 'docker') {
        const container = String(backend.container || '').trim();
        if (!container) throw new Error('openclaw_cli_missing');
        res = spawnSync('docker', ['exec', container, 'node', '/app/dist/index.js', ...args], {
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 40 * 1024 * 1024,
        });
    } else {
        const rootDir = String(backend.rootDir || '').trim();
        if (!rootDir) throw new Error('openclaw_cli_missing');
        res = spawnSync('node', ['dist/index.js', ...args], {
            cwd: rootDir,
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 40 * 1024 * 1024,
        });
    }

    if (res.error) {
        throw new Error(`openclaw cli error: ${String(res.error.message || res.error)}`);
    }
    if (res.status !== 0) {
        const stderr = String(res.stderr || '').trim();
        const stdout = String(res.stdout || '').trim();
        throw new Error(`openclaw cli failed: ${stderr || stdout || `exit:${res.status}`}`);
    }
    return String(res.stdout || '');
}

function parseJsonFromStdout(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        // fall through
    }
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
            return JSON.parse(lines[i]);
        } catch (_) {
            // keep scanning
        }
    }
    return null;
}

function extractAgentTextFromJson(doc) {
    const payloads = (((doc || {}).result || {}).payloads || []);
    if (Array.isArray(payloads)) {
        for (const row of payloads) {
            const text = String((row && row.text) || '').trim();
            if (text) return text;
        }
    }
    const fallback = String((((doc || {}).result || {}).text) || '').trim();
    if (fallback) return fallback;
    return '';
}

function extractAgentModelFromJson(doc) {
    return String(((((doc || {}).result || {}).meta || {}).agentMeta || {}).model || '').trim();
}

function extractJsonObjectLoose(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) throw new Error('empty_text');
    try {
        return JSON.parse(raw);
    } catch (_) {
        // fall through
    }
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
        return JSON.parse(String(fenced[1] || '').trim());
    }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('json_not_found');
}

function normalizeModelDigestText(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) return '';
    try {
        const parsed = extractJsonObjectLoose(raw);
        const digest = String((parsed && parsed.digest) || '').trim();
        if (digest) return digest;
        const nestedPayloadText = String(
            (parsed && parsed.payloads && parsed.payloads[0] && parsed.payloads[0].text)
            || (parsed && parsed.result && parsed.result.payloads && parsed.result.payloads[0] && parsed.result.payloads[0].text)
            || (parsed && parsed.output_text)
            || '',
        ).trim();
        if (nestedPayloadText) {
            return normalizeModelDigestText(nestedPayloadText);
        }
    } catch (_) {
        // keep plain-text path
    }
    return raw
        .replace(/^```(?:json|markdown|md|text)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

function listCodexModelsViaCli(timeoutMs, cliBackend = null) {
    const out = runOpenClawCli(
        ['models', 'list', '--all', '--provider', 'openai-codex', '--plain'],
        { timeoutMs, cliBackend },
    );
    return out
        .split('\n')
        .map((line) => String(line || '').trim())
        .filter(Boolean);
}

function parseProviderFromModelRef(modelRef) {
    const raw = String(modelRef || '').trim();
    if (!raw.includes('/')) return '';
    return raw.split('/')[0].trim().toLowerCase();
}

function listProviderModelsViaCli(provider, timeoutMs, cliBackend = null) {
    const safeProvider = String(provider || '').trim();
    if (!safeProvider) return [];
    const out = runOpenClawCli(
        ['models', 'list', '--all', '--provider', safeProvider, '--plain'],
        { timeoutMs, cliBackend },
    );
    return out
        .split('\n')
        .map((line) => String(line || '').trim())
        .filter(Boolean);
}

function getDefaultModelViaCli(timeoutMs, cliBackend = null) {
    return runOpenClawCli(['models', 'status', '--plain'], { timeoutMs, cliBackend }).trim();
}

function setDefaultModelViaCli(model, timeoutMs, cliBackend = null) {
    const next = String(model || '').trim();
    if (!next) return;
    runOpenClawCli(['models', 'set', next], { timeoutMs, cliBackend });
}

function buildDigestWriterPrompt(input = {}) {
    const digestAt = String(input.digestAt || '').trim();
    const context = {
        digestAt,
        topTrends: Array.isArray(input.topTrends) ? input.topTrends : [],
        repeatedKeywords: Array.isArray(input.repeatedKeywords) ? input.repeatedKeywords : [],
        personalizedKeywords: Array.isArray(input.personalizedKeywords) ? input.personalizedKeywords : [],
        interestKeywords: Array.isArray(input.interestKeywords) ? input.interestKeywords : [],
        previousDigestKeywords: Array.isArray(input.previousDigestKeywords) ? input.previousDigestKeywords : [],
        recentSamples: Array.isArray(input.recentSamples) ? input.recentSamples : [],
        templateDraft: String(input.templateDraft || '').trim(),
    };
    return [
        '너는 테크 트렌드 리포트 편집자다.',
        '아래 입력을 근거로 텔레그램용 한국어 리포트를 작성한다.',
        '출력 규칙:',
        '- JSON만 출력: {"digest":"..."}',
        `- digest 첫 줄은 정확히 "📰 테크 트렌드 칼럼 (${digestAt})"`,
        '- 같은 내용 반복 금지. 이전 리포트와 겹치는 키워드는 1~2문장 업데이트로 짧게 처리.',
        '- 문장은 쉬운 한국어로 작성. 과한 밈, 이모지 남발, 사용자 호칭, 메타 발언 금지.',
        '- 관심사 맞춤 섹션은 유지하되 웹 시그널 기반으로 짧고 명확하게 쓴다.',
        '- 코드블록/표/추가 설명 없이 JSON만 출력.',
        '',
        '입력 데이터(JSON):',
        JSON.stringify(context),
    ].join('\n');
}

async function generateDigestTextWithModel(input = {}) {
    const config = input.config || {};
    const digestPolicy = (config && config.digestPolicy) || {};
    if (digestPolicy.modelWriterEnabled === false || String(process.env.NEWS_DIGEST_MODEL_WRITE || '1') === '0') {
        return { ok: false, mode: 'disabled', reason: 'model_writer_disabled' };
    }

    const cliBackend = resolveOpenClawCliBackend();
    if (!cliBackend) {
        return { ok: false, mode: 'fallback', reason: 'openclaw_cli_missing' };
    }

    const stage = normalizeDigestModelStages(digestPolicy.modelStages).write;
    const timeoutMs = Math.max(10000, Number(digestPolicy.modelWriterTimeoutMs || DEFAULT_MODEL_WRITER_TIMEOUT_MS));
    const thinking = normalizeReasoningLevel(stage.reasoning, 'medium');
    const lockFd = acquireModelSwitchLock(timeoutMs + 60000);

    let originalModel = '';
    let switched = false;
    try {
        const provider = parseProviderFromModelRef(stage.model) || 'openai';
        const available = listProviderModelsViaCli(provider, Math.min(timeoutMs, 45000), cliBackend);
        if (available.length > 0 && !available.includes(stage.model)) {
            return {
                ok: false,
                mode: 'fallback',
                reason: `model_not_available:${stage.model}`,
                availableModels: available,
            };
        }

        originalModel = getDefaultModelViaCli(Math.min(timeoutMs, 30000), cliBackend);
        if (stage.model && originalModel && originalModel !== stage.model) {
            setDefaultModelViaCli(stage.model, Math.min(timeoutMs, 30000), cliBackend);
            switched = true;
        }

        const sessionId = `news-digest-writer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const prompt = buildDigestWriterPrompt(input.promptInput || {});
        const startedAt = Date.now();
        const out = runOpenClawCli([
            'agent',
            '--session-id',
            sessionId,
            '--message',
            prompt,
            '--thinking',
            thinking,
            '--json',
        ], { timeoutMs, cliBackend });
        const elapsedMs = Date.now() - startedAt;
        const parsed = parseJsonFromStdout(out);
        const modelText = extractAgentTextFromJson(parsed) || String(out || '').trim();
        const digestText = normalizeModelDigestText(modelText);
        if (!digestText) {
            return {
                ok: false,
                mode: 'fallback',
                reason: 'empty_model_output',
                sessionId,
                elapsedMs,
            };
        }

        return {
            ok: true,
            mode: 'llm',
            text: digestText,
            sessionId,
            elapsedMs,
            model: firstNonEmpty(extractAgentModelFromJson(parsed), stage.model),
            alias: stage.alias,
            reasoning: thinking,
            backend: cliBackend.mode === 'docker'
                ? `docker:${cliBackend.container || ''}`
                : `local:${cliBackend.rootDir || ''}`,
        };
    } catch (error) {
        return {
            ok: false,
            mode: 'fallback',
            reason: String(error && error.message ? error.message : error),
            backend: cliBackend.mode === 'docker'
                ? `docker:${cliBackend.container || ''}`
                : `local:${cliBackend.rootDir || ''}`,
        };
    } finally {
        try {
            if (switched && originalModel) {
                setDefaultModelViaCli(originalModel, 30000, cliBackend);
            }
        } catch (_) {
            // no-op: restore failures should not crash digest generation.
        } finally {
            releaseModelSwitchLock(lockFd);
        }
    }
}

function formatPercent(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0.0';
    return (n * 100).toFixed(1);
}

function formatMentionDeltaPercent(currentTrend, previousTrend) {
    const current = Number(currentTrend && currentTrend.mention_count || 0);
    const previous = Number(previousTrend && previousTrend.mention_count || 0);
    if (!Number.isFinite(current) || current <= 0) return '변화 데이터 부족';
    if (!Number.isFinite(previous) || previous <= 0) return '신규 급부상';
    const pct = ((current - previous) / previous) * 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
}

function pickRepresentativeItemForTrend(recentItems, keyword) {
    const key = normalizeKeyword(keyword || '');
    const items = Array.isArray(recentItems) ? recentItems : [];
    if (!key || !items.length) return null;
    const lower = key.toLowerCase();
    return items.find((item) => String(item && item.title || '').toLowerCase().includes(lower)) || null;
}

function formatTrendLine(trend, index = 0, context = {}) {
    const levelText = trend.level === 'high'
        ? '지금 강하게 뜨는 중 🔥'
        : trend.level === 'medium'
            ? '관심이 빠르게 모이는 중 ⬆️'
            : '초기 반응 단계 👀';
    const rank = Number(index) + 1;
    const previousByKeyword = context.previousByKeyword || new Map();
    const previousTrend = previousByKeyword.get(normalizeKeyword(trend && trend.keyword ? trend.keyword : '')) || null;
    const deltaText = formatMentionDeltaPercent(trend, previousTrend);
    const mention = Number(trend && trend.mention_count || 0);
    const velocity = Number(trend && trend.velocity || 0).toFixed(2);
    const score = Number(trend && trend.trend_score || 0).toFixed(2);
    const repItem = pickRepresentativeItemForTrend(context.recentItems, trend && trend.keyword);
    const reasonText = trend && trend.reason_text ? String(trend.reason_text).trim() : '';

    const whyLine = reasonText
        ? `   왜 뜸: ${reasonText}`
        : `   왜 뜸: 최근 언급 ${mention}건이고, 확산 속도 ${velocity}로 빠른 편. 직전 대비 ${deltaText}, 종합 점수 ${score}`;
    const issueLine = repItem
        ? `   대표 이슈: ${repItem.title}`
        : '   대표 이슈: 연관 기사 제목은 아직 부족함';

    return `${rank}) ${trend.keyword} — ${levelText}\n${whyLine}\n${issueLine}`;
}

function buildVibeSummary(topTrends) {
    if (!topTrends.length) return '오늘은 큰 변화가 적은 편입니다. 무리하게 따라가기보다 정리하기 좋은 날입니다.';
    const names = topTrends.slice(0, 2).map((row) => row.keyword).filter(Boolean);
    if (names.length === 0) return '이슈가 넓게 퍼져서 단일 핵심 주제는 약한 편입니다.';
    if (names.length === 1) return `오늘은 ${names[0]} 주제가 가장 강하게 보입니다.`;
    return `오늘은 ${names.join(' + ')} 흐름이 핵심입니다.`;
}

function pickUniqueTrendsByKeyword(trends, limit = 5) {
    const list = Array.isArray(trends) ? trends : [];
    const picked = [];
    const seen = new Set();
    for (const row of list) {
        const key = normalizeKeyword(row && row.keyword ? row.keyword : '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        picked.push(row);
        if (picked.length >= limit) break;
    }
    return picked;
}

function compareTrendsForDigest(a, b) {
    const scoreA = Number(a && a.trend_score || 0);
    const scoreB = Number(b && b.trend_score || 0);
    if (scoreA !== scoreB) return scoreB - scoreA;

    const mentionsA = Number(a && a.mention_count || 0);
    const mentionsB = Number(b && b.mention_count || 0);
    if (mentionsA !== mentionsB) return mentionsB - mentionsA;

    const velocityA = Number(a && a.velocity || 0);
    const velocityB = Number(b && b.velocity || 0);
    if (velocityA !== velocityB) return velocityB - velocityA;

    const createdA = Date.parse((a && (a.created_at || a.window_end || a.window_start)) || '') || 0;
    const createdB = Date.parse((b && (b.created_at || b.window_end || b.window_start)) || '') || 0;
    return createdB - createdA;
}

function pickRankedTrendsForDigest(trends, limit = 5) {
    const map = new Map();
    for (const row of Array.isArray(trends) ? trends : []) {
        const key = normalizeKeyword(row && row.keyword ? row.keyword : '');
        if (!key) continue;
        const prev = map.get(key);
        if (!prev || compareTrendsForDigest(row, prev) < 0) {
            map.set(key, row);
        }
    }
    return Array.from(map.values())
        .sort(compareTrendsForDigest)
        .slice(0, Math.max(1, Number(limit || 5)));
}

function digestNarrative(keyword) {
    const k = normalizeKeyword(keyword);
    if (k === 'ai' || k === 'llm') {
        return '단순 기능 소개보다 실제 업무에 바로 적용하는 사례가 늘고 있습니다.';
    }
    if (k === 'agent') {
        return '여러 단계를 자동으로 연결해 처리하는 활용 방식이 계속 늘고 있습니다.';
    }
    if (k === 'open source') {
        return '비용과 의존성 부담 때문에 오픈소스 생태계를 다시 활용하려는 흐름이 강합니다.';
    }
    if (k.includes('claude')) {
        return '성능 비교보다 실제 운영에서 안정적으로 쓰는 방법에 관심이 모이고 있습니다.';
    }
    if (k.includes('gpt') || k.includes('openai')) {
        return '모델 자체보다 워크플로우에 잘 통합해 반복 작업을 줄이는 사례가 주목받고 있습니다.';
    }
    if (k.includes('python')) {
        return '데이터 처리와 자동화 수요가 꾸준해, 작은 스크립트부터 도입하기 좋은 주제입니다.';
    }
    if (k.includes('typescript')) {
        return '웹 서비스에 AI 기능이 늘면서, 안정성을 위한 타입 기반 개발 수요가 함께 늘고 있습니다.';
    }
    return '실무에 연결하기 쉬운 주제라, 작은 단위로 빠르게 실험해보기 좋습니다.';
}

function hashSeed(text = '') {
    let hash = 2166136261;
    const raw = String(text || '');
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function pickBySeed(candidates, seed, offset = 0) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!list.length) return '';
    const idx = Math.abs(Number(seed || 0) + Number(offset || 0)) % list.length;
    return String(list[idx] || '');
}

function trimTitle(value, max = 68) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}

function extractCommunityHint(reasonText = '') {
    const raw = String(reasonText || '').trim();
    if (!raw) return '';
    const match = raw.match(/주요 커뮤니티:\s*(.+)$/);
    if (!match) return '';
    return String(match[1] || '').trim();
}

function parseJsonArraySafe(value) {
    if (Array.isArray(value)) return value;
    const raw = String(value || '').trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function extractPrimaryRefTitle(trend) {
    const refs = parseJsonArraySafe(trend && trend.top_refs_json);
    const row = refs.find((item) => item && item.title);
    return trimTitle(row && row.title, 70);
}

function formatDelta(current, previous, digits = 2) {
    const now = Number(current);
    const prev = Number(previous);
    if (!Number.isFinite(now) || !Number.isFinite(prev)) return 'n/a';
    const delta = now - prev;
    const fixed = digits === 0 ? Math.round(Math.abs(delta)).toString() : Math.abs(delta).toFixed(digits);
    if (Number(fixed) === 0) return '0';
    return `${delta > 0 ? '+' : '-'}${fixed}`;
}

function buildTrendMapFromState(previousDigest) {
    const raw = previousDigest && typeof previousDigest.last_digest_trends === 'object'
        ? previousDigest.last_digest_trends
        : {};
    const map = new Map();
    for (const [key, row] of Object.entries(raw || {})) {
        const normalized = normalizeKeyword(key);
        if (!normalized || !row || typeof row !== 'object') continue;
        map.set(normalized, row);
    }
    return map;
}

function buildRepeatedTrendSentence(trend, previousTrend, index, baseSeed) {
    const keyword = String((trend && trend.keyword) || '').trim() || '이 키워드';
    const mentions = Number(trend && trend.mention_count || 0);
    const velocity = Number(trend && trend.velocity || 0);
    const score = Number(trend && trend.trend_score || 0);
    const mentionDelta = formatDelta(mentions, Number(previousTrend && previousTrend.mention_count || 0), 0);
    const velocityDelta = formatDelta(velocity, Number(previousTrend && previousTrend.velocity || 0), 2);
    const scoreDelta = formatDelta(score, Number(previousTrend && previousTrend.trend_score || 0), 2);
    const currentRef = extractPrimaryRefTitle(trend);
    const previousRef = extractPrimaryRefTitle(previousTrend);
    const refLine = currentRef && currentRef !== previousRef
        ? ` 새 샘플은 "${currentRef}".`
        : '';

    const lead = pickBySeed([
        `${keyword}: 이전 리포트랑 같은 축이라 긴 설명은 생략.`,
        `${keyword}: 전회와 결이 비슷해서 핵심 변화만 짧게.`,
        `${keyword}: 중복 주제라 장문 반복 없이 업데이트만.`,
    ], baseSeed, index * 29 + keyword.length);

    return `${lead} 언급 ${mentions}건(Δ${mentionDelta}) · 속도 ${velocity.toFixed(2)}(Δ${velocityDelta}) · 점수 ${score.toFixed(2)}(Δ${scoreDelta}).${refLine}`;
}

function collectConfigInterestKeywords(config) {
    const fromPolicy = (config && config.digestPolicy && Array.isArray(config.digestPolicy.preferenceKeywords))
        ? config.digestPolicy.preferenceKeywords
        : [];
    const fromConfig = Array.isArray(config && config.keywords)
        ? config.keywords.map((kw) => normalizeKeyword(kw)).filter(Boolean)
        : [];
    const configSet = new Set(fromConfig);
    const preferredOrder = [
        'openclaw',
        'codex',
        'agent',
        'automation',
        'ai',
        'llm',
        'open source',
        'python',
        'typescript',
        'developer tools',
        'claude',
        'chatgpt',
        'openai',
        'mcp',
        'docker',
        'telegram',
        'finance',
        'anki',
        'prompt',
    ];

    const picked = [];
    for (const kw of fromPolicy) {
        const normalized = normalizeKeyword(kw);
        if (normalized && !picked.includes(normalized)) picked.push(normalized);
    }
    for (const kw of preferredOrder) {
        if (configSet.has(kw) && !picked.includes(kw)) picked.push(kw);
    }
    for (const kw of fromConfig) {
        if (picked.length >= 24) break;
        if (!picked.includes(kw)) picked.push(kw);
    }
    return picked;
}

const WEB_SIGNAL_TITLE_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'over', 'under', 'after', 'before',
    'your', 'our', 'their', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'how', 'why', 'what', 'when', 'where', 'who', 'which',
    'new', 'latest', 'today', 'week', 'daily', 'live', 'top', 'best', 'more', 'most',
    'about', 'using', 'build', 'built', 'guide', 'tips', 'news', 'update', 'updates',
]);

function collectWebSignalKeywordsFromRecentItems(recentItems = [], limit = 12) {
    const weighted = new Map();
    const list = Array.isArray(recentItems) ? recentItems : [];
    for (let i = 0; i < list.length; i += 1) {
        const item = list[i] || {};
        const weight = Math.max(1, 8 - i);
        const title = String(item.title || '').toLowerCase();
        if (!title) continue;
        const tokens = title.match(/[a-z0-9][a-z0-9+.#-]{1,30}/g) || [];
        for (const tokenRaw of tokens) {
            const token = normalizeKeyword(tokenRaw);
            if (!token) continue;
            if (/^\d+$/.test(token)) continue;
            if (WEB_SIGNAL_TITLE_STOPWORDS.has(token)) continue;
            if (token.length <= 2 && token !== 'ai' && token !== 'ml') continue;
            weighted.set(token, Number(weighted.get(token) || 0) + weight);
        }
    }
    return Array.from(weighted.entries())
        .sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return a[0].localeCompare(b[0]);
        })
        .slice(0, Math.max(1, Number(limit || 12)))
        .map((row) => row[0]);
}

function collectWebSignalKeywords(trends, recentItems) {
    const fromTrends = pickRankedTrendsForDigest(trends, 12)
        .map((row) => normalizeKeyword(row && row.keyword))
        .filter(Boolean);
    const fromRecentTitles = collectWebSignalKeywordsFromRecentItems(recentItems, 16);
    const picked = [];
    for (const keyword of fromTrends) {
        if (!picked.includes(keyword)) picked.push(keyword);
    }
    for (const keyword of fromRecentTitles) {
        if (picked.length >= 24) break;
        if (!picked.includes(keyword)) picked.push(keyword);
    }
    return picked;
}

function buildInterestKeywords(input = {}) {
    const config = input && input.config ? input.config : {};
    const trends = Array.isArray(input && input.trends) ? input.trends : [];
    const recentItems = Array.isArray(input && input.recentItems) ? input.recentItems : [];
    const source = String(config && config.digestPolicy && config.digestPolicy.personalizationSource || 'web')
        .trim()
        .toLowerCase();

    const webKeywords = collectWebSignalKeywords(trends, recentItems);
    if (source === 'config') return collectConfigInterestKeywords(config);
    if (source === 'hybrid') {
        const configKeywords = collectConfigInterestKeywords(config);
        const combined = [];
        for (const keyword of webKeywords) {
            if (!combined.includes(keyword)) combined.push(keyword);
        }
        for (const keyword of configKeywords) {
            if (combined.length >= 24) break;
            if (!combined.includes(keyword)) combined.push(keyword);
        }
        return combined;
    }
    return webKeywords;
}

function keywordMatchesInterest(keyword, interestKeywords) {
    const k = normalizeKeyword(keyword);
    if (!k) return false;
    const list = Array.isArray(interestKeywords) ? interestKeywords : [];
    for (const raw of list) {
        const interest = normalizeKeyword(raw);
        if (!interest) continue;
        if (k === interest) return true;
        if (interest.length <= 2 || k.length <= 2) continue;
        if (k.includes(interest) || interest.includes(k)) return true;
    }
    return false;
}

function pickPersonalizedTrends(trends, interestKeywords, excludedKeywords = [], limit = 2) {
    const excluded = new Set((Array.isArray(excludedKeywords) ? excludedKeywords : []).map((kw) => normalizeKeyword(kw)).filter(Boolean));
    const ranked = pickRankedTrendsForDigest(trends, 12);
    const picked = [];
    for (const trend of ranked) {
        const keyword = normalizeKeyword(trend && trend.keyword);
        if (!keyword || excluded.has(keyword)) continue;
        if (!keywordMatchesInterest(keyword, interestKeywords)) continue;
        picked.push(trend);
        if (picked.length >= Math.max(1, Number(limit || 2))) break;
    }
    return picked;
}

function buildPersonalizedTrendSentence(trend, index, baseSeed) {
    const keyword = String((trend && trend.keyword) || '').trim() || '이 키워드';
    const mentions = Number(trend && trend.mention_count || 0);
    const score = Number(trend && trend.trend_score || 0);
    const lead = pickBySeed([
        `${keyword}: 웹 커뮤니티 반응이 강해서 우선 체크 추천.`,
        `${keyword}: 최근 기사/토론 신호가 올라와서 우선순위 상.`,
        `${keyword}: 실사용 언급이 늘어 지금 타이밍에 보기 좋음.`,
    ], baseSeed, index * 31 + keyword.length);
    return `${lead} 지표는 언급 ${mentions}건 · 점수 ${score.toFixed(2)}.`;
}

function buildDigestStateTrends(topTrends) {
    const state = {};
    for (const trend of Array.isArray(topTrends) ? topTrends : []) {
        const keyword = normalizeKeyword(trend && trend.keyword);
        if (!keyword) continue;
        state[keyword] = {
            keyword: String(trend.keyword || keyword),
            mention_count: Number(trend.mention_count || 0),
            velocity: Number(trend.velocity || 0),
            trend_score: Number(trend.trend_score || 0),
            level: String(trend.level || 'low'),
            window_start: trend.window_start || null,
            window_end: trend.window_end || null,
            created_at: trend.created_at || null,
            top_refs_json: parseJsonArraySafe(trend.top_refs_json).slice(0, 3),
        };
    }
    return state;
}

function pickTrendReferenceTitle(trend, baseSeed, index) {
    const refs = parseJsonArraySafe(trend && trend.top_refs_json);
    if (!refs.length) return '';
    const row = refs[Math.abs(baseSeed + (index * 19)) % refs.length] || refs[0];
    return trimTitle(row && row.title, 70);
}

function buildTrendColumnSentence(trend, index, baseSeed) {
    const keyword = String((trend && trend.keyword) || '').trim() || '이 키워드';
    const mentions = Number(trend && trend.mention_count || 0);
    const velocity = Number(trend && trend.velocity || 0);
    const score = Number(trend && trend.trend_score || 0);
    const level = String(trend && trend.level || 'low').toLowerCase();
    const communityHint = extractCommunityHint(trend && trend.reason_text);
    const narrative = digestNarrative(keyword);

    const mood = level === 'high'
        ? '관심도 높음'
        : level === 'medium'
            ? '관심도 보통'
            : '관심도 낮음';

    const lead = pickBySeed([
        `${keyword} 관련 논의가 계속 늘고 있습니다.`,
        `${keyword}는 최근 실사용 사례가 자주 공유되는 주제입니다.`,
        `${keyword}는 지금 확인해볼 가치가 있는 흐름입니다.`,
        `${keyword}는 단순 소개보다 실제 적용 관점에서 많이 다뤄지고 있습니다.`,
        `${keyword}는 업무 적용 가능성을 중심으로 관심이 모이는 주제입니다.`,
        `${keyword}는 반복적으로 언급되며 관심이 유지되는 흐름입니다.`,
    ], baseSeed, index * 11 + keyword.length);

    const metric = pickBySeed([
        `지표는 언급 ${mentions}건, 속도 ${velocity.toFixed(2)}배, 점수 ${score.toFixed(2)}로 ${mood} 상태입니다.`,
        `데이터 기준으로 언급 ${mentions}건, 속도 ${velocity.toFixed(2)}배, 점수 ${score.toFixed(2)}가 관측되었습니다.`,
        `현재 수치는 언급 ${mentions}건, 증가 속도 ${velocity.toFixed(2)}배, 트렌드 점수 ${score.toFixed(2)}입니다.`,
        `요약 수치는 언급 ${mentions}건 / 속도 ${velocity.toFixed(2)} / 점수 ${score.toFixed(2)}입니다.`,
    ], baseSeed, index * 13 + mentions);

    const pivot = pickBySeed([
        '핵심 포인트는 다음과 같습니다.',
        '요점은 실제 적용 가능성입니다.',
        '공통적으로 확인되는 흐름은 다음과 같습니다.',
        '결론적으로 실행 가능성이 중요합니다.',
    ], baseSeed, index * 7 + score);

    const referenceTitle = pickTrendReferenceTitle(trend, baseSeed, index);
    const reference = referenceTitle
        ? pickBySeed([
            `참고 사례로 "${referenceTitle}" 글이 자주 인용됩니다.`,
            `"${referenceTitle}" 같은 글이 공유되며 논의가 이어지고 있습니다.`,
            `최근 예시로 "${referenceTitle}" 사례를 확인할 수 있습니다.`,
        ], baseSeed, index * 23 + referenceTitle.length)
        : '';

    const community = communityHint
        ? pickBySeed([
            `반응은 ${communityHint} 커뮤니티에서 특히 두드러집니다.`,
            `${communityHint} 쪽에서 먼저 확산되는 패턴이 보입니다.`,
            `현재는 ${communityHint} 커뮤니티가 흐름을 주도하고 있습니다.`,
        ], baseSeed, index * 17 + communityHint.length)
        : '';

    return [lead, metric, pivot, narrative, reference, community].filter(Boolean).join(' ');
}

function buildRecentItemColumnSentence(recentItems, baseSeed) {
    const list = Array.isArray(recentItems) ? recentItems.filter(Boolean) : [];
    if (!list.length) return '';
    const pick = list[Math.abs(baseSeed) % list.length] || list[0];
    const title = trimTitle(pick && pick.title, 72);
    if (!title) return '';
    const community = String(pick && pick.community || pick && pick.source || '').trim();
    const lead = pickBySeed([
        '오늘 흐름은 아래 사례에서 잘 보입니다.',
        '최근 분위기를 보여주는 대표 글은 다음과 같습니다.',
        '실시간 반응을 확인하기 좋은 사례입니다.',
        '빠르게 맥락을 파악하려면 이 글을 먼저 보면 됩니다.',
    ], baseSeed, 97);
    return community
        ? `${lead} "${title}" (${community}).`
        : `${lead} "${title}".`;
}

function buildDigestClosing(topTrends, baseSeed) {
    const keys = topTrends.slice(0, 2).map((row) => String(row.keyword || '').trim()).filter(Boolean);
    const core = keys.join(' + ');
    const fallback = core || '지금 올라오는 키워드';
    const line = pickBySeed([
        `정리하면 ${fallback} 흐름은 작은 실험을 빠르게 해보는 전략이 효과적입니다.`,
        `한 줄 요약: ${fallback} 주제는 실제 적용 사례를 중심으로 검토하면 실패를 줄일 수 있습니다.`,
        `핵심은 ${fallback} 관련 아이디어를 바로 작은 단위로 검증해보는 것입니다.`,
        `마무리하면 ${fallback} 흐름은 정보 수집보다 실행 중심 접근이 더 유리합니다.`,
    ], baseSeed, 211);
    return line;
}

function requestTelegramSend(token, chatId, message) {
    const body = JSON.stringify({
        chat_id: chatId,
        text: String(message || ''),
        disable_web_page_preview: true,
    });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 8000,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                resolve({
                    ok,
                    statusCode: res.statusCode || 0,
                    body: raw,
                });
            });
        });
        req.on('error', (error) => {
            resolve({
                ok: false,
                statusCode: 0,
                error: String(error && error.message ? error.message : error),
                body: '',
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('telegram request timeout'));
        });
        req.write(body);
        req.end();
    });
}

async function trySendTelegramDirect(message) {
    const enabled = String(process.env.NEWS_DIRECT_TELEGRAM || '1') !== '0';
    if (!enabled) {
        return {
            sent: false,
            reason: 'disabled',
            statusCode: 0,
            target: 'none',
        };
    }
    loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: false });
    const target = String(process.env.NEWS_TELEGRAM_TARGET || 'research').trim().toLowerCase();
    const aliases = {
        development: 'dev',
        main: 'dev',
        sub1: 'anki',
        trend: 'research',
        researcher: 'research',
        main_bak: 'dev_bak',
        sub1_bak: 'anki_bak',
        live: 'dev',
    };
    const normalizedTarget = aliases[target] || target;
    const profileEnv = {
        dev: {
            tokenKeys: ['TELEGRAM_BOT_TOKEN_DEV', 'TELEGRAM_BOT_TOKEN'],
            userKeys: ['TELEGRAM_USER_ID_DEV', 'TELEGRAM_USER_ID'],
        },
        anki: {
            tokenKeys: ['TELEGRAM_BOT_TOKEN_ANKI', 'TELEGRAM_BOT_TOKEN_SUB1'],
            userKeys: ['TELEGRAM_USER_ID_ANKI', 'TELEGRAM_USER_ID_SUB1', 'TELEGRAM_USER_ID'],
        },
        research: {
            tokenKeys: ['TELEGRAM_BOT_TOKEN_TREND', 'TELEGRAM_BOT_TOKEN_RESEARCH'],
            userKeys: ['TELEGRAM_USER_ID_TREND', 'TELEGRAM_USER_ID_RESEARCH', 'TELEGRAM_USER_ID'],
        },
        daily: {
            tokenKeys: ['TELEGRAM_BOT_TOKEN_DAILY'],
            userKeys: ['TELEGRAM_USER_ID_DAILY', 'TELEGRAM_USER_ID'],
        },
        dev_bak: {
            tokenKeys: ['TELEGRAM_BOT_TOKEN_DEV_BAK', 'TELEGRAM_BOT_TOKEN_MAIN_BAK'],
            userKeys: ['TELEGRAM_USER_ID_DEV_BAK', 'TELEGRAM_USER_ID_MAIN_BAK', 'TELEGRAM_USER_ID'],
        },
        anki_bak: {
            tokenKeys: ['TELEGRAM_BOT_TOKEN_ANKI_BAK', 'TELEGRAM_BOT_TOKEN_SUB1_BAK'],
            userKeys: ['TELEGRAM_USER_ID_ANKI_BAK', 'TELEGRAM_USER_ID_SUB1_BAK', 'TELEGRAM_USER_ID_SUB1', 'TELEGRAM_USER_ID'],
        },
        research_bak: {
            tokenKeys: ['TELEGRAM_BOT_TOKEN_TREND_BAK', 'TELEGRAM_BOT_TOKEN_RESEARCH_BAK'],
            userKeys: ['TELEGRAM_USER_ID_TREND_BAK', 'TELEGRAM_USER_ID_RESEARCH_BAK', 'TELEGRAM_USER_ID_RESEARCH', 'TELEGRAM_USER_ID'],
        },
        daily_bak: {
            tokenKeys: ['TELEGRAM_BOT_TOKEN_DAILY_BAK'],
            userKeys: ['TELEGRAM_USER_ID_DAILY_BAK', 'TELEGRAM_USER_ID_DAILY', 'TELEGRAM_USER_ID'],
        },
    };
    const selected = profileEnv[normalizedTarget] || profileEnv.research;
    const token = firstNonEmpty(...selected.tokenKeys.map((key) => process.env[key]));
    const chatId = firstNonEmpty(...selected.userKeys.map((key) => process.env[key]));
    const tokenKey = selected.tokenKeys.find((key) => String(process.env[key] || '').trim()) || selected.tokenKeys[0];
    const userKey = selected.userKeys.find((key) => String(process.env[key] || '').trim()) || selected.userKeys[0];
    if (!token || !chatId) {
        return {
            sent: false,
            reason: `missing_credentials:${tokenKey || 'token'}:${userKey || 'user'}`,
            statusCode: 0,
            target: normalizedTarget,
        };
    }
    const res = await requestTelegramSend(token, chatId, message);
    return {
        sent: Boolean(res.ok),
        reason: res.ok ? 'sent' : (res.error || 'http_error'),
        statusCode: Number(res.statusCode || 0),
        target: normalizedTarget,
    };
}

async function queueTelegramMessage(message) {
    const allowQueueFallback = String(process.env.NEWS_QUEUE_FALLBACK || '0') === '1';
    let direct = {
        sent: false,
        reason: 'not_attempted',
        statusCode: 0,
        target: 'none',
    };
    try {
        direct = await trySendTelegramDirect(message);
    } catch (error) {
        direct = {
            sent: false,
            reason: String(error && error.message ? error.message : error),
            statusCode: 0,
            target: 'none',
        };
    }

    let queued = false;
    if (!direct.sent && allowQueueFallback) {
        try {
            const { enqueueBridgePayload } = require('./bridge_queue');
            const payload = {
                taskId: `news-${Date.now()}`,
                command: `[NOTIFY] ${message}`,
                timestamp: new Date().toISOString(),
                status: 'pending',
            };
            enqueueBridgePayload(payload);
            queued = true;
        } catch (_) {
            queued = false;
        }
    }

    return {
        queued,
        directSent: direct.sent,
        directReason: direct.reason,
        directStatusCode: direct.statusCode,
        target: direct.target,
        queueFallbackEnabled: allowQueueFallback,
    };
}

function loadRecentTrends(dbPath, limit = 10, sinceIso = null) {
    const where = sinceIso ? `WHERE window_end >= ${sqlQuote(sinceIso)}` : '';
    return runSqlJson(
        dbPath,
        `
SELECT id, keyword, window_start, window_end, mention_count, velocity, trend_score, level, reason_text, created_at
FROM news_trends
${where}
ORDER BY id DESC
LIMIT ${Number(limit)};
`
    );
}

function loadRecentItems(dbPath, limit = 5, sinceIso = null) {
    const where = sinceIso ? `WHERE fetched_at >= ${sqlQuote(sinceIso)}` : '';
    return runSqlJson(
        dbPath,
        `
SELECT source, community, title, url, score, comments, created_at
FROM news_items
${where}
ORDER BY fetched_at DESC, id DESC
LIMIT ${Number(limit)};
`
    );
}

function buildDigestPayload(trends, recentItems, generatedAtIso, options = {}) {
    const reportTimezone = normalizeDigestTimezone(options.reportTimezone || DEFAULT_DIGEST_TIMEZONE, DEFAULT_DIGEST_TIMEZONE);
    const digestAt = formatIsoInTimezone(generatedAtIso || nowIso(), reportTimezone, true) || String(generatedAtIso || nowIso()).slice(0, 16).replace('T', ' ');
    const lines = [];
    const topTrends = pickRankedTrendsForDigest(trends, 4);
    const digestPolicy = options.digestPolicy || {};
    const previousTrendMap = buildTrendMapFromState(options.previousDigest || null);
    const repeatedKeywords = topTrends
        .map((row) => normalizeKeyword(row && row.keyword))
        .filter((keyword) => keyword && previousTrendMap.has(keyword));
    const overlapKeywordsMin = Math.max(1, Number(digestPolicy.overlapKeywordsMin || 2));
    const summarizeRepeated = repeatedKeywords.length >= overlapKeywordsMin;
    const maxRepeatFocus = Math.max(1, Number(digestPolicy.maxRepeatFocus || 2));
    const baseSeed = hashSeed(`${generatedAtIso || ''}|${topTrends.map((row) => row.keyword).join('|')}|${Array.isArray(recentItems) ? recentItems.length : 0}`);
    const interestKeywords = Array.isArray(options.interestKeywords) ? options.interestKeywords : [];

    lines.push(`📰 테크 트렌드 칼럼 (${digestAt})`);
    if (!topTrends.length) {
        lines.push(pickBySeed([
            '오늘은 타임라인이 전반적으로 잠잠한 편. 억지로 테마 따라가느니 체력 비축하는 날로 보는 게 맞음.',
            '지금 구간은 대형 떡밥보다 잔파도만 도는 분위기라, 무리해서 쫓아갈 필요는 없음.',
            '오늘은 화끈한 테마가 약해서, 새 이슈 추격보다 기존 시스템 정리 효율이 더 좋음.',
        ], baseSeed, 3));
        lines.push(pickBySeed([
            '이럴 때는 뉴스 소비량 줄이고, 기존 워크플로우 정리나 자동화 리팩터링 한 번 돌리는 게 효율 좋음.',
            '오히려 이런 날이 체크리스트 정리하고 반복 업무 자동화 박기 좋은 타이밍임.',
            '핵심만 보면 오늘은 정보 탐닉보다 손에 잡히는 개선 1개 만드는 쪽이 확실히 남음.',
        ], baseSeed, 5));
        return {
            text: lines.join('\n'),
            meta: {
                topKeywords: [],
                repeatedKeywords: [],
                personalizedKeywords: [],
                topTrendsByKeyword: {},
            },
        };
    }

    lines.push(pickBySeed([
        '오늘 커뮤 분위기 먼저 까보면, 말만 뜨는 키워드보다 실제로 써먹는 얘기가 훨씬 많이 보임.',
        '오늘 판을 한 줄로 보면 “누가 더 빨리 실전에 붙이냐” 싸움으로 넘어가는 타이밍.',
        '오늘 흐름은 단순 화제성보다 실사용/생산성 얘기가 중심에 오는 날.',
        '전체 결부터 보면 밈 소비보다 실행기/자동화/재현 가능한 사용기 쪽으로 무게가 이동 중.',
        '커뮤 반응을 훑어보면 공통점이 있음. 추상 논쟁보다 결과물 인증 글이 더 잘 먹힘.',
    ], baseSeed, 17));
    lines.push(`요약하면 ${buildVibeSummary(topTrends)}`);
    lines.push('');
    if (summarizeRepeated) {
        lines.push(`전 리포트와 겹치는 축(${repeatedKeywords.join(', ')})은 핵심 변화만 짧게 정리함.`);
        lines.push('');
    }

    const focus = topTrends.slice(0, 3);
    let repeatedFocusCount = 0;
    for (let i = 0; i < focus.length; i += 1) {
        const trend = focus[i];
        const keyword = normalizeKeyword(trend && trend.keyword);
        const previousTrend = keyword ? previousTrendMap.get(keyword) : null;
        const useShortRepeat = Boolean(previousTrend) && (!summarizeRepeated || repeatedFocusCount < maxRepeatFocus);
        if (useShortRepeat) {
            lines.push(buildRepeatedTrendSentence(trend, previousTrend, i, baseSeed));
            repeatedFocusCount += 1;
        } else {
            lines.push(buildTrendColumnSentence(trend, i, baseSeed));
        }
        lines.push('');
    }

    const personalizedTrends = (digestPolicy.personalizationEnabled !== false)
        ? pickPersonalizedTrends(trends, interestKeywords, focus.map((row) => row.keyword), digestPolicy.personalizationMaxItems || 2)
        : [];
    if (personalizedTrends.length) {
        lines.push('🎯 관심사 맞춤 (웹 시그널 기반)');
        personalizedTrends.forEach((trend, idx) => {
            lines.push(`- ${buildPersonalizedTrendSentence(trend, idx, baseSeed)}`);
        });
        lines.push('');
    }

    const recentLine = buildRecentItemColumnSentence(recentItems, baseSeed);
    if (recentLine) {
        lines.push(recentLine);
        lines.push('');
    }

    lines.push(buildDigestClosing(topTrends, baseSeed));
    while (lines.length > 0 && !String(lines[lines.length - 1]).trim()) {
        lines.pop();
    }

    return {
        text: lines.join('\n'),
        meta: {
            topKeywords: topTrends.map((row) => normalizeKeyword(row && row.keyword)).filter(Boolean),
            repeatedKeywords: repeatedKeywords.slice(),
            personalizedKeywords: personalizedTrends.map((row) => normalizeKeyword(row && row.keyword)).filter(Boolean),
            topTrendsByKeyword: buildDigestStateTrends(topTrends),
        },
    };
}

function buildDigestText(trends, recentItems, generatedAtIso, options = {}) {
    return buildDigestPayload(trends, recentItems, generatedAtIso, options).text;
}

function loadSourceCountsSince(dbPath, sinceIso) {
    return runSqlJson(
        dbPath,
        `
SELECT source, COUNT(*) AS count
FROM news_items
WHERE fetched_at >= ${sqlQuote(sinceIso)}
GROUP BY source;
`
    ).map((row) => ({
        id: String(row.source || '').trim().toLowerCase(),
        count: Number(row.count || 0),
    }));
}

function buildWriterFallbackAlertMessage(writerExecution, generatedAtIso, reportTimezone, stage) {
    const when = formatIsoInTimezone(generatedAtIso || nowIso(), reportTimezone, true)
        || String(generatedAtIso || nowIso()).slice(0, 16).replace('T', ' ');
    const targetModel = String(stage && stage.model || 'openai/gpt-5.2-pro').trim();
    const targetReasoning = normalizeReasoningLevel(stage && stage.reasoning, 'high');
    const reason = String(writerExecution && writerExecution.reason || 'unknown').trim();
    const backend = String(writerExecution && writerExecution.backend || '').trim();
    const lines = [
        `⚠️ 리포트 작성 fallback 감지 (${when})`,
        `- 목표 설정: ${targetModel} / thinking ${targetReasoning}`,
        `- 원인: ${reason}`,
    ];
    if (backend) lines.push(`- 실행 경로: ${backend}`);
    lines.push('- 이번 리포트 본문은 템플릿 문안으로 대체 전송됨.');
    return lines.join('\n');
}

function buildStatusText(config, dbCounts, sourceRows, trends) {
    const lines = [];
    const latestUniqueTrends = pickUniqueTrendsByKeyword(trends, 3);
    const reportTimezone = normalizeDigestTimezone(
        config && config.digestPolicy ? config.digestPolicy.reportTimezone : DEFAULT_DIGEST_TIMEZONE,
        DEFAULT_DIGEST_TIMEZONE,
    );
    lines.push('🧭 소식 트래커 상태');
    lines.push(`- 모드: ${config.mode}`);
    lines.push(`- 소스: 활성 ${sourceRows.filter((x) => x.enabled).length}/${sourceRows.length}`);
    lines.push(`- 데이터: items ${dbCounts.items}, trends ${dbCounts.trends}, alerts ${dbCounts.alerts}, keywords ${dbCounts.keywords}`);

    if (sourceRows.length) {
        lines.push('');
        lines.push('🛰️ 소스 상태');
        for (const row of sourceRows) {
            const status = row.enabled ? 'on' : 'off';
            const lastRunAt = row.lastRunAt
                ? (formatIsoInTimezone(row.lastRunAt, reportTimezone, true) || row.lastRunAt.slice(0, 16).replace('T', ' '))
                : '-';
            const err = row.lastError ? ` / err:${row.lastError}` : '';
            lines.push(`- ${row.id}: ${status} / lastRun ${lastRunAt}${err}`);
        }
    }

    if (latestUniqueTrends.length) {
        lines.push('');
        lines.push('📈 최신 트렌드');
        lines.push(...latestUniqueTrends.map(formatTrendLine));
    }

    return lines.join('\n');
}

function getDbCounts(dbPath) {
    const rows = runSqlJson(
        dbPath,
        `
SELECT
  (SELECT COUNT(*) FROM news_items) AS items,
  (SELECT COUNT(*) FROM news_trends) AS trends,
  (SELECT COUNT(*) FROM news_alerts) AS alerts,
  (SELECT COUNT(*) FROM news_keywords) AS keywords;
`
    );
    return rows[0] || { items: 0, trends: 0, alerts: 0, keywords: 0 };
}

function getSourceStatusRows(config, state) {
    const sources = Array.isArray(config.sources) ? config.sources : [];
    return sources.map((source) => {
        const id = String(source.id || '').trim();
        const sourceState = (state.sources && state.sources[id]) || {};
        return {
            id,
            enabled: source.enabled !== false,
            lastRunAt: sourceState.lastRunAt || null,
            lastError: sourceState.lastError || null,
        };
    }).filter((row) => row.id);
}

function selectEventCandidates(trends, config) {
    const t = config.eventThresholds;
    return trends
        .filter((row) => Number(row.mention_count) >= t.minMentions)
        .filter((row) => Number(row.velocity) >= t.minVelocity)
        .filter((row) => Number(row.trend_score) >= t.scoreThreshold)
        .sort((a, b) => Number(b.trend_score) - Number(a.trend_score));
}

function hasCooldown(dbPath, keyword, cooldownHours, nowMs = Date.now()) {
    const rows = runSqlJson(
        dbPath,
        `
SELECT sent_at
FROM news_alerts
WHERE keyword = ${sqlQuote(keyword)}
ORDER BY id DESC
LIMIT 1;
`
    );
    if (!rows.length) return false;
    const sentMs = Date.parse(rows[0].sent_at);
    if (!Number.isFinite(sentMs)) return false;
    return nowMs - sentMs < (Number(cooldownHours || 0) * 60 * 60 * 1000);
}

function persistAlert(dbPath, trend) {
    const trendIdRows = runSqlJson(
        dbPath,
        `
SELECT id
FROM news_trends
WHERE keyword = ${sqlQuote(trend.keyword)}
ORDER BY id DESC
LIMIT 1;
`
    );
    const trendId = trendIdRows.length ? Number(trendIdRows[0].id) : null;
    runSql(
        dbPath,
        `
INSERT INTO news_alerts (trend_id, keyword, level, telegram_sent, sent_at, payload_json)
VALUES (
  ${trendId == null ? 'NULL' : trendId},
  ${sqlQuote(trend.keyword)},
  ${sqlQuote(trend.level || 'medium')},
  0,
  ${sqlQuote(nowIso())},
  ${sqlQuote(JSON.stringify(trend))}
);
`
    );
}

async function runPipeline(paths, config, options = {}) {
    const collectFn = options.collectFn || collectNews;
    const trendFn = options.trendFn || runTrendEngine;

    const collectResult = options.skipCollect
        ? { ok: true, skipped: true }
        : await collectFn({
            dbPath: paths.dbPath,
            sourcesPath: paths.sourcesPath,
            statePath: paths.statePath,
            force: Boolean(options.force),
        });

    const trendResult = options.skipTrend
        ? { ok: true, skipped: true, createdCount: 0, trends: [] }
        : await trendFn({
            dbPath: paths.dbPath,
            sourcesPath: paths.sourcesPath,
            windowMinutes: options.windowMinutes || config.thresholds.windowMinutes,
        });

    return { collect: collectResult, trend: trendResult };
}

function parseKeywordCommand(payload, prefix) {
    const body = String(payload || '').trim();
    if (!body.startsWith(prefix)) return '';
    return normalizeKeyword(body.slice(prefix.length).trim());
}

function upsertKeyword(dbPath, keyword, enabled) {
    if (!keyword) return false;
    runSql(
        dbPath,
        `
INSERT INTO news_keywords (keyword, enabled, created_at)
VALUES (${sqlQuote(keyword)}, ${enabled ? 1 : 0}, ${sqlQuote(nowIso())})
ON CONFLICT(keyword) DO UPDATE SET enabled = ${enabled ? 1 : 0};
`
    );
    return true;
}

function toggleSource(paths, sourceId, enabled) {
    const raw = readJsonFile(paths.sourcesPath, {});
    const list = Array.isArray(raw.sources) ? raw.sources : [];
    const hit = list.find((row) => String(row.id || '').trim() === sourceId);
    if (!hit) return false;
    hit.enabled = enabled;
    writeJsonFile(paths.sourcesPath, raw);
    return true;
}

async function buildStatus(paths, config) {
    ensureNewsSchema(paths.dbPath);
    const dbCounts = getDbCounts(paths.dbPath);
    const state = readFetchState(paths.statePath);
    const sourceRows = getSourceStatusRows(config, state);
    const trends = loadRecentTrends(paths.dbPath, 5);
    const telegramReply = buildStatusText(config, dbCounts, sourceRows, trends);

    return {
        success: true,
        action: 'status',
        dbCounts,
        sources: sourceRows,
        latestTrends: trends,
        telegramReply,
    };
}

async function buildDigest(paths, config, options = {}) {
    const pipeline = await runPipeline(paths, config, options);
    const generatedAtIso = nowIso();
    const reportTimezone = normalizeDigestTimezone(
        config && config.digestPolicy ? config.digestPolicy.reportTimezone : DEFAULT_DIGEST_TIMEZONE,
        DEFAULT_DIGEST_TIMEZONE,
    );
    const digestLookbackIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const trends = loadRecentTrends(paths.dbPath, 10, digestLookbackIso);
    const recentItems = loadRecentItems(paths.dbPath, 5, digestLookbackIso);
    const sourceCounts24h = loadSourceCountsSince(paths.dbPath, digestLookbackIso);
    const digestStatePath = getDigestStatePath(paths, options);
    const digestState = readJsonFile(digestStatePath, {});
    const previousDigest = shouldUsePreviousDigest(digestState, config.digestPolicy.similarityLookbackHours)
        ? digestState
        : null;
    const interestKeywords = buildInterestKeywords({
        config,
        trends,
        recentItems,
    });
    const digestPayload = buildDigestPayload(trends, recentItems, generatedAtIso, {
        previousDigest,
        digestPolicy: config.digestPolicy,
        interestKeywords,
        reportTimezone,
    });
    const topTrends = pickRankedTrendsForDigest(trends, 4);
    const previousTrendMap = buildTrendMapFromState(previousDigest);
    const promptInput = {
        digestAt: formatIsoInTimezone(generatedAtIso || nowIso(), reportTimezone, true)
            || String(generatedAtIso || nowIso()).slice(0, 16).replace('T', ' '),
        topTrends: topTrends.map((trend) => {
            const key = normalizeKeyword(trend && trend.keyword);
            const prev = key ? previousTrendMap.get(key) : null;
            return {
                keyword: String((trend && trend.keyword) || '').trim(),
                mentionCount: Number(trend && trend.mention_count || 0),
                velocity: Number(trend && trend.velocity || 0),
                trendScore: Number(trend && trend.trend_score || 0),
                level: String((trend && trend.level) || 'low').trim().toLowerCase(),
                mentionDelta: formatDelta(Number(trend && trend.mention_count || 0), Number(prev && prev.mention_count || 0), 0),
                velocityDelta: formatDelta(Number(trend && trend.velocity || 0), Number(prev && prev.velocity || 0), 2),
                scoreDelta: formatDelta(Number(trend && trend.trend_score || 0), Number(prev && prev.trend_score || 0), 2),
            };
        }),
        repeatedKeywords: digestPayload.meta.repeatedKeywords,
        personalizedKeywords: digestPayload.meta.personalizedKeywords,
        interestKeywords: interestKeywords.slice(0, 10),
        previousDigestKeywords: Array.isArray(previousDigest && previousDigest.last_digest_keywords)
            ? previousDigest.last_digest_keywords
            : [],
        recentSamples: recentItems.slice(0, 3).map((item) => ({
            source: String((item && item.source) || '').trim(),
            community: String((item && item.community) || '').trim(),
            title: trimTitle(item && item.title, 90),
            url: String((item && item.url) || '').trim(),
        })),
        templateDraft: digestPayload.text,
    };
    const writerExecution = await generateDigestTextWithModel({
        config,
        promptInput,
    });
    const digestText = writerExecution.ok ? writerExecution.text : digestPayload.text;
    const enqueue = Boolean(options.enqueue);
    const writeStage = normalizeDigestModelStages(config && config.digestPolicy ? config.digestPolicy.modelStages : null).write;
    let writerFallbackAlert = {
        attempted: false,
        sent: false,
        message: '',
        delivery: {
            queued: false,
            directSent: false,
            directReason: 'not_attempted',
            directStatusCode: 0,
        },
    };
    if (enqueue && !writerExecution.ok) {
        const alertMessage = buildWriterFallbackAlertMessage(writerExecution, generatedAtIso, reportTimezone, writeStage);
        const alertDelivery = await queueTelegramMessage(alertMessage);
        writerFallbackAlert = {
            attempted: true,
            sent: Boolean(alertDelivery.directSent || alertDelivery.queued),
            message: alertMessage,
            delivery: alertDelivery,
        };
    }

    writeJsonFile(digestStatePath, {
        schema_version: '1.0',
        updated_at: nowIso(),
        last_digest_at: generatedAtIso,
        last_digest_hash: String(hashSeed(digestText)),
        last_digest_keywords: digestPayload.meta.topKeywords,
        last_repeated_keywords: digestPayload.meta.repeatedKeywords,
        last_personalized_keywords: digestPayload.meta.personalizedKeywords,
        last_digest_trends: digestPayload.meta.topTrendsByKeyword,
    });

    const delivery = enqueue
        ? await queueTelegramMessage(digestText)
        : {
            queued: false,
            directSent: false,
            directReason: 'enqueue_disabled',
            directStatusCode: 0,
        };

    if (enqueue && !delivery.directSent && !delivery.queued) {
        return {
            success: false,
            errorCode: 'NEWS_TELEGRAM_DELIVERY_FAILED',
            action: 'send',
            pipeline,
            generatedAt: generatedAtIso,
            digestText,
            queued: false,
            directSent: false,
            delivery,
            writerExecution,
            writerFallbackAlert,
            logOnly: {
                recentItems,
                sourceCounts24h,
                digestMeta: digestPayload.meta,
            },
            telegramReply: `테크 트렌드 리포트 전송 실패: ${delivery.directReason || 'unknown'}`,
        };
    }

    return {
        success: true,
        action: enqueue ? 'send' : 'digest',
        pipeline,
        generatedAt: generatedAtIso,
        digestText,
        queued: Boolean(delivery.queued),
        directSent: Boolean(delivery.directSent),
        delivery,
        writerExecution,
        writerFallbackAlert,
        logOnly: {
            recentItems,
            sourceCounts24h,
            digestMeta: digestPayload.meta,
        },
        telegramReply: digestText,
    };
}

async function buildEvent(paths, config, options = {}) {
    if (config.eventAlertsEnabled === false) {
        return {
            success: true,
            action: 'event',
            pipeline: {
                collect: { ok: true, skipped: true, reason: 'event_alert_disabled' },
                trend: { ok: true, skipped: true, reason: 'event_alert_disabled' },
            },
            triggered: 0,
            queued: false,
            directSent: false,
            delivery: {
                queued: false,
                directSent: false,
                directReason: 'event_alert_disabled',
                directStatusCode: 0,
            },
            events: [],
            telegramReply: '🚨 지금 뜨는 이슈 알림은 현재 비활성화 상태입니다.',
        };
    }

    const pipeline = await runPipeline(paths, config, options);
    const lookbackMinutes = Math.max(180, Number(config.thresholds.windowMinutes || 120) * 2);
    const lookbackIso = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();
    const trends = loadRecentTrends(paths.dbPath, 80, lookbackIso);
    const recentItems = loadRecentItems(paths.dbPath, 80, lookbackIso);
    const candidates = selectEventCandidates(trends, config);
    const filtered = [];
    for (const trend of candidates) {
        if (hasCooldown(paths.dbPath, trend.keyword, config.thresholds.cooldownHours)) continue;
        filtered.push(trend);
    }
    const uniqueFiltered = pickUniqueTrendsByKeyword(filtered, 5);
    const selectedByKeyword = new Map(
        uniqueFiltered.map((row) => [normalizeKeyword(row && row.keyword ? row.keyword : ''), row])
    );
    const previousByKeyword = new Map();
    for (const [key, currentTrend] of selectedByKeyword.entries()) {
        if (!key || !currentTrend) continue;
        const prev = trends.find((row) => normalizeKeyword(row && row.keyword ? row.keyword : '') === key && Number(row.id) !== Number(currentTrend.id));
        previousByKeyword.set(key, prev || null);
    }

    for (const trend of uniqueFiltered) persistAlert(paths.dbPath, trend);

    let telegramReply;
    if (!uniqueFiltered.length) {
        telegramReply = '🚨 지금 뜨는 이벤트 없음 (임계치/쿨다운 조건 미충족)';
    } else {
        const lines = ['🚨 지금 뜨는 이슈 알림', `왜 뜨는지 핵심만 정리했어 (TOP ${uniqueFiltered.length})`];
        lines.push(...uniqueFiltered.map((trend, idx) => formatTrendLine(trend, idx, {
            previousByKeyword,
            recentItems,
        })));
        telegramReply = lines.join('\n');
    }

    const enqueue = Boolean(options.enqueue);
    const delivery = enqueue && uniqueFiltered.length > 0
        ? await queueTelegramMessage(telegramReply)
        : {
            queued: false,
            directSent: false,
            directReason: uniqueFiltered.length > 0 ? 'enqueue_disabled' : 'no_event',
            directStatusCode: 0,
        };

    if (enqueue && uniqueFiltered.length > 0 && !delivery.directSent && !delivery.queued) {
        return {
            success: false,
            errorCode: 'NEWS_TELEGRAM_DELIVERY_FAILED',
            action: 'event',
            pipeline,
            triggered: uniqueFiltered.length,
            queued: false,
            directSent: false,
            delivery,
            events: uniqueFiltered,
            telegramReply: `이벤트 알림 전송 실패: ${delivery.directReason || 'unknown'}`,
        };
    }

    return {
        success: true,
        action: 'event',
        pipeline,
        triggered: uniqueFiltered.length,
        queued: Boolean(delivery.queued),
        directSent: Boolean(delivery.directSent),
        delivery,
        events: uniqueFiltered,
        telegramReply,
    };
}

async function handleNewsCommand(payload, options = {}) {
    const paths = getPaths(options);
    const config = parseConfig(paths);
    const text = String(payload || '').trim();
    const applyCollectStage = (result) => withStageModelMeta(result, config, 'collect');
    const applyWriteStage = (result) => withStageModelMeta(result, config, 'write');

    try {
        if (!text || text === '상태') {
            return applyCollectStage(await buildStatus(paths, config));
        }

        if (text === '지금요약' || text === '요약') {
            return applyWriteStage(await buildDigest(paths, config, options));
        }

        if (text === '이벤트') {
            return applyCollectStage(await buildEvent(paths, config, options));
        }

        const addKeyword = parseKeywordCommand(text, '키워드 추가');
        if (addKeyword) {
            const ok = upsertKeyword(paths.dbPath, addKeyword, true);
            return applyCollectStage({
                success: ok,
                action: 'keyword-add',
                keyword: addKeyword,
                telegramReply: ok
                    ? `키워드 추가 완료: ${addKeyword}`
                    : '키워드 추가 실패',
            });
        }

        const removeKeyword = parseKeywordCommand(text, '키워드 제외');
        if (removeKeyword) {
            const ok = upsertKeyword(paths.dbPath, removeKeyword, false);
            return applyCollectStage({
                success: ok,
                action: 'keyword-disable',
                keyword: removeKeyword,
                telegramReply: ok
                    ? `키워드 제외 완료: ${removeKeyword}`
                    : '키워드 제외 실패',
            });
        }

        const sourceMatch = text.match(/^소스\s+(on|off)\s+([a-z0-9_-]+)$/i);
        if (sourceMatch) {
            const on = sourceMatch[1].toLowerCase() === 'on';
            const sourceId = String(sourceMatch[2]).toLowerCase();
            const ok = toggleSource(paths, sourceId, on);
            return applyCollectStage({
                success: ok,
                action: 'source-toggle',
                sourceId,
                enabled: on,
                telegramReply: ok
                    ? `소스 ${on ? '활성화' : '비활성화'} 완료: ${sourceId}`
                    : `소스 ID를 찾을 수 없음: ${sourceId}`,
            });
        }

        if (text === '도움말' || text === 'help') {
            return applyCollectStage({
                success: true,
                action: 'help',
                telegramReply: [
                    '소식 명령어',
                    '- 상태',
                    '- 지금요약',
                    '- 이벤트',
                    '- 키워드 추가 <kw>',
                    '- 키워드 제외 <kw>',
                    '- 소스 on|off <sourceId>',
                ].join('\n'),
            });
        }

        return applyCollectStage({
            success: false,
            errorCode: 'UNKNOWN_NEWS_COMMAND',
            telegramReply: `알 수 없는 소식 명령: ${text}`,
        });
    } catch (error) {
        return applyCollectStage({
            success: false,
            errorCode: 'NEWS_COMMAND_FAILED',
            error: String(error.message || error),
            telegramReply: `소식 처리 실패: ${error.message || error}`,
        });
    }
}

async function main() {
    const cmd = String(process.argv[2] || 'status').trim();
    const payload = process.argv.slice(3).join(' ').trim();
    const windowMinutes = process.env.NEWS_WINDOW_MINUTES
        ? Number(process.env.NEWS_WINDOW_MINUTES)
        : undefined;

    let result;
    if (cmd === 'digest') {
        result = await handleNewsCommand('지금요약', { windowMinutes });
    } else if (cmd === 'send') {
        result = await handleNewsCommand('지금요약', { windowMinutes, enqueue: true });
    } else if (cmd === 'event') {
        result = await handleNewsCommand('이벤트', { windowMinutes, enqueue: true });
    } else if (cmd === 'status') {
        result = await handleNewsCommand('상태', { windowMinutes });
    } else {
        const text = [cmd, payload].join(' ').trim();
        result = await handleNewsCommand(text, { windowMinutes });
    }

    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exit(1);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = {
    handleNewsCommand,
    buildDigestText,
    selectEventCandidates,
};
