const assert = require('assert');

const healthcheck = require('./prompt_web_healthcheck');

function makeConnRefused() {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:18788');
    error.code = 'ECONNREFUSED';
    return error;
}

async function testDirect200() {
    const result = await healthcheck.check('http://127.0.0.1:18788/prompt/', {
        requestOnce: async () => ({
            statusCode: 200,
            headers: {},
        }),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.redirected, false);
}

async function testPromptRedirectToPromptSlash() {
    let callCount = 0;
    const observedUrls = [];
    const result = await healthcheck.check('http://127.0.0.1:18788/prompt', {
        requestOnce: async (urlText) => {
            observedUrls.push(urlText);
            callCount += 1;
            if (callCount === 1) {
                return {
                    statusCode: 301,
                    headers: { location: '/prompt/' },
                };
            }
            return {
                statusCode: 200,
                headers: {},
            };
        },
    });
    assert.deepStrictEqual(observedUrls, [
        'http://127.0.0.1:18788/prompt',
        'http://127.0.0.1:18788/prompt/',
    ]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.redirected, true);
    assert.strictEqual(result.redirectStatusCode, 301);
}

async function test404Fails() {
    await assert.rejects(
        () => healthcheck.check('http://127.0.0.1:18788/prompt/', {
            requestOnce: async () => ({
                statusCode: 404,
                headers: {},
            }),
        }),
        /HTTP 404/,
    );
}

async function testInvalidRedirectFails() {
    await assert.rejects(
        () => healthcheck.check('http://127.0.0.1:18788/prompt', {
            requestOnce: async () => ({
                statusCode: 302,
                headers: { location: 'https://evil.example/prompt/' },
            }),
        }),
        /redirect host mismatch/,
    );
}

async function testUnexpectedRedirectPathFails() {
    await assert.rejects(
        () => healthcheck.check('http://127.0.0.1:18788/prompt', {
            requestOnce: async () => ({
                statusCode: 302,
                headers: { location: '/prompt/health' },
            }),
        }),
        /unexpected redirect path/,
    );
}

async function testServiceAbsentClassification() {
    const result = await healthcheck.runHealthcheck('http://127.0.0.1:18788/prompt', {
        requestOnce: async () => {
            throw makeConnRefused();
        },
        inspectPromptWebRuntime: () => ({
            ok: true,
            promptRunning: false,
            proxyRunning: false,
            runningProxies: [],
            runningContainers: [],
        }),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.classification, 'service_absent');
}

async function testActiveContainerKeepsFailure() {
    const result = await healthcheck.runHealthcheck('http://127.0.0.1:18788/prompt', {
        requestOnce: async () => {
            throw makeConnRefused();
        },
        inspectPromptWebRuntime: () => ({
            ok: true,
            promptRunning: true,
            proxyRunning: false,
            runningProxies: [],
            runningContainers: [{ name: 'moltbot-prompt-web', status: 'Up 5 minutes' }],
        }),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.classification, 'connection_refused');
}

async function run() {
    await testDirect200();
    await testPromptRedirectToPromptSlash();
    await test404Fails();
    await testInvalidRedirectFails();
    await testUnexpectedRedirectPathFails();
    await testServiceAbsentClassification();
    await testActiveContainerKeepsFailure();
}

run()
    .then(() => {
        console.log('test_prompt_web_healthcheck: ok');
    })
    .catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
