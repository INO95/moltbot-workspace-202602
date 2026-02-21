/**
 * Codex OpenAI Proxy Server
 * OpenAI API-Key lane executor (chat/responses/realtime client secrets)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { evaluateApiKeyLaneAccess } = require('./oai_api_router');

const CONFIG_PATH = path.join(__dirname, '../data/secure/proxy_config.json');
const POLICY_PATH = path.join(__dirname, '../data/config.json');

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function isLocalAddress(address) {
    if (!address) return false;
    return (
        address === '127.0.0.1' ||
        address === '::1' ||
        address === '::ffff:127.0.0.1'
    );
}

function sendJson(res, statusCode, body) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function parseJsonBody(raw) {
    const text = String(raw || '').trim();
    if (!text) return {};
    return JSON.parse(text);
}

function resolveEndpoint(urlPath) {
    const pathname = String(urlPath || '').split('?')[0];
    if (pathname === '/v1/chat/completions') {
        return { key: 'chat', upstreamPath: '/v1/chat/completions', setDefaultModel: true };
    }
    if (pathname === '/v1/responses') {
        return { key: 'responses', upstreamPath: '/v1/responses', setDefaultModel: true };
    }
    if (pathname === '/v1/realtime/client_secrets' || pathname === '/v1/realtime/sessions') {
        return { key: 'realtime', upstreamPath: '/v1/realtime/client_secrets', setDefaultModel: true, realtime: true };
    }
    return null;
}

function applyDefaultModel(payload, endpoint, runtime) {
    const out = { ...(payload || {}) };
    if (!endpoint || !endpoint.setDefaultModel) return out;
    if (out.model) return out;

    if (endpoint.realtime) {
        out.model = runtime.realtimeModel || runtime.defaultModel;
        return out;
    }

    out.model = runtime.defaultModel;
    return out;
}

function resolveRuntime(env = process.env) {
    const config = readJson(CONFIG_PATH, {});
    const runtimePolicy = readJson(POLICY_PATH, {});
    const proxyCfg = (config.proxies && config.proxies.codex) || {};
    const budgetPolicy = runtimePolicy.budgetPolicy || {};

    const allowFileToken = String(env.CODEX_PROXY_ALLOW_FILE_TOKEN || '').toLowerCase() === 'true';
    const apiKey =
        env.OPENAI_API_KEY ||
        env.OPENCLAW_OPENAI_API_KEY ||
        (allowFileToken ? (proxyCfg.auth && proxyCfg.auth.accessToken) : '') ||
        '';

    const port = Number(env.CODEX_PROXY_PORT || proxyCfg.port || 3000);
    return {
        port,
        upstreamBaseUrl: String(env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, ''),
        defaultModel:
            env.OPENAI_MODEL ||
            (proxyCfg.model && proxyCfg.model.default) ||
            'gpt-4o-mini',
        realtimeModel:
            env.OPENAI_REALTIME_MODEL ||
            (proxyCfg.model && proxyCfg.model.realtime) ||
            '',
        allowLocalOnly: !!(proxyCfg.security && proxyCfg.security.allowLocalOnly),
        allowFileToken,
        apiKey: String(apiKey || '').trim(),
        budgetPolicy,
        env,
    };
}

function createProxyServer(options = {}) {
    const runtime = resolveRuntime(options.env || process.env);

    return http.createServer(async (req, res) => {
        if (runtime.allowLocalOnly && !isLocalAddress(req.socket.remoteAddress)) {
            sendJson(res, 403, { error: 'Access denied: local requests only' });
            return;
        }

        if (req.method !== 'POST') {
            sendJson(res, 404, { error: 'Not Found' });
            return;
        }

        const endpoint = resolveEndpoint(req.url || '');
        if (!endpoint) {
            sendJson(res, 404, { error: 'Not Found' });
            return;
        }

        let rawBody = '';
        req.on('data', (chunk) => {
            rawBody += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const guardEnv = {
                    ...runtime.env,
                    OPENAI_API_KEY: runtime.apiKey || runtime.env.OPENAI_API_KEY || '',
                    OPENCLAW_OPENAI_API_KEY: runtime.apiKey || runtime.env.OPENCLAW_OPENAI_API_KEY || '',
                };
                const access = evaluateApiKeyLaneAccess({
                    env: guardEnv,
                    budgetPolicy: runtime.budgetPolicy,
                });
                if (access.blocked) {
                    sendJson(res, 402, {
                        error: `Paid API lane is blocked (${access.blockReason || 'policy'}).`,
                        blockReason: access.blockReason || 'policy',
                    });
                    return;
                }

                if (!runtime.apiKey) {
                    sendJson(res, 500, {
                        error: 'Missing OPENAI_API_KEY (or OPENCLAW_OPENAI_API_KEY / proxy accessToken)',
                    });
                    return;
                }

                const requestData = parseJsonBody(rawBody);
                if (requestData.stream) {
                    sendJson(res, 501, { error: 'stream=true is not supported by this proxy yet' });
                    return;
                }

                const payload = applyDefaultModel(requestData, endpoint, runtime);
                const upstream = await axios.post(
                    `${runtime.upstreamBaseUrl}${endpoint.upstreamPath}`,
                    payload,
                    {
                        headers: {
                            Authorization: `Bearer ${runtime.apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: 60000,
                    },
                );

                sendJson(res, 200, upstream.data);
            } catch (error) {
                if (error instanceof SyntaxError) {
                    sendJson(res, 400, { error: 'Invalid JSON body' });
                    return;
                }
                const statusCode = error.response?.status || 500;
                const detail = error.response?.data || { message: error.message };
                console.error('[Proxy] Error:', detail);
                sendJson(res, statusCode, { error: detail });
            }
        });
    });
}

function main() {
    const runtime = resolveRuntime(process.env);
    const server = createProxyServer({ env: process.env });
    server.listen(runtime.port, '127.0.0.1', () => {
        console.log(`Codex Proxy listening on http://127.0.0.1:${runtime.port}`);
        console.log(`Upstream: ${runtime.upstreamBaseUrl} (default model: ${runtime.defaultModel})`);
        console.log(`Realtime model default: ${runtime.realtimeModel || runtime.defaultModel}`);
        console.log(`Local-only mode: ${runtime.allowLocalOnly ? 'enabled' : 'disabled'}`);
        console.log(`File token fallback: ${runtime.allowFileToken ? 'enabled' : 'disabled'}`);
    });
}

if (require.main === module) {
    main();
}

module.exports = {
    resolveEndpoint,
    applyDefaultModel,
    resolveRuntime,
    createProxyServer,
};
