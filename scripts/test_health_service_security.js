const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const health = require('./health_service');

function writeFile(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  fs.writeFileSync(target, 'x');
  return target;
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'health-sec-'));
  const uploadRoot = path.join(tmp, 'upload-inbox');
  const outsideDir = path.join(tmp, 'outside');
  const dbPath = path.join(tmp, 'health.sqlite');

  const allowedImage = writeFile(uploadRoot, 'allowed_run.png');
  const blockedOutside = writeFile(outsideDir, 'outside_run.png');
  const blockedExt = writeFile(uploadRoot, 'not_image.txt');

  const prevUploadRoot = process.env.HEALTH_UPLOAD_ROOT;
  process.env.HEALTH_UPLOAD_ROOT = uploadRoot;

  try {
    health.init(dbPath);

    const ok = health.ingest(dbPath, {
      source: 'test',
      text: 'Indoor Run 2026/01/30 Distance 5.66km 338kcal 42min',
      imagePath: allowedImage,
    });
    assert.strictEqual(ok.ok, true);
    assert.ok(ok.imagePath);
    assert.ok(fs.existsSync(ok.imagePath));

    const badOutside = health.ingest(dbPath, {
      source: 'test',
      text: 'Indoor Run 2026/01/31 Distance 5.20km 320kcal 40min',
      imagePath: blockedOutside,
    });
    assert.strictEqual(badOutside.ok, false);
    assert.ok((badOutside.missingFields || []).includes('image_path_not_allowed'));

    const badExt = health.ingest(dbPath, {
      source: 'test',
      text: 'Indoor Run 2026/02/01 Distance 4.80km 300kcal 38min',
      imagePath: blockedExt,
    });
    assert.strictEqual(badExt.ok, false);
    assert.ok((badExt.missingFields || []).includes('image_extension_not_allowed'));

    console.log('test_health_service_security: ok');
  } finally {
    if (prevUploadRoot == null) delete process.env.HEALTH_UPLOAD_ROOT;
    else process.env.HEALTH_UPLOAD_ROOT = prevUploadRoot;
  }
}

run();
