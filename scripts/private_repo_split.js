const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PUBLIC_ROOT = path.join(__dirname, '..');
const PRIVATE_ROOT = process.env.MOLTBOT_PRIVATE_DIR || path.resolve(PUBLIC_ROOT, '../Moltbot_Private');
const PRIVATE_OWNER = process.env.MOLTBOT_PRIVATE_OWNER || 'INO95';
const PRIVATE_REPO = process.env.MOLTBOT_PRIVATE_REPO || 'moltbot-private';
const PRIVATE_FULL = `${PRIVATE_OWNER}/${PRIVATE_REPO}`;
const PRIVATE_REMOTE = `https://github.com/${PRIVATE_FULL}.git`;

const PRIVATE_PATHS = [
    'configs',
    'data',
    'logs',
    'memory',
    'reports',
    'USER.md',
    'HEARTBEAT.md',
    'crontab_moltbot.txt',
    'notes/USER_OPERATING_POLICY.md',
    'blog/_posts',
    'blog/CNAME',
];

function run(cmd, cwd) {
    return execSync(cmd, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
        .toString()
        .trim();
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(target) {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
}

function copyIntoPrivate(relPath) {
    const src = path.join(PUBLIC_ROOT, relPath);
    const dst = path.join(PRIVATE_ROOT, relPath);
    removePath(dst);
    if (!fs.existsSync(src)) return { relPath, copied: false };
    ensureDir(path.dirname(dst));
    fs.cpSync(src, dst, { recursive: true });
    return { relPath, copied: true };
}

function ensurePrivateRepoRemote() {
    try {
        run(`gh repo view ${PRIVATE_FULL}`, PUBLIC_ROOT);
    } catch {
        run(`gh repo create ${PRIVATE_FULL} --private --description "Moltbot private operational data"`, PUBLIC_ROOT);
    }
}

function ensurePrivateGit() {
    ensureDir(PRIVATE_ROOT);
    if (!fs.existsSync(path.join(PRIVATE_ROOT, '.git'))) {
        run('git init', PRIVATE_ROOT);
        run('git checkout -b main', PRIVATE_ROOT);
    }
    try {
        const remote = run('git remote get-url origin', PRIVATE_ROOT);
        if (remote !== PRIVATE_REMOTE) {
            run(`git remote set-url origin ${PRIVATE_REMOTE}`, PRIVATE_ROOT);
        }
    } catch {
        run(`git remote add origin ${PRIVATE_REMOTE}`, PRIVATE_ROOT);
    }
}

function writePrivateReadme() {
    const file = path.join(PRIVATE_ROOT, 'README.md');
    const content = [
        '# Moltbot Private Store',
        '',
        'This repository stores private runtime data and personal policy files.',
        'Do not mirror this repository to public remotes.',
        '',
        `Source workspace: ${PUBLIC_ROOT}`,
        `Managed by: scripts/private_repo_split.js`,
    ].join('\n');
    fs.writeFileSync(file, content, 'utf8');
}

function syncPrivateFiles() {
    const results = PRIVATE_PATHS.map(copyIntoPrivate);
    writePrivateReadme();
    return results;
}

function commitAndPush(message = '') {
    run('git add -A', PRIVATE_ROOT);
    const diff = run('git status --porcelain', PRIVATE_ROOT);
    if (!diff) {
        return { committed: false, pushed: false, message: 'nothing to commit' };
    }
    const msg = message || `chore: sync private data ${new Date().toISOString()}`;
    run(`git commit -m "${msg.replace(/"/g, '\\"')}"`, PRIVATE_ROOT);
    run('git push -u origin main', PRIVATE_ROOT);
    return { committed: true, pushed: true, message: msg };
}

function bootstrap() {
    ensurePrivateRepoRemote();
    ensurePrivateGit();
    const copied = syncPrivateFiles();
    const pushed = commitAndPush('chore: bootstrap private repo with operational data');
    return {
        privateRoot: PRIVATE_ROOT,
        privateRepo: PRIVATE_FULL,
        copied,
        pushed,
    };
}

function syncOnly() {
    ensurePrivateGit();
    const copied = syncPrivateFiles();
    const pushed = commitAndPush();
    return {
        privateRoot: PRIVATE_ROOT,
        privateRepo: PRIVATE_FULL,
        copied,
        pushed,
    };
}

if (require.main === module) {
    const cmd = process.argv[2] || 'sync';
    try {
        let result;
        if (cmd === 'bootstrap') {
            result = bootstrap();
        } else if (cmd === 'sync') {
            result = syncOnly();
        } else {
            throw new Error('Usage: node scripts/private_repo_split.js [bootstrap|sync]');
        }
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error(String(error.message || error));
        process.exit(1);
    }
}

module.exports = { bootstrap, syncOnly };
