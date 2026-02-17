const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, '../data/oai_api_routing_policy.json');
const CONFIG_PATH = path.join(__dirname, '../data/config.json');

const DEFAULT_POLICY = {
    version: 1,
    lanes: {
        'oauth-codex': {
            authMode: 'oauth',
            capabilities: ['complex_reasoning', 'code_review', 'translation'],
        },
        'api-key-openai': {
            authMode: 'api-key',
            capabilities: ['responses_api', 'realtime_api', 'batch_jobs', 'webhooks'],
        },
        'local-only': {
            authMode: 'none',
            capabilities: ['local_scripts', 'system_checks'],
        },
    },
    routeDefaults: {
        work: 'oauth-codex',
        inspect: 'oauth-codex',
        deploy: 'oauth-codex',
        project: 'oauth-codex',
        prompt: 'oauth-codex',
        report: 'oauth-codex',
        word: 'local-only',
        news: 'local-only',
        finance: 'local-only',
        todo: 'local-only',
        routine: 'local-only',
        workout: 'local-only',
        media: 'local-only',
        place: 'local-only',
        status: 'local-only',
        link: 'local-only',
        ops: 'local-only',
        anki: 'local-only',
        none: 'local-only',
    },
    featureOverrides: [],
    guards: {
        enableApiKeyLane: false,
        requirePaidApproval: true,
        blockWhenRateLimitSafeMode: true,
    },
};

const ROUTE_PREFIXES = [
    { route: 'word', prefixes: ['단어:', '학습:'] },
    { route: 'news', prefixes: ['소식:'] },
    { route: 'finance', prefixes: ['가계:', '가계부:'] },
    { route: 'todo', prefixes: ['투두:', '할일:'] },
    { route: 'routine', prefixes: ['루틴:'] },
    { route: 'workout', prefixes: ['운동:'] },
    { route: 'media', prefixes: ['콘텐츠:'] },
    { route: 'place', prefixes: ['식당:', '맛집:'] },
    { route: 'report', prefixes: ['리포트:', '요약:'] },
    { route: 'work', prefixes: ['작업:', '실행:'] },
    { route: 'inspect', prefixes: ['점검:', '검토:'] },
    { route: 'deploy', prefixes: ['배포:', '출시:'] },
    { route: 'project', prefixes: ['프로젝트:'] },
    { route: 'prompt', prefixes: ['프롬프트:', '질문:'] },
    { route: 'link', prefixes: ['링크:'] },
    { route: 'status', prefixes: ['상태:'] },
    { route: 'ops', prefixes: ['운영:'] },
];

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function mergePolicy(base, next) {
    return {
        ...base,
        ...(next || {}),
        lanes: {
            ...(base.lanes || {}),
            ...((next && next.lanes) || {}),
        },
        routeDefaults: {
            ...(base.routeDefaults || {}),
            ...((next && next.routeDefaults) || {}),
        },
        guards: {
            ...(base.guards || {}),
            ...((next && next.guards) || {}),
        },
        featureOverrides: Array.isArray(next && next.featureOverrides)
            ? next.featureOverrides
            : base.featureOverrides,
    };
}

function loadRoutingPolicy(customPolicy = null) {
    if (customPolicy && typeof customPolicy === 'object') {
        return mergePolicy(DEFAULT_POLICY, customPolicy);
    }
    const fromFile = readJson(POLICY_PATH, {});
    return mergePolicy(DEFAULT_POLICY, fromFile);
}

function loadBudgetPolicy(customBudgetPolicy = null) {
    if (customBudgetPolicy && typeof customBudgetPolicy === 'object') return customBudgetPolicy;
    const cfg = readJson(CONFIG_PATH, {});
    return (cfg && cfg.budgetPolicy) || {};
}

function normalizeLane(value, policy) {
    const lane = String(value || '').trim();
    if (lane && policy.lanes && policy.lanes[lane]) return lane;
    return 'local-only';
}

function normalizeRoute(value) {
    const route = String(value || '').trim().toLowerCase();
    return route || 'none';
}

function normalizeApiOverride(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v || v === 'auto') return { lane: null, valid: true, value: 'auto' };
    if (v === 'oauth') return { lane: 'oauth-codex', valid: true, value: v };
    if (v === 'key') return { lane: 'api-key-openai', valid: true, value: v };
    return { lane: null, valid: false, value: v };
}

function extractApiOverrideFromText(text) {
    const m = String(text || '').match(/(?:^|[;\n])\s*api\s*[:：]\s*([^;\n]+)/i);
    return m ? String(m[1] || '').trim() : '';
}

