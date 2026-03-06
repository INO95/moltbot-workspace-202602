#!/usr/bin/env node
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const DEFAULT_TARGET = process.env.PROMPT_WEB_HEALTH_URL || 'http://127.0.0.1:18788/prompt';
const PROMPT_CONTAINER_NAME = 'moltbot-prompt-web';
const PROXY_CONTAINER_NAMES = Object.freeze(['moltbot-proxy', 'moltbot-web-proxy']);

function requestOnce(urlText) {
    const targetUrl = new URL(urlText);
    const transport = targetUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const req = transport.get(targetUrl, (res) => {
            res.resume();
            resolve({
                statusCode: Number(res.statusCode || 0),
                headers: res.headers || {},
            });
        });
        req.setTimeout(6000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
    });
}

function normalizeRedirectUrl(currentUrl, locationValue) {
    const current = new URL(currentUrl);
    const next = new URL(String(locationValue || '').trim(), current);
    if (!next.port && next.hostname === current.hostname) {
        next.port = current.port;
    }
    return next.toString();
}

function validateRedirectTarget(currentUrl, nextUrl) {
    const current = new URL(currentUrl);
    const next = new URL(nextUrl);
    const sameHost = next.hostname === current.hostname;
    const localHost = ['127.0.0.1', 'localhost'].includes(next.hostname);
    if (!sameHost && !localHost) {
        throw new Error(`redirect host mismatch: ${next.hostname}`);
    }
    if (!['http:', 'https:'].includes(next.protocol)) {
        throw new Error(`invalid redirect protocol: ${next.protocol}`);
    }
    if (current.pathname !== '/prompt' || next.pathname !== '/prompt/') {
        throw new Error(`unexpected redirect path: ${current.pathname} -> ${next.pathname}`);
    }
}

function isSuccessStatus(statusCode) {
    return statusCode >= 200 && statusCode < 300;
}

function isRedirectStatus(statusCode) {
    return statusCode >= 300 && statusCode < 400;
}

async function check(urlText, options = {}) {
    const request = typeof options.requestOnce === 'function' ? options.requestOnce : requestOnce;
    const first = await request(urlText);
    if (isSuccessStatus(first.statusCode)) {
        return {
            ok: true,
            statusCode: first.statusCode,
            finalUrl: urlText,
            redirected: false,
        };
    }
    if (!isRedirectStatus(first.statusCode)) {
        throw new Error(`HTTP ${first.statusCode}`);
    }

    const location = String(first.headers.location || '').trim();
    if (!location) throw new Error(`HTTP ${first.statusCode} missing Location`);

    const redirectedUrl = normalizeRedirectUrl(urlText, location);
    validateRedirectTarget(urlText, redirectedUrl);

    const second = await request(redirectedUrl);
    if (!isSuccessStatus(second.statusCode)) {
        throw new Error(`redirected HTTP ${second.statusCode}`);
    }

    return {
        ok: true,
        statusCode: second.statusCode,
        finalUrl: redirectedUrl,
        redirected: true,
        redirectStatusCode: first.statusCode,
    };
}

function inspectPromptWebRuntime(options = {}) {
    const spawn = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;
    const res = spawn('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}'], { encoding: 'utf8' });
    if (res.error) {
        return {
            ok: false,
            error: String(res.error.message || res.error),
        };
    }
    if (res.status !== 0) {
        return {
            ok: false,
            error: String(res.stderr || res.stdout || `docker ps exited with ${res.status}`).trim(),
        };
    }

    const runningContainers = String(res.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [name, status] = line.split('\t');
            return {
                name: String(name || '').trim(),
                status: String(status || '').trim(),
            };
        });
    const names = new Set(runningContainers.map((row) => row.name));
    const runningProxies = PROXY_CONTAINER_NAMES.filter((name) => names.has(name));

    return {
        ok: true,
        promptRunning: names.has(PROMPT_CONTAINER_NAME),
        proxyRunning: runningProxies.length > 0,
        runningProxies,
        runningContainers,
    };
}

function isLocalPromptTarget(urlText) {
    try {
        const parsed = new URL(urlText);
        return ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    } catch (_) {
        return false;
    }
}

function classifyFailure(error, urlText, options = {}) {
    const message = String(error && error.message ? error.message : error);
    const errorCode = String(error && error.code ? error.code : '').trim();
    const runtimeProbe = errorCode === 'ECONNREFUSED' && isLocalPromptTarget(urlText)
        ? (typeof options.inspectPromptWebRuntime === 'function'
            ? options.inspectPromptWebRuntime(options)
            : inspectPromptWebRuntime(options))
        : null;

    let classification = 'request_error';
    if (errorCode === 'ECONNREFUSED') classification = 'connection_refused';
    else if (errorCode === 'ETIMEDOUT' || message === 'timeout') classification = 'timeout';
    else if (/^redirect/i.test(message) || /redirect/i.test(message)) classification = 'redirect_error';
    else if (/^HTTP \d+/.test(message) || /^redirected HTTP \d+/.test(message)) classification = 'http_error';

    if (
        classification === 'connection_refused'
        && runtimeProbe
        && runtimeProbe.ok
        && runtimeProbe.promptRunning === false
        && runtimeProbe.proxyRunning === false
    ) {
        classification = 'service_absent';
    }

    return {
        classification,
        error: message,
        errorCode,
        runtime: runtimeProbe,
    };
}

async function runHealthcheck(urlText = DEFAULT_TARGET, options = {}) {
    const started = Date.now();
    try {
        const result = await check(urlText, options);
        return {
            target: urlText,
            elapsedMs: Date.now() - started,
            classification: 'healthy',
            ...result,
        };
    } catch (error) {
        return {
            ok: false,
            target: urlText,
            elapsedMs: Date.now() - started,
            ...classifyFailure(error, urlText, options),
        };
    }
}

async function main() {
    const result = await runHealthcheck(DEFAULT_TARGET);
    const serialized = JSON.stringify(result);
    if (result.ok) {
        console.log(serialized);
        return;
    }
    console.error(serialized);
    process.exit(1);
}

if (require.main === module) {
    main().catch((error) => {
        const payload = {
            ok: false,
            target: DEFAULT_TARGET,
            elapsedMs: 0,
            classification: 'request_error',
            error: String(error && error.message ? error.message : error),
            errorCode: String(error && error.code ? error.code : '').trim(),
            runtime: null,
        };
        console.error(JSON.stringify(payload));
        process.exit(1);
    });
}

module.exports = {
    DEFAULT_TARGET,
    PROMPT_CONTAINER_NAME,
    PROXY_CONTAINER_NAMES,
    requestOnce,
    normalizeRedirectUrl,
    validateRedirectTarget,
    inspectPromptWebRuntime,
    classifyFailure,
    check,
    runHealthcheck,
};
