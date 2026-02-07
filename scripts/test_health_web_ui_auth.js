const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const file = path.join(__dirname, '../web/health-mvp/index.html');
  const html = fs.readFileSync(file, 'utf8');

  assert.ok(html.includes('id="tokenSaveBtn"'), 'token save button missing');
  assert.ok(html.includes('id="tokenClearBtn"'), 'token clear button missing');
  assert.ok(html.includes('id="tokenStatus"'), 'token status placeholder missing');
  assert.ok(html.includes('401 인증 실패'), '401 auth guidance message missing');

  console.log('test_health_web_ui_auth: ok');
}

run();
