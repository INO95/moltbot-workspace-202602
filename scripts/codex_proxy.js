/**
 * Codex OpenAI Proxy Server
 * 로컬 OpenAI-호환 요청을 실제 API로 전달하는 프록시
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, '../data/secure/proxy_config.json');
const POLICY_PATH = path.join(__dirname, '../data/config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const runtimePolicy = fs.existsSync(POLICY_PATH)
    ? JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
    : {};
const proxyCfg = (config.proxies && config.proxies.codex) || {};
const budgetPolicy = runtimePolicy.budgetPolicy || {};

const PORT = Number(proxyCfg.port || process.env.CODEX_PROXY_PORT || 3000);
const UPSTREAM_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const UPSTREAM_MODEL =
    process.env.OPENAI_MODEL ||
    (proxyCfg.model && proxyCfg.model.default) ||
    'gpt-4o-mini';
const ALLOW_FILE_TOKEN = String(process.env.CODEX_PROXY_ALLOW_FILE_TOKEN || '').toLowerCase() === 'true';
const API_KEY =
    process.env.OPENAI_API_KEY ||
    (ALLOW_FILE_TOKEN ? (proxyCfg.auth && proxyCfg.auth.accessToken) : '') ||
    '';
const ALLOW_LOCAL_ONLY = !!(proxyCfg.security && proxyCfg.security.allowLocalOnly);
const RATE_LIMIT_SAFE = String(process.env.RATE_LIMIT_SAFE_MODE || '').toLowerCase() === 'true';
const ALLOW_PAID_API =
    !RATE_LIMIT_SAFE &&
    (String(process.env.MOLTBOT_ALLOW_PAID_API || '').toLowerCase() === 'true' ||
        !(budgetPolicy.monthlyApiBudgetYen === 0 && budgetPolicy.paidApiRequiresApproval === true));

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

const server = http.createServer(async (req, res) => {
    if (ALLOW_LOCAL_ONLY && !isLocalAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'Access denied: local requests only' });
        return;
    }

    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        sendJson(res, 404, { error: 'Not Found' });
        return;
    }

    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        try {
            if (!API_KEY) {
                sendJson(res, 500, {
                    error: 'Missing OPENAI_API_KEY (or proxy auth accessToken)',
                });
                return;
            }
            if (!ALLOW_PAID_API) {
                sendJson(res, 402, {
                    error: 'Paid API is blocked by budget policy (monthly budget = 0 JPY).',
                });
                return;
            }

            const requestData = JSON.parse(body || '{}');
            if (requestData.stream) {
                sendJson(res, 501, { error: 'stream=true is not supported by this proxy yet' });
                return;
            }

            const payload = {
                ...requestData,
                model: requestData.model || UPSTREAM_MODEL,
            };

            const upstream = await axios.post(
                `${UPSTREAM_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 60000,
                },
            );

            sendJson(res, 200, upstream.data);
        } catch (error) {
            const statusCode = error.response?.status || 500;
            const detail = error.response?.data || { message: error.message };
            console.error('[Proxy] Error:', detail);
            sendJson(res, statusCode, { error: detail });
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Codex Proxy listening on http://127.0.0.1:${PORT}`);
    console.log(`Upstream: ${UPSTREAM_BASE_URL} (model default: ${UPSTREAM_MODEL})`);
    console.log(`Local-only mode: ${ALLOW_LOCAL_ONLY ? 'enabled' : 'disabled'}`);
    console.log(`File token fallback: ${ALLOW_FILE_TOKEN ? 'enabled' : 'disabled'}`);
    console.log(`Budget guard (paid API): ${ALLOW_PAID_API ? 'allowed' : 'blocked'}`);
});
