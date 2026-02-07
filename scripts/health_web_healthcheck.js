const http = require('http');

const target = process.env.HEALTH_WEB_HEALTH_URL || 'http://127.0.0.1:18788/health/api/health/health';

function check(urlText) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlText, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      if (!ok) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      res.resume();
      resolve({ ok: true, statusCode: res.statusCode });
    });
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function main() {
  const started = Date.now();
  const result = await check(target);
  const elapsedMs = Date.now() - started;
  console.log(JSON.stringify({ target, elapsedMs, ...result }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`health web healthcheck failed: ${error.message}`);
    process.exit(1);
  });
}
