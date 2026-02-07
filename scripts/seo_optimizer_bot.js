const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POSTS_ROOT = path.join(ROOT, 'blog', '_posts');
const REPORT_JSON = path.join(ROOT, 'logs', 'seo_audit_latest.json');
const REPORT_MD = path.join(ROOT, 'logs', 'seo_audit_latest.md');

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of fs.readdirSync(cur)) {
      const full = path.join(cur, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && full.endsWith('.md')) out.push(full);
    }
  }
  return out;
}

function parseFrontMatter(markdown) {
  const raw = String(markdown || '');
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw };
  const idx = raw.indexOf('\n---\n', 4);
  if (idx < 0) return { frontmatter: {}, body: raw };
  const fmRaw = raw.slice(4, idx);
  const body = raw.slice(idx + 5);
  const fm = {};
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!m) continue;
    fm[m[1]] = m[2].trim();
  }
  return { frontmatter: fm, body };
}

function countWords(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function countHeaders(text, level = 2) {
  const re = new RegExp(`^${'#'.repeat(level)}\\s+`, 'gm');
  const m = String(text || '').match(re);
  return m ? m.length : 0;
}

function countLinks(text) {
  const m = String(text || '').match(/\[[^\]]+\]\(([^)]+)\)/g);
  return m ? m.length : 0;
}

function countInternalLinks(text) {
  const m = String(text || '').match(/\[[^\]]+\]\((\/[^)]+|\.?\.?\/[^)]+)\)/g);
  return m ? m.length : 0;
}

function scorePost(post) {
  const issues = [];
  let score = 100;

  const title = String(post.frontmatter.title || '').trim();
  if (!title) {
    issues.push('title 누락');
    score -= 20;
  } else if (title.length < 18 || title.length > 70) {
    issues.push(`title 길이 권장 범위 벗어남 (${title.length})`);
    score -= 8;
  }

  const description = String(post.frontmatter.description || '').trim();
  if (!description) {
    issues.push('description 누락');
    score -= 16;
  } else if (description.length < 50 || description.length > 160) {
    issues.push(`description 길이 권장 범위 벗어남 (${description.length})`);
    score -= 8;
  }

  const categories = String(post.frontmatter.categories || '').trim();
  if (!categories) {
    issues.push('categories 누락');
    score -= 8;
  }

  if (post.wordCount < 180) {
    issues.push(`본문 길이 부족 (${post.wordCount} words)`);
    score -= 10;
  }
  if (post.h2Count < 1) {
    issues.push('H2 헤더 없음');
    score -= 6;
  }
  if (post.internalLinks < 1) {
    issues.push('내부 링크 없음');
    score -= 6;
  }
  if (post.totalLinks < 1) {
    issues.push('링크 없음');
    score -= 4;
  }

  return { score: Math.max(0, score), issues };
}

function buildActionItems(issues) {
  const actions = [];
  if (issues.some((i) => i.includes('title'))) actions.push('제목 길이를 18~70자로 조정');
  if (issues.some((i) => i.includes('description'))) actions.push('description을 50~160자로 작성');
  if (issues.includes('categories 누락')) actions.push('카테고리(frontmatter categories) 지정');
  if (issues.some((i) => i.includes('본문 길이 부족'))) actions.push('본문 보강(핵심/결과/회고 섹션 추가)');
  if (issues.includes('H2 헤더 없음')) actions.push('최소 1개 이상의 H2 추가');
  if (issues.includes('내부 링크 없음')) actions.push('관련 이전 글 내부 링크 1개 이상 추가');
  return [...new Set(actions)];
}

function runAudit() {
  const files = listMarkdownFiles(POSTS_ROOT);
  const rows = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const { frontmatter, body } = parseFrontMatter(raw);
    const row = {
      file,
      slug: path.basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, ''),
      lang: file.includes('/ko/') ? 'ko' : file.includes('/ja/') ? 'ja' : file.includes('/en/') ? 'en' : 'unknown',
      frontmatter,
      wordCount: countWords(body),
      h2Count: countHeaders(body, 2),
      totalLinks: countLinks(body),
      internalLinks: countInternalLinks(body),
    };
    const scored = scorePost(row);
    row.score = scored.score;
    row.issues = scored.issues;
    row.actions = buildActionItems(row.issues);
    rows.push(row);
  }

  rows.sort((a, b) => a.score - b.score);
  const avg = rows.length ? (rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;
  const critical = rows.filter((r) => r.score < 70).length;

  const result = {
    generatedAt: new Date().toISOString(),
    totalPosts: rows.length,
    avgScore: Number(avg.toFixed(2)),
    criticalCount: critical,
    topFixTargets: rows.slice(0, 10).map((r) => ({
      file: path.relative(ROOT, r.file),
      score: r.score,
      issues: r.issues,
      actions: r.actions,
    })),
    rows: rows.map((r) => ({
      file: path.relative(ROOT, r.file),
      lang: r.lang,
      score: r.score,
      wordCount: r.wordCount,
      h2Count: r.h2Count,
      internalLinks: r.internalLinks,
      totalLinks: r.totalLinks,
      issues: r.issues,
      actions: r.actions,
    })),
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(result, null, 2), 'utf8');

  const md = [];
  md.push(`# SEO Audit (${result.generatedAt})`);
  md.push('');
  md.push(`- Total posts: ${result.totalPosts}`);
  md.push(`- Avg score: ${result.avgScore}`);
  md.push(`- Critical (<70): ${result.criticalCount}`);
  md.push('');
  md.push('## Top Fix Targets');
  for (const t of result.topFixTargets) {
    md.push(`- ${t.file} | score ${t.score}`);
    if (t.issues.length) md.push(`  - issues: ${t.issues.join(' / ')}`);
    if (t.actions.length) md.push(`  - actions: ${t.actions.join(' / ')}`);
  }
  fs.writeFileSync(REPORT_MD, md.join('\n'), 'utf8');

  console.log(JSON.stringify({ ok: true, reportJson: REPORT_JSON, reportMd: REPORT_MD, avgScore: result.avgScore, critical: result.criticalCount }, null, 2));
}

if (require.main === module) {
  runAudit();
}

module.exports = { runAudit };
