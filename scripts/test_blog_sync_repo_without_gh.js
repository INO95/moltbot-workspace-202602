const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { BlogAutomation } = require('./blog_automation');

function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
}

function runTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moltbot-blog-sync-'));
  try {
    run('git init -b main', tempRoot);
    run('git remote add origin https://github.com/example/example.github.io.git', tempRoot);

    const blog = new BlogAutomation();
    blog.blogDir = tempRoot;
    blog.postsDir = path.join(tempRoot, '_posts');
    blog.getRemoteHeadBranch = () => '';
    blog.remoteBranchExists = () => false;

    let ghCalled = false;
    const originalRunGit = blog.runGit.bind(blog);
    blog.runGit = (cwd, command) => {
      if (String(command || '').startsWith('gh ')) {
        ghCalled = true;
        throw new Error('gh unavailable');
      }
      return originalRunGit(cwd, command);
    };

    const res = blog.syncBlogRepo();
    assert.strictEqual(ghCalled, false, 'syncBlogRepo should not call gh when origin already exists');
    assert.strictEqual(typeof res.repoUrl, 'string');
    assert.ok(res.repoUrl.includes('github.com/example/example.github.io.git'));
    assert.strictEqual(res.branch, 'main');

    console.log('test_blog_sync_repo_without_gh: ok');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

runTest();
