const assert = require('assert');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && address.port;
            server.close((err) => {
                if (err) return reject(err);
                resolve(port);
            });
        });
        server.on('error', reject);
    });
}

function waitForReady(child, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('proxy ready timeout'));
        }, timeoutMs);

        const onData = (chunk) => {
            const text = String(chunk || '');
            if (text.includes('Codex Proxy listening on http://127.0.0.1:')) {
                cleanup();
                resolve();
            }
        };

        const onExit = (code) => {
            cleanup();
            reject(new Error(`proxy exited before ready (code=${code})`));
        };

        function cleanup() {
            clearTimeout(timeout);
            child.stdout.off('data', onData);
            child.off('exit', onExit);
        }

        child.stdout.on('data', onData);
        child.on('exit', onExit);
    });
}

function httpPost(port, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = http.request(
            {
                method: 'POST',
                host: '127.0.0.1',
                port,
                path: pathname,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => { raw += String(chunk || ''); });
                res.on('end', () => {
                    let json = null;
                    try {
                        json = JSON.parse(raw || '{}');
                    } catch (error) {
                        return reject(error);
                    }
                    resolve({ status: res.statusCode, body: json });
                });
            },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function httpPostWithRetry(port, pathname, body, retries = 8) {
    let lastError = null;
    for (let i = 0; i < retries; i += 1) {
        try {
            return await httpPost(port, pathname, body);
        } catch (error) {
            lastError = error;
            if (!(error && error.code === 'ECONNREFUSED')) break;
            await new Promise((resolve) => setTimeout(resolve, 120));
        }
    }
    throw lastError || new Error('http post failed');
}

function stopChild(child) {
    return new Promise((resolve) => {
        if (!child || child.killed) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
        }, 1500).unref();
    });
}

async function startStubServer() {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += String(chunk || '');
        });
        req.on('end', () => {
            let parsed = {};
            try {
                parsed = JSON.parse(raw || '{}');
            } catch {
                parsed = {};
            }
            requests.push({
                path: req.url,
                method: req.method,
                headers: req.headers,
                body: parsed,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, path: req.url, model: parsed.model || null }));
        });
    });

    const port = await getFreePort();
    await new Promise((resolve, reject) => {
        server.listen(port, '127.0.0.1', (err) => {
            if (err) return reject(err);
            resolve();
        });
    });

    return {
        port,
        requests,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function startProxy(envOverrides) {
    const env = {
        ...process.env,
        ...envOverrides,
    };
    const child = spawn('node', [path.join('scripts', 'codex_proxy.js')], {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrText = '';
    child.stderr.on('data', (chunk) => {
        stderrText += String(chunk || '');
    });
    await waitForReady(child);
    child.__stderr = () => stderrText;
    return child;
}

async function testForwarding() {
    const stub = await startStubServer();
    const proxyPort = await getFreePort();

    const proxy = await startProxy({
        CODEX_PROXY_PORT: String(proxyPort),
        OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}`,
        OPENAI_API_KEY: 'sk-test-forward',
        MOLTBOT_ENABLE_API_KEY_LANE: 'true',
        MOLTBOT_ALLOW_PAID_API: 'true',
        RATE_LIMIT_SAFE_MODE: 'false',
        CODEX_PROXY_ALLOW_FILE_TOKEN: 'false',
    });

    try {
        const responsesRes = await httpPostWithRetry(proxyPort, '/v1/responses', { input: 'hello' });
        assert.strictEqual(responsesRes.status, 200);

        const realtimeRes = await httpPostWithRetry(proxyPort, '/v1/realtime/client_secrets', { model: 'gpt-realtime-test' });
        assert.strictEqual(realtimeRes.status, 200);

        assert.ok(stub.requests.some((r) => r.path === '/v1/responses'));
        assert.ok(stub.requests.some((r) => r.path === '/v1/realtime/client_secrets'));

        const responseReq = stub.requests.find((r) => r.path === '/v1/responses');
        assert.ok(responseReq.headers.authorization);
        assert.ok(String(responseReq.headers.authorization).startsWith('Bearer sk-test-forward'));
    } finally {
        await stopChild(proxy);
        await stub.close();
    }
}

async function testSafeModeGuardBlock() {
    const proxyPort = await getFreePort();
    const proxy = await startProxy({
        CODEX_PROXY_PORT: String(proxyPort),
        OPENAI_BASE_URL: 'http://127.0.0.1:1',
        OPENAI_API_KEY: 'sk-test',
        MOLTBOT_ENABLE_API_KEY_LANE: 'true',
        MOLTBOT_ALLOW_PAID_API: 'true',
        RATE_LIMIT_SAFE_MODE: 'true',
        CODEX_PROXY_ALLOW_FILE_TOKEN: 'false',
    });

    try {
        const res = await httpPostWithRetry(proxyPort, '/v1/responses', { input: 'blocked' });
        assert.strictEqual(res.status, 402);
        assert.strictEqual(res.body.blockReason, 'rate_limit_safe_mode');
    } finally {
        await stopChild(proxy);
    }
}

async function testMissingApiKey() {
    const proxyPort = await getFreePort();
    const proxy = await startProxy({
        CODEX_PROXY_PORT: String(proxyPort),
        OPENAI_BASE_URL: 'http://127.0.0.1:1',
        OPENAI_API_KEY: '',
        OPENCLAW_OPENAI_API_KEY: '',
        MOLTBOT_ENABLE_API_KEY_LANE: 'true',
        MOLTBOT_ALLOW_PAID_API: 'true',
        RATE_LIMIT_SAFE_MODE: 'false',
        CODEX_PROXY_ALLOW_FILE_TOKEN: 'false',
    });

    try {
        const res = await httpPostWithRetry(proxyPort, '/v1/responses', { input: 'no key' });
        assert.strictEqual(res.status, 402);
        assert.strictEqual(res.body.blockReason, 'openai_api_key_missing');
    } finally {
        await stopChild(proxy);
    }
}

async function run() {
    await testForwarding();
    await testSafeModeGuardBlock();
    await testMissingApiKey();
    console.log('test_codex_proxy_routes: ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
