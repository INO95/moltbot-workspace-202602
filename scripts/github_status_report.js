const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const reportDir = path.join(repoRoot, 'logs/reports');

function run(cmd) {
    return execSync(cmd, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function isGitRepo() {
    try {
        run('git rev-parse --is-inside-work-tree');
        return true;
    } catch {
        return false;
    }
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function buildGitReport() {
    if (!isGitRepo()) {
        return {
            ok: false,
            error: 'Not a git repository in current workspace.',
            text: 'Git report skipped: workspace is not initialized as a git repository.',
        };
    }

    let branch = 'unknown';
    let statusRaw = '';
    let commits = '';

    try {
        branch = run('git branch --show-current') || 'no-commits';
        statusRaw = run('git status --short');
    } catch (error) {
        return {
            ok: false,
            error: error.message,
            text: `Git report failed: ${error.message}`,
        };
    }

    try {
        commits = run('git log --pretty=format:"%h %ad %s" --date=short -n 7');
    } catch {
        commits = '';
    }

    const statusLines = statusRaw ? statusRaw.split('\n').filter(Boolean) : [];
    const trackedChanges = statusLines.filter(l => !l.startsWith('??')).length;
    const untracked = statusLines.filter(l => l.startsWith('??')).length;
    const commitLines = commits ? commits.split('\n').filter(Boolean) : [];

    const text = [
        `Branch: ${branch}`,
        `Changed files: ${statusLines.length} (tracked: ${trackedChanges}, untracked: ${untracked})`,
        'Recent commits:',
        ...(commitLines.length ? commitLines.map(c => `- ${c}`) : ['- none']),
    ].join('\n');

    return {
        ok: true,
        branch,
        changed: statusLines.length,
        trackedChanges,
        untracked,
        commits: commitLines,
        text,
    };
}

function writeGitReport() {
    ensureDir(reportDir);
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const report = buildGitReport();

    const content = [
        `# GitHub Code Report (${date})`,
        '',
        report.text,
        '',
    ].join('\n');

    const outPath = path.join(reportDir, `github-status-${date}.md`);
    fs.writeFileSync(outPath, content, 'utf8');
    return { outPath, report, content };
}

if (require.main === module) {
    const { outPath, content } = writeGitReport();
    console.log(content);
    console.log(`Saved: ${outPath}`);
}

module.exports = { buildGitReport, writeGitReport };
