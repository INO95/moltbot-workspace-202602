const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const healthService = require('./health_service');

const PORT = Number(process.env.HEALTH_WEB_PORT || 4383);
const HOST = process.env.HEALTH_WEB_HOST || '127.0.0.1';
const staticDir = path.join(__dirname, '../web/health-mvp');
const DB_PATH = process.env.HEALTH_DB_PATH || healthService.DEFAULT_DB_PATH;

function readText(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(String(text || ''));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy(new Error('payload too large'));
      }
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

function requiredToken() {
  return String(process.env.HEALTH_WEB_API_TOKEN || '').trim();
}

function allowNoAuth() {
  return String(process.env.HEALTH_WEB_ALLOW_NO_AUTH || '').trim().toLowerCase() === 'true';
}

function isAuthorized(req, urlObj) {
  const required = requiredToken();
  if (!required) return allowNoAuth();
  const header = String(req.headers['x-api-token'] || '').trim();
  const query = String(urlObj.searchParams.get('token') || '').trim();
  return header === required || query === required;
}

function guardAuth(req, res, urlObj) {
  if (isAuthorized(req, urlObj)) return true;
  sendJson(res, 401, { ok: false, error: 'unauthorized' });
  return false;
}

function serveIndex(res) {
  const html = readText(path.join(staticDir, 'index.html'));
  if (!html) return sendText(res, 404, 'health mvp index missing');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveCaptureImage(req, res, urlObj) {
  if (!guardAuth(req, res, urlObj)) return;
  const m = urlObj.pathname.match(/^\/api\/health\/captures\/(\d+)\/image$/);
  if (!m) return sendJson(res, 404, { ok: false, error: 'not found' });
  const captureId = Number(m[1]);
  if (!Number.isFinite(captureId)) return sendJson(res, 400, { ok: false, error: 'invalid capture id' });

  const imagePath = healthService.getCaptureImagePath(DB_PATH, captureId);
  if (!imagePath || !fs.existsSync(imagePath)) {
    return sendJson(res, 404, { ok: false, error: 'image not found' });
  }

  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif'
        : 'image/jpeg';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=300' });
  fs.createReadStream(imagePath).pipe(res);
}

async function handleApi(req, res, urlObj) {
  if (req.method === 'GET' && urlObj.pathname === '/api/health/today') {
    if (!guardAuth(req, res, urlObj)) return;
    const date = urlObj.searchParams.get('date') || undefined;
    const out = healthService.getToday(DB_PATH, date);
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/health/recovery') {
    if (!guardAuth(req, res, urlObj)) return;
    const date = urlObj.searchParams.get('date') || undefined;
    const out = healthService.getRecovery(DB_PATH, date || new Date());
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/health/sessions') {
    if (!guardAuth(req, res, urlObj)) return;
    const out = healthService.listSessions(DB_PATH, {
      from: urlObj.searchParams.get('from') || '',
      to: urlObj.searchParams.get('to') || '',
      type: urlObj.searchParams.get('type') || '',
      limit: Number(urlObj.searchParams.get('limit') || 100),
      offset: Number(urlObj.searchParams.get('offset') || 0),
    });
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/health/summary') {
    if (!guardAuth(req, res, urlObj)) return;
    const out = healthService.getSummary(DB_PATH, {
      period: urlObj.searchParams.get('period') || 'month',
      refDate: urlObj.searchParams.get('ref') || new Date(),
    });
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/health/ingest') {
    if (!guardAuth(req, res, urlObj)) return;
    try {
      const body = await parseBody(req);
      const out = healthService.ingest(DB_PATH, body || {});
      return sendJson(res, out.ok ? 200 : 422, { ok: out.ok, ...out });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error.message || error) });
    }
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/health/advice') {
    if (!guardAuth(req, res, urlObj)) return;
    try {
      const body = await parseBody(req);
      const out = healthService.generateAdvice(DB_PATH, {
        period: body.period || 'week',
        refDate: body.refDate || new Date(),
        mode: body.mode || 'rule',
      });
      return sendJson(res, 200, { ok: true, ...out });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error.message || error) });
    }
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/health/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'health-web',
      dbPath: DB_PATH,
      authMode: requiredToken() ? 'token' : (allowNoAuth() ? 'open' : 'locked'),
      ts: new Date().toISOString(),
    });
  }

  if (req.method === 'GET' && /^\/api\/health\/captures\/\d+\/image$/.test(urlObj.pathname)) {
    return serveCaptureImage(req, res, urlObj);
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

function serve(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (urlObj.pathname === '/' || urlObj.pathname === '/index.html') {
    return serveIndex(res);
  }

  if (urlObj.pathname.startsWith('/api/')) {
    return handleApi(req, res, urlObj).catch((error) => {
      sendJson(res, 500, { ok: false, error: String(error.message || error) });
    });
  }

  return sendText(res, 404, 'not found');
}

function start() {
  healthService.init(DB_PATH);
  const server = http.createServer(serve);
  server.listen(PORT, HOST, () => {
    console.log(`[health-web] listening on http://${HOST}:${PORT} (db=${DB_PATH})`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { start };