function boolFromEnv(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function evaluateApiKeyLaneAccess(options = {}) {
    const policy = loadRoutingPolicy(options.policy || null);
    const budgetPolicy = loadBudgetPolicy(options.budgetPolicy || null);
    const env = options.env || process.env;

    const guards = policy.guards || {};
    const laneEnabledByEnv = boolFromEnv(env.MOLTBOT_ENABLE_API_KEY_LANE);
    const enableApiKeyLane = laneEnabledByEnv || Boolean(guards.enableApiKeyLane);
    const requirePaidApproval = Boolean(guards.requirePaidApproval);
    const blockWhenRateLimitSafeMode = Boolean(guards.blockWhenRateLimitSafeMode);

    if (!enableApiKeyLane) {
        return {
            allowed: false,
            blocked: true,
            blockReason: 'api_key_lane_disabled',
            fallbackLane: 'oauth-codex',
        };
    }

    const monthlyBudgetYen = Number(budgetPolicy.monthlyApiBudgetYen || 0);
    const paidApiRequiresApproval = Boolean(budgetPolicy.paidApiRequiresApproval);
    const budgetGateEnabled = monthlyBudgetYen === 0 && paidApiRequiresApproval;

    const rateLimitSafeMode = boolFromEnv(env.RATE_LIMIT_SAFE_MODE);
    const paidApiApproved = boolFromEnv(env.MOLTBOT_ALLOW_PAID_API);
    const hasOpenAiKey = Boolean(String(env.OPENAI_API_KEY || env.OPENCLAW_OPENAI_API_KEY || '').trim());

    if (blockWhenRateLimitSafeMode && rateLimitSafeMode) {
        return {
            allowed: false,
            blocked: true,
            blockReason: 'rate_limit_safe_mode',
            fallbackLane: 'oauth-codex',
        };
    }

    if (requirePaidApproval && budgetGateEnabled && !paidApiApproved) {
        return {
            allowed: false,
            blocked: true,
            blockReason: 'paid_api_approval_required',
            fallbackLane: 'oauth-codex',
        };
    }

    if (!hasOpenAiKey) {
        return {
            allowed: false,
            blocked: true,
            blockReason: 'openai_api_key_missing',
            fallbackLane: 'oauth-codex',
        };
    }

    return {
        allowed: true,
        blocked: false,
        blockReason: '',
        fallbackLane: null,
    };
}

function normalizePrefix(prefix) {
    const raw = String(prefix || '').trim();
    const colonMatch = raw.match(/^(.*?)[：:]$/);
    if (!colonMatch) return { stem: raw, hasColon: false };
    return { stem: colonMatch[1].trim(), hasColon: true };
}

function inferRouteFromCommand(commandText, options = {}) {
    const input = String(commandText || '').trim();
    const configPrefixes = options.commandPrefixes || null;
    const rules = ROUTE_PREFIXES.map((rule) => {
        if (!configPrefixes) return rule;
        if (rule.route === 'word') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.word, configPrefixes.learn].filter(Boolean),
            };
        }
        if (rule.route === 'report') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.report, configPrefixes.summary].filter(Boolean),
            };
        }
        if (rule.route === 'work') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.work, configPrefixes.do].filter(Boolean),
            };
        }
        if (rule.route === 'inspect') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.inspect, configPrefixes.check].filter(Boolean),
            };
        }
        if (rule.route === 'deploy') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.deploy, configPrefixes.ship].filter(Boolean),
            };
        }
        if (rule.route === 'project') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.project].filter(Boolean),
            };
        }
        if (rule.route === 'prompt') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.prompt, configPrefixes.ask].filter(Boolean),
            };
        }
        if (rule.route === 'news') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.news].filter(Boolean),
            };
        }
        if (rule.route === 'finance') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.finance, configPrefixes.ledger].filter(Boolean),
            };
        }
        if (rule.route === 'todo') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.todo, configPrefixes.task].filter(Boolean),
            };
        }
        if (rule.route === 'routine') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.routine].filter(Boolean),
            };
        }
        if (rule.route === 'workout') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.workout].filter(Boolean),
            };
        }
        if (rule.route === 'media') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.media].filter(Boolean),
            };
        }
        if (rule.route === 'place') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.place, configPrefixes.restaurant].filter(Boolean),
            };
        }
        if (rule.route === 'status') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.status].filter(Boolean),
            };
        }
        if (rule.route === 'ops') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.ops].filter(Boolean),
            };
        }
        if (rule.route === 'link') {
            return {
                route: rule.route,
                prefixes: [configPrefixes.link].filter(Boolean),
            };
        }
        return rule;
    });

    for (const rule of rules) {
        const prefixes = Array.isArray(rule.prefixes) ? rule.prefixes : [];
        for (const prefix of prefixes) {
            const normalized = normalizePrefix(prefix);
            if (!normalized.stem) continue;
            if (normalized.hasColon) {
                const re = new RegExp(`^\\s*${escapeRegExp(normalized.stem)}\\s*(?:[:：])?\\s*`, 'i');
                const m = input.match(re);
                if (m) {
                    return {
                        route: rule.route,
                        payload: input.slice(m[0].length).trim(),
                    };
                }
                continue;
            }
            const re = new RegExp(`^\\s*${escapeRegExp(normalized.stem)}\\s+`, 'i');
            const m = input.match(re);
            if (m) {
                return {
                    route: rule.route,
                    payload: input.slice(m[0].length).trim(),
                };
            }
        }
    }

    return { route: 'none', payload: input };
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKeywords(row) {
    if (!row || !Array.isArray(row.keywords)) return [];
    return row.keywords.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
}

