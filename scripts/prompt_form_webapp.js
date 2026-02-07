const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const promptBuilder = require('./prompt_builder');

const PORT = Number(process.env.PROMPT_FORM_PORT || 4382);
const host = process.env.PROMPT_FORM_HOST || '127.0.0.1';
const staticDir = path.join(__dirname, '../web/prompt-form');

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload, null, 2));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 2 * 1024 * 1024) req.destroy(new Error('payload too large'));
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function serveIndex(res) {
    const filePath = path.join(staticDir, 'index.html');
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('prompt form index not found');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(filePath, 'utf8'));
}

async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        serveIndex(res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/prompt/session') {
        const payload = await parseBody(req);
        const baseFields = payload.fields || promptBuilder.parseFreeTextToFields(payload.raw || '');
        const session = promptBuilder.createSession(baseFields);
        sendJson(res, 200, { ok: true, session });
        return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/prompt/session/')) {
        const id = url.pathname.split('/').pop();
        const payload = await parseBody(req);
        const session = promptBuilder.updateSession(id, payload.fields || {});
        sendJson(res, 200, { ok: true, session });
        return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/prompt/finalize/')) {
        const id = url.pathname.split('/').pop();
        const result = promptBuilder.finalizeSession(id);
        sendJson(res, 200, { ok: true, result });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
}

function startServer() {
    const server = http.createServer((req, res) => {
        Promise.resolve(handler(req, res)).catch(err => {
            sendJson(res, 500, { ok: false, error: err.message });
        });
    });
    server.listen(PORT, host, () => {
        console.log(`Prompt form MVP running: http://${host}:${PORT}`);
    });
}

if (require.main === module) {
    startServer();
}

