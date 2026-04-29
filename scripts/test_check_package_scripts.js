const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkPackageScripts } = require('./check_package_scripts');

function writeFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'x', 'utf8');
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-package-scripts-'));
  try {
    writeFile(path.join(root, 'scripts', 'good.js'));
    writeFile(path.join(root, 'scripts', 'ok.sh'));
    fs.mkdirSync(path.join(root, 'packages'), { recursive: true });

    const good = checkPackageScripts({
      root,
      packageJson: {
        scripts: {
          good: 'node scripts/good.js && npm run -s child',
          child: 'bash scripts/ok.sh',
        },
        workspaces: ['packages/*'],
      },
    });
    assert.strictEqual(good.ok, true);

    const bad = checkPackageScripts({
      root,
      packageJson: {
        scripts: {
          bad: 'node scripts/missing.js && node apps/bot/src/main.js && npm run -s nope',
        },
        workspaces: ['apps/*', 'missing/*'],
      },
    });
    const issueTypes = new Set(bad.issues.map((issue) => issue.type));
    assert.strictEqual(bad.ok, false);
    assert.ok(issueTypes.has('missing_script_file'));
    assert.ok(issueTypes.has('apps_ref_not_allowed'));
    assert.ok(issueTypes.has('missing_npm_script'));
    assert.ok(issueTypes.has('apps_workspace_not_allowed'));
    assert.ok(issueTypes.has('missing_workspace_base'));

    console.log('test_check_package_scripts: ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
