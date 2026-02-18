#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, '../data/oai_api_routing_policy.json');
const FEATURE_ID = 'api-key-required-keywords';

function readPolicy() {
    if (!fs.existsSync(POLICY_PATH)) {
        throw new Error(`Policy file not found: ${POLICY_PATH}`);
    }
    const raw = fs.readFileSync(POLICY_PATH, 'utf8');
    const json = JSON.parse(raw);
    return { raw, json };
}

function writePolicy(policy) {
    const nextRaw = `${JSON.stringify(policy, null, 2)}\n`;
    fs.writeFileSync(POLICY_PATH, nextRaw, 'utf8');
}

function getFeatureIndex(policy, id) {
    const list = Array.isArray(policy.featureOverrides) ? policy.featureOverrides : [];
    return list.findIndex((row) => String(row && row.id || '') === id);
}

function boolFromEnv(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function buildStatus(policy) {
    const guards = policy && policy.guards ? policy.guards : {};
    const idx = getFeatureIndex(policy, FEATURE_ID);
    const feature = idx >= 0 ? policy.featureOverrides[idx] : null;

    const laneEnabled = Boolean(guards.enableApiKeyLane);
    const featureEnabled = feature ? feature.enabled !== false : false;
    const hasApiKey = Boolean(String(process.env.OPENAI_API_KEY || process.env.OPENCLAW_OPENAI_API_KEY || '').trim());
    const paidApproved = boolFromEnv(process.env.MOLTBOT_ALLOW_PAID_API);
    const rateLimitSafeMode = boolFromEnv(process.env.RATE_LIMIT_SAFE_MODE);

    return {
        policyPath: POLICY_PATH,
        lane: {
            enabled: laneEnabled,
            guardKey: 'guards.enableApiKeyLane',
        },
        featureOverride: {
            id: FEATURE_ID,
            exists: idx >= 0,
            enabled: featureEnabled,
        },
        env: {
            hasOpenAiApiKey: hasApiKey,
            paidApiApproved: paidApproved,
            rateLimitSafeMode,
        },
        effective: {
            apiKeyLaneRequestWillPassGuards: laneEnabled && hasApiKey && paidApproved && !rateLimitSafeMode,
        },
        note: laneEnabled
            ? 'API-key lane is enabled by policy. Runtime guards still apply.'
            : 'OAuth-only mode active (API-key lane disabled by policy).',
    };
}

function ensureGuards(policy) {
    if (!policy.guards || typeof policy.guards !== 'object') {
        policy.guards = {};
    }
}

function enableLane(policy, options = {}) {
    ensureGuards(policy);
    policy.guards.enableApiKeyLane = true;

    const idx = getFeatureIndex(policy, FEATURE_ID);
    if (idx >= 0 && options.enableFeatureOverrides) {
        policy.featureOverrides[idx].enabled = true;
    }

    return policy;
}

function disableLane(policy, options = {}) {
    ensureGuards(policy);
    policy.guards.enableApiKeyLane = false;

    const idx = getFeatureIndex(policy, FEATURE_ID);
    if (idx >= 0 && !options.keepFeatureOverrides) {
        policy.featureOverrides[idx].enabled = false;
    }

    return policy;
}

function parseArgs(argv) {
    const args = {
        command: String(argv[0] || 'status').trim().toLowerCase(),
        enableFeatureOverrides: false,
        keepFeatureOverrides: false,
    };

    for (let i = 1; i < argv.length; i += 1) {
        const token = String(argv[i] || '').trim();
        if (token === '--enable-feature-overrides') {
            args.enableFeatureOverrides = true;
        } else if (token === '--keep-feature-overrides') {
            args.keepFeatureOverrides = true;
        }
    }

    return args;
}

function usage() {
    console.log(
        [
            'Usage:',
            '  node scripts/oai_api_lane_toggle.js status',
            '  node scripts/oai_api_lane_toggle.js enable [--enable-feature-overrides]',
            '  node scripts/oai_api_lane_toggle.js disable [--keep-feature-overrides]',
        ].join('\n'),
    );
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!['status', 'enable', 'disable'].includes(args.command)) {
        usage();
        process.exit(1);
    }

    const { raw, json } = readPolicy();

    if (args.command === 'status') {
        console.log(JSON.stringify({ ok: true, command: 'status', ...buildStatus(json) }, null, 2));
        return;
    }

    const before = buildStatus(json);
    const next = args.command === 'enable'
        ? enableLane(json, args)
        : disableLane(json, args);

    const nextRaw = `${JSON.stringify(next, null, 2)}\n`;
    const changed = nextRaw !== raw;
    if (changed) {
        writePolicy(next);
    }

    console.log(JSON.stringify({
        ok: true,
        command: args.command,
        changed,
        before,
        after: buildStatus(next),
        hints: {
            oauthOnly: 'disable + no runtime lane override',
            enableRuntimeLaneTemporarily: 'export MOLTBOT_ENABLE_API_KEY_LANE=true',
            approvePaidApi: 'export MOLTBOT_ALLOW_PAID_API=true',
        },
    }, null, 2));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message || String(error));
        process.exit(1);
    }
}
