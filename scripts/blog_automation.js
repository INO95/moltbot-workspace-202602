/**
 * GitHub 블로그 자동 포스팅 시스템
 * - AI 활용 기록을 한국어/영어/일본어로 자동 번역
 * - Markdown 포스트 생성
 * - GitHub Pages로 자동 배포
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { translateWithCodex } = require('./codex_oauth_translate');

class BlogAutomation {
    constructor() {
        this.blogDir = path.join(__dirname, '../blog');
        this.postsDir = path.join(this.blogDir, '_posts');

        // 지원 언어
        this.languages = {
            ko: { name: '한국어', dir: 'ko' },
            ja: { name: '日本語', dir: 'ja' },
            en: { name: 'English', dir: 'en' }
        };
    }

    // 블로그 디렉토리 초기화
    initBlogStructure() {
        if (!fs.existsSync(this.blogDir)) {
            fs.mkdirSync(this.blogDir, { recursive: true });
        }

        // 각 언어별 포스트 디렉토리
        for (const [code, lang] of Object.entries(this.languages)) {
            const langPostsDir = path.join(this.postsDir, lang.dir);
            if (!fs.existsSync(langPostsDir)) {
                fs.mkdirSync(langPostsDir, { recursive: true });
            }
        }

        // Jekyll _config.yml 생성
        const configPath = path.join(this.blogDir, '_config.yml');
        if (!fs.existsSync(configPath)) {
            fs.writeFileSync(configPath, `
title: Moltbot AI Portfolio
description: AI-powered productivity and self-improvement journey
baseurl: ""
url: "https://ino95.github.io"
theme: minima
plugins:
  - jekyll-feed
  - jekyll-seo-tag
defaults:
  - scope:
      path: ""
    values:
      layout: "default"
`.trim());
        } else {
            const raw = fs.readFileSync(configPath, 'utf8');
            const next = raw.replace(/url:\s*".*"/, 'url: "https://ino95.github.io"');
            if (next !== raw) fs.writeFileSync(configPath, next, 'utf8');
        }

        console.log('📁 Blog structure initialized');
    }

    // AI 활용 기록을 3개 국어로 포스트 생성
    async createMultilingualPost(title, contentKo, tags = []) {
        this.initBlogStructure();

        const date = new Date().toISOString().split('T')[0];
        const slug = this.slugify(title);

        // Codex OAuth 번역 우선, 실패 시 안전 폴백.
        const translations = {
            ko: { title, content: contentKo },
            ja: await this.translateOrFallback('Japanese', title, contentKo),
            en: await this.translateOrFallback('English', title, contentKo),
        };

        const createdPosts = [];

        for (const [langCode, translation] of Object.entries(translations)) {
            const langDir = this.languages[langCode].dir;
            const filename = `${date}-${slug}.md`;
            const filepath = path.join(this.postsDir, langDir, filename);

            const frontMatter = `---
layout: post
title: "${translation.title}"
date: ${date}
categories: [ai, automation]
tags: [${tags.join(', ')}]
lang: ${langCode}
---

`;
            const fullContent = frontMatter + translation.content;
            fs.writeFileSync(filepath, fullContent);
            createdPosts.push(filepath);
            console.log(`📝 Created: ${filepath}`);
        }

        return createdPosts;
    }

    async translateOrFallback(targetLang, title, contentKo) {
        // 1. Try local Codex Proxy first (port 3000)
        try {
            const translated = await this.translateWithLocalProxy(targetLang, title, contentKo);
            if (translated.title && translated.content) {
                console.log(`✅ Translated to ${targetLang} via local proxy`);
                return translated;
            }
        } catch (localErr) {
            console.log(`⚠️ Local proxy failed: ${localErr.message}`);
        }

        // 2. Try Docker-based translation
        try {
            const translated = translateWithCodex({
                sourceLang: 'Korean',
                targetLang,
                title,
                content: contentKo,
                thinking: 'high',
            });
            if (translated.title && translated.content) {
                console.log(`✅ Translated to ${targetLang} via Docker`);
                return { title: translated.title, content: translated.content };
            }
            throw new Error('empty translation');
        } catch (error) {
            console.log(`❌ Translation failed: ${error.message}`);
            const langTag = targetLang === 'Japanese' ? 'JA' : 'EN';
            const notice = targetLang === 'Japanese'
                ? '*번역 실패로 한국어 원문을 첨부합니다.*'
                : '*Translation failed; original Korean text is attached.*';
            return {
                title: `[${langTag}] ${title}`,
                content: `${notice}\n\n${contentKo}\n\n<!-- translation_error: ${String(error.message || '').replace(/-->/g, '')} -->`,
            };
        }
    }

    // Local Codex Proxy를 사용한 번역
    async translateWithLocalProxy(targetLang, title, content) {
        const http = require('http');
        const prompt = `Translate the following Korean text to ${targetLang}. Preserve markdown formatting. Return JSON with "title" and "content" keys only.

Input:
Title: ${title}
Content:
${content}

Output (JSON only):`;

        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                messages: [{ role: 'user', content: prompt }],
                model: 'gpt-4'
            });

            const req = http.request({
                hostname: 'localhost', port: 3000,
                path: '/v1/chat/completions', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                timeout: 30000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const text = json.choices?.[0]?.message?.content || '';
                        const match = text.match(/\{[\s\S]*\}/);
                        if (match) {
                            const result = JSON.parse(match[0]);
                            resolve({ title: result.title, content: result.content });
                        } else reject(new Error('No JSON in response'));
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(postData);
            req.end();
        });
    }

    // URL-friendly slug 생성
    slugify(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s가-힣ぁ-んァ-ン一-龯-]/g, '')
            .replace(/\s+/g, '-')
            .slice(0, 50);
    }

    // Git push (GitHub Pages 배포)
    async deployToGitHub() {
        try {
            const sync = this.syncBlogRepo();
            const cwd = this.blogDir;
            const repoUrl = sync.repoUrl;
            const defaultBranch = sync.branch;

            this.runGit(cwd, 'git add .');
            const hasChanges = this.runGit(cwd, 'git status --porcelain');
            if (!hasChanges.trim()) {
                return {
                    deployed: false,
                    skipped: true,
                    reason: 'no_blog_changes',
                    remote: repoUrl,
                    branch: defaultBranch,
                };
            }
            this.runGit(cwd, `git commit -m "Auto-post: ${new Date().toISOString()}"`);
            this.pushWithRetry(cwd, defaultBranch);
            console.log('🚀 Deployed to GitHub Pages');
            return {
                deployed: true,
                skipped: false,
                remote: repoUrl,
                branch: defaultBranch,
            };

        } catch (error) {
            console.error('Git error:', error.message);
            return { deployed: false, skipped: false, error: error.message };
        }
    }

    syncBlogRepo() {
        const cwd = this.blogDir;
        const owner = this.resolveGitHubOwner();
        const repoName = `${owner.toLowerCase()}.github.io`;
        const fullName = `${owner}/${repoName}`;
        const repoUrl = `https://github.com/${fullName}.git`;
        const defaultBranch = this.ensureBlogRemote(fullName, repoUrl);

        if (!fs.existsSync(path.join(cwd, '.git'))) {
            execSync('git init', { cwd });
            console.log('📦 Git repository initialized');
        }
        this.prepareBranchForRemote(cwd, defaultBranch);
        return { owner, fullName, repoUrl, branch: defaultBranch };
    }

    // 일일 AI 활용 기록 자동 생성
    async logDailyAIUsage(activities) {
        const date = new Date().toLocaleDateString('ko-KR', {
            year: 'numeric', month: 'long', day: 'numeric'
        });

        let content = `# ${date} AI 활용 기록\n\n`;
        content += `## 📊 오늘의 활동\n\n`;

        for (const activity of activities) {
            content += `### ${activity.title}\n`;
            content += `- **시간**: ${activity.time}\n`;
            content += `- **도구**: ${activity.tool}\n`;
            content += `- **결과**: ${activity.result}\n\n`;
        }

        content += `---\n*이 포스트는 Moltbot에 의해 자동 생성되었습니다.*\n`;

        return await this.createMultilingualPost(
            `AI 활용 일지 - ${date}`,
            content,
            ['daily-log', 'automation', 'productivity']
        );
    }

    runGit(cwd, command) {
        return execSync(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
    }

    hasGitCommit(cwd) {
        try {
            this.runGit(cwd, 'git rev-parse --verify HEAD');
            return true;
        } catch {
            return false;
        }
    }

    remoteBranchExists(cwd, branch) {
        try {
            const out = this.runGit(cwd, `git ls-remote --heads origin ${branch}`);
            return Boolean(out && out.trim());
        } catch {
            return false;
        }
    }

    hasMergeBase(cwd, refA, refB) {
        try {
            this.runGit(cwd, `git merge-base ${refA} ${refB}`);
            return true;
        } catch {
            return false;
        }
    }

    stashWorkingTree(cwd) {
        const dirty = this.runGit(cwd, 'git status --porcelain');
        if (!dirty.trim()) return null;
        const name = `moltbot-temp-${Date.now()}`;
        this.runGit(cwd, `git stash push --include-untracked -m "${name}"`);
        return name;
    }

    popStashByName(cwd, name) {
        if (!name) return;
        const list = this.runGit(cwd, 'git stash list');
        const entry = list
            .split('\n')
            .map(x => x.trim())
            .find(x => x.includes(name));
        if (!entry) return;
        const id = entry.split(':')[0];
        this.runGit(cwd, `git stash pop ${id}`);
    }

    prepareBranchForRemote(cwd, branch) {
        const remoteBranch = `origin/${branch}`;
        const hasRemoteBranch = this.remoteBranchExists(cwd, branch);
        if (hasRemoteBranch) {
            this.runGit(cwd, `git fetch origin ${branch}`);
        }

        if (!this.hasGitCommit(cwd)) {
            if (hasRemoteBranch) {
                this.runGit(cwd, `git checkout -B ${branch} ${remoteBranch}`);
            } else {
                this.runGit(cwd, `git checkout --orphan ${branch}`);
            }
            return;
        }

        if (!hasRemoteBranch) {
            this.runGit(cwd, `git checkout -B ${branch}`);
            return;
        }

        if (this.hasMergeBase(cwd, 'HEAD', remoteBranch)) {
            this.runGit(cwd, `git checkout -B ${branch}`);
            return;
        }

        const stashName = this.stashWorkingTree(cwd);
        this.runGit(cwd, `git checkout -B ${branch} ${remoteBranch}`);
        this.popStashByName(cwd, stashName);
    }

    pushWithRetry(cwd, branch) {
        try {
            this.runGit(cwd, `git push -u origin ${branch}`);
        } catch (error) {
            const msg = String(error.message || '');
            const needsRetry =
                /fetch first|non-fast-forward|failed to push/i.test(msg);
            if (!needsRetry) throw error;
            this.runGit(cwd, `git fetch origin ${branch}`);
            this.runGit(cwd, `git rebase origin/${branch}`);
            this.runGit(cwd, `git push -u origin ${branch}`);
        }
    }

    resolveGitHubOwner() {
        try {
            return this.runGit(process.cwd(), 'gh api user -q .login');
        } catch {
            return 'INO95';
        }
    }

    ensureBlogRemote(fullName, repoUrl) {
        const cwd = this.blogDir;
        let branch = 'main';
        try {
            const infoRaw = this.runGit(
                process.cwd(),
                `gh repo view ${fullName} --json defaultBranchRef,name,url,visibility`,
            );
            const info = JSON.parse(infoRaw);
            branch = (info.defaultBranchRef && info.defaultBranchRef.name) || 'main';
        } catch {
            this.runGit(process.cwd(), `gh repo create ${fullName} --public --disable-wiki --description "Moltbot AI logs blog"`);
            branch = 'main';
        }

        if (!fs.existsSync(path.join(cwd, '.git'))) {
            execSync('git init', { cwd });
        }

        let remote = '';
        try {
            remote = this.runGit(cwd, 'git remote get-url origin');
        } catch {
            // no-op
        }
        if (!remote) {
            this.runGit(cwd, `git remote add origin ${repoUrl}`);
        } else if (remote !== repoUrl) {
            this.runGit(cwd, `git remote set-url origin ${repoUrl}`);
        }
        return branch;
    }
}

module.exports = new BlogAutomation();

// 테스트
if (require.main === module) {
    const blog = new BlogAutomation();
    blog.initBlogStructure();

    blog.logDailyAIUsage([
        { title: '가계부 자동화', time: '09:00', tool: 'Antigravity', result: '성공' },
        { title: '건강 대시보드 생성', time: '14:00', tool: 'Codex', result: '성공' }
    ]).then(posts => {
        console.log('Created posts:', posts);
    });
}
