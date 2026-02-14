const http = require('http');
const { URL } = require('url');

const target = process.env.PROMPT_WEB_HEALTH_URL || 'http://127.0.0.1:18788/prompt';

function requestOnce(urlText) {
    return new Promise((resolve, reject) => {
        const req = http.get(urlText, (res) => {
            res.resume();
            resolve({
                statusCode: Number(res.statusCode || 0),
                headers: res.headers || {},
            });
        });
        req.setTimeout(6000, () => req.destroy(new Error('timeout')));
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
    const okPath = next.pathname === '/' || next.pathname === '/prompt' || next.pathname === '/prompt/';
    if (!okPath) {
        throw new Error(`unexpected redirect path: ${next.pathname}`);
    }
}

async function check(urlText) {
    const first = await requestOnce(urlText);
    if (first.statusCode >= 200 && first.statusCode < 500) {
        return { ok: true, statusCode: first.statusCode, finalUrl: urlText, redirected: false };
    }
    if (first.statusCode >= 300 && first.statusCode < 400) {
        const location = String(first.headers.location || '').trim();
        if (!location) throw new Error(`HTTP ${first.statusCode} missing Location`);
        const redirectedUrl = normalizeRedirectUrl(urlText, location);
        validateRedirectTarget(urlText, redirectedUrl);
        const second = await requestOnce(redirectedUrl);
        if (second.statusCode >= 200 && second.statusCode < 300) {
            return {
                ok: true,
                statusCode: second.statusCode,
                finalUrl: redirectedUrl,
                redirected: true,
            };
        }
        if (second.statusCode >= 300 && second.statusCode < 500) {
            return {
                ok: true,
                statusCode: second.statusCode,
                finalUrl: redirectedUrl,
                redirected: true,
            };
        }
        throw new Error(`redirected HTTP ${second.statusCode}`);
    }
    throw new Error(`HTTP ${first.statusCode}`);
}

async function main() {
    const started = Date.now();
    const result = await check(target);
    const elapsedMs = Date.now() - started;
    console.log(JSON.stringify({ target, elapsedMs, ...result }));
}

if (require.main === module) {
    main().catch(error => {
        console.error(`prompt web healthcheck failed: ${error.message}`);
        process.exit(1);
    });
}
