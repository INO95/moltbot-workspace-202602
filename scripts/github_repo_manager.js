const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const owner = 'INO95';

const blockedPublishPaths = [
    /^configs\//,
    /^data\//,
    /^data\/secure\//,
    /^docker\/openclaw-repo(\/|$)/,
    /^\.env$/,
    /^logs\//,
    /^\.DS_Store$/,
    /^notes\/\.DS_Store$/,
];

const secretPatterns = [
    { name: 'openai_api_key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
    { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
    { name: 'google_api_key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
    { name: 'telegram_bot_token', re: /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g },
    { name: 'private_key_block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

function run(cmd, opts = {}) {
    return execSync(cmd, {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
    })
        .toString()
        .trim();
}

function sanitizeName(input) {
    return String(input || 'moltbot-workspace')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}

function defaultRepoName(project) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    return `${sanitizeName(project)}-${stamp}`;
}

function ensureGitRepo() {
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        run('git init');
    }
}

function ensureBranch(branch = 'main') {
    try {
        const current = run('git branch --show-current');
        if (!current) {
            run(`git checkout -b ${branch}`);
            return;
        }
        if (current !== branch) {
            run(`git checkout -B ${branch}`);
        }
    } catch {
        run(`git checkout -b ${branch}`);
    }
}

function getStagedFiles() {
    const out = run('git diff --cached --name-only');
    return out ? out.split('\n').filter(Boolean) : [];
}

function isBlockedPath(file) {
    return blockedPublishPaths.some(re => re.test(file));
}

function escapeForDoubleQuotes(input) {
    return String(input).replace(/(["\\$`])/g, '\\$1');
}

function isLikelyText(buffer) {
    if (!Buffer.isBuffer(buffer)) return true;
    const len = Math.min(buffer.length, 1024);
    for (let i = 0; i < len; i += 1) {
        if (buffer[i] === 0) return false;
    }
    return true;
}

function unstageBlockedFiles() {
    const staged = getStagedFiles();
    const blocked = staged.filter(isBlockedPath);
    for (const file of blocked) {
        const escaped = escapeForDoubleQuotes(file);
        try {
            run(`git restore --staged -- "${escaped}"`);
        } catch {
            // Initial commit has no HEAD; fallback removes from index only.
            run(`git rm -r -f --cached --ignore-unmatch -- "${escaped}"`);
        }
    }
    return blocked;
}

function assertNoSensitiveFilesInStaging() {
    const staged = getStagedFiles();
    const blocked = staged.filter(isBlockedPath);
    if (blocked.length > 0) {
        throw new Error(`Sensitive paths staged: ${blocked.join(', ')}`);
    }

    const findings = [];
    for (const file of staged) {
        const fullPath = path.join(repoRoot, file);
        if (!fs.existsSync(fullPath)) continue;
        const stat = fs.statSync(fullPath);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;

        const buf = fs.readFileSync(fullPath);
        if (!isLikelyText(buf)) continue;
        const text = buf.toString('utf8');

        for (const rule of secretPatterns) {
            const m = text.match(rule.re);
            if (!m || m.length === 0) continue;
            findings.push(`${file}:${rule.name}`);
        }
    }

    if (findings.length > 0) {
        throw new Error(`Potential secret patterns detected in staged files: ${findings.join(', ')}`);
    }
}

function plan(project) {
    const repo = defaultRepoName(project);
    return {
        owner,
        visibility: 'public',
        repo,
        fullName: `${owner}/${repo}`,
    };
}

function ensureRemote(project) {
    const p = plan(project);
    ensureGitRepo();
    ensureBranch('main');

    const hasGh = (() => {
        try {
            run('gh --version');
            return true;
        } catch {
            return false;
        }
    })();
    if (!hasGh) {
        throw new Error('gh CLI not found. Install GitHub CLI first.');
    }

    try {
        run(`gh repo view ${p.fullName}`);
    } catch {
        run(`gh repo create ${p.fullName} --public --source . --remote origin`);
    }

    try {
        const remote = run('git remote get-url origin');
        return { ...p, remote };
    } catch {
        run(`git remote add origin git@github.com:${p.fullName}.git`);
        const remote = run('git remote get-url origin');
        return { ...p, remote };
    }
}

function autoCommit(message = '') {
    ensureGitRepo();
    run('git reset');
    run('git add .');
    const skipped = unstageBlockedFiles();
    assertNoSensitiveFilesInStaging();
    const commitMsg = message || `chore: automated update ${new Date().toISOString()}`;
    try {
        run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
        return { committed: true, message: commitMsg, skipped };
    } catch (error) {
        const out = String(error.stderr || error.message || '');
        if (/nothing to commit/i.test(out)) {
            return { committed: false, message: 'nothing to commit', skipped };
        }
        throw error;
    }
}

function pushMain() {
    ensureGitRepo();
    ensureBranch('main');
    run('git push -u origin main');
    return { pushed: true, branch: 'main' };
}

if (require.main === module) {
    const [, , cmd, ...rest] = process.argv;
    const arg = rest.join(' ').trim();

    try {
        if (cmd === 'plan') {
            console.log(JSON.stringify(plan(arg), null, 2));
        } else if (cmd === 'ensure') {
            console.log(JSON.stringify(ensureRemote(arg), null, 2));
        } else if (cmd === 'commit') {
            console.log(JSON.stringify(autoCommit(arg), null, 2));
        } else if (cmd === 'push') {
            console.log(JSON.stringify(pushMain(), null, 2));
        } else {
            console.log('Usage: node scripts/github_repo_manager.js plan|ensure|commit|push [arg]');
            process.exit(1);
        }
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

module.exports = { plan, ensureRemote, autoCommit, pushMain };