function matchFeatureOverride(row, route, commandText) {
    if (!row || typeof row !== 'object') return false;
    if (row.enabled === false) return false;

    const routes = Array.isArray(row.routes)
        ? row.routes.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
        : [];
    if (routes.length > 0 && !routes.includes(route)) return false;

    const normalizedText = String(commandText || '').toLowerCase().trim();
    if (!normalizedText && row.allowEmptyCommand) return true;

    const keywords = normalizeKeywords(row);
    if (keywords.length === 0) return false;

    const mode = String(row.match || 'any').toLowerCase();
    if (mode === 'all') return keywords.every((k) => normalizedText.includes(k));
    return keywords.some((k) => normalizedText.includes(k));
}

function shouldSuggestOauthFallback(route) {
    return ['work', 'inspect', 'deploy', 'project', 'prompt', 'report'].includes(route);
}

function decideApiLane(input = {}, options = {}) {
    const policy = loadRoutingPolicy(options.policy || null);
    const env = options.env || process.env;
    const budgetPolicy = loadBudgetPolicy(options.budgetPolicy || null);

    const route = normalizeRoute(input.route);
    const routeHint = String(input.routeHint || '').trim();
    const commandText = String(input.commandText || '').trim();
    const templateFields = (input.templateFields && typeof input.templateFields === 'object') ? input.templateFields : {};

    const routeDefaults = policy.routeDefaults || {};
    let apiLane = normalizeLane(routeDefaults[route] || routeDefaults.none, policy);
    let reason = `route-default:${route}`;

    for (const row of (Array.isArray(policy.featureOverrides) ? policy.featureOverrides : [])) {
        if (matchFeatureOverride(row, route, commandText)) {
            apiLane = normalizeLane(row.targetLane, policy);
            reason = `feature-override:${String(row.id || 'unnamed')}`;
            break;
        }
    }

    const overrideRaw = templateFields.API || extractApiOverrideFromText(commandText);
    const override = normalizeApiOverride(overrideRaw);

    let blocked = false;
    let blockReason = '';
    let fallbackLane = null;

    if (!override.valid) {
        blocked = true;
        blockReason = 'invalid_api_override';
        fallbackLane = apiLane;
    } else if (override.lane) {
        apiLane = normalizeLane(override.lane, policy);
        reason = `manual-override:${override.value}`;
    }

    const guards = policy.guards || {};
    const laneEnabledByEnv = boolFromEnv(env.MOLTBOT_ENABLE_API_KEY_LANE);
    const enableApiKeyLane = laneEnabledByEnv || Boolean(guards.enableApiKeyLane);

    if (!blocked && apiLane === 'api-key-openai' && !enableApiKeyLane) {
        blocked = true;
        blockReason = 'api_key_lane_disabled';
        fallbackLane = 'oauth-codex';
    }

    if (!blocked && apiLane === 'api-key-openai') {
        const access = evaluateApiKeyLaneAccess({ policy, budgetPolicy, env });
        blocked = Boolean(access.blocked);
        blockReason = access.blockReason || '';
        fallbackLane = access.fallbackLane || null;
    }

    if (!blocked && apiLane === 'oauth-codex' && shouldSuggestOauthFallback(route)) {
        fallbackLane = 'api-key-openai';
    }

    const laneMeta = policy.lanes[apiLane] || policy.lanes['local-only'] || {
        authMode: 'none',
        capabilities: [],
    };

    return {
        apiLane,
        authMode: String(laneMeta.authMode || 'none'),
        reason: routeHint ? `${reason}|${routeHint}` : reason,
        capabilities: Array.isArray(laneMeta.capabilities) ? laneMeta.capabilities : [],
        blocked,
        blockReason,
        fallbackLane,
        override: override.value,
    };
}

module.exports = {
    POLICY_PATH,
    DEFAULT_POLICY,
    loadRoutingPolicy,
    loadBudgetPolicy,
    normalizeApiOverride,
    evaluateApiKeyLaneAccess,
    inferRouteFromCommand,
    decideApiLane,
};
