const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POSTS_ROOT = path.join(ROOT, 'blog', '_posts');
const POLICY_PATH = path.join(ROOT, 'policies', 'backlink_sources.json');
const TRACKER_PATH = path.join(ROOT, 'data', 'backlink_outreach_tracker.json');
const PLAN_JSON = path.join(ROOT, 'logs', 'backlink_plan_latest.json');
const PLAN_MD = path.join(ROOT, 'logs', 'backlink_plan_latest.md');

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

function loadPolicy() {
  if (!fs.existsSync(POLICY_PATH)) return { safeMode: true, channels: [] };
  try {
    return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  } catch {
    return { safeMode: true, channels: [] };
  }
}

function loadTracker() {
  if (!fs.existsSync(TRACKER_PATH)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf8'));
  } catch {
    return { entries: [] };
  }
}

function saveTracker(tracker) {
  fs.writeFileSync(TRACKER_PATH, JSON.stringify(tracker, null, 2), 'utf8');
}

function collectPosts(limit = 20) {
  const files = listMarkdownFiles(POSTS_ROOT)
    .filter((f) => !f.includes('/2014-3-3-Hello-World.md'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit);

  return files.map((file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const { frontmatter, body } = parseFrontMatter(raw);
    return {
      file,
      relFile: path.relative(ROOT, file),
      slug: path.basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, ''),
      title: frontmatter.title || path.basename(file, '.md'),
      categories: String(frontmatter.categories || '').split(/[\s,]+/).filter(Boolean),
      summary: String(body || '').replace(/\n+/g, ' ').slice(0, 220),
      updatedAt: new Date(fs.statSync(file).mtimeMs).toISOString(),
    };
  });
}

function chooseChannels(post, channels) {
  const hay = `${post.title} ${(post.categories || []).join(' ')}`.toLowerCase();
  const picked = channels.filter((c) => {
    const keys = Array.isArray(c.categoryKeywords) ? c.categoryKeywords : [];
    return keys.some((k) => hay.includes(String(k).toLowerCase()));
  });
  return picked.length ? picked : channels.slice(0, 2);
}

function runPlan() {
  const policy = loadPolicy();
  const posts = collectPosts(24);
  const items = posts.map((post) => {
    const channels = chooseChannels(post, policy.channels || []);
    return {
      slug: post.slug,
      title: post.title,
      file: post.relFile,
      channels: channels.map((c) => ({ name: c.name, type: c.type, notes: c.notes || '' })),
      note: '자동 발송 금지. 채널별 초안 생성 후 수동 승인/게시.',
    };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    safeMode: policy.safeMode !== false,
    totalPosts: posts.length,
    items,
  };
  fs.writeFileSync(PLAN_JSON, JSON.stringify(result, null, 2), 'utf8');

  const md = [];
  md.push(`# Backlink Plan (${result.generatedAt})`);
  md.push('');
  md.push(`- Safe mode: ${result.safeMode ? 'ON' : 'OFF'}`);
  md.push(`- Total posts analyzed: ${result.totalPosts}`);
  md.push('- Policy: 자동 발송/자동 게시 없음 (수동 승인 필수)');
  md.push('');
  md.push('## Outreach Candidates');
  for (const item of items.slice(0, 20)) {
    md.push(`- ${item.title} (${item.slug})`);
    md.push(`  - file: ${item.file}`);
    md.push(`  - channels: ${item.channels.map((c) => `${c.name}(${c.type})`).join(', ')}`);
    md.push(`  - note: ${item.note}`);
  }
  fs.writeFileSync(PLAN_MD, md.join('\n'), 'utf8');

  console.log(JSON.stringify({ ok: true, planJson: PLAN_JSON, planMd: PLAN_MD, total: result.totalPosts }, null, 2));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function makeDraft() {
  const args = parseArgs(process.argv);
  const slug = String(args.post || '').trim();
  const target = String(args.target || '').trim();
  const contact = String(args.contact || '').trim();
  if (!slug || !target) {
    throw new Error('Usage: node scripts/backlink_outreach_bot.js draft --post <slug> --target <channel> [--contact <name>]');
  }

  const posts = collectPosts(200);
  const post = posts.find((p) => p.slug === slug || p.relFile.includes(slug));
  if (!post) throw new Error(`post not found: ${slug}`);

  const now = new Date();
  const id = `outreach_${Date.now()}`;
  const title = `[아웃리치 초안] ${post.title} -> ${target}`;
  const body = [
    `안녕하세요${contact ? ` ${contact}님` : ''}.`,
    '',
    `최근 작성한 글 "${post.title}"를 공유드립니다.`,
    '내용은 AI 자동화/운영 개선 경험을 실무 관점에서 정리한 글입니다.',
    '',
    '핵심 포인트:',
    '- 운영 자동화에서의 비용/안정성 트레이드오프',
    '- 실서비스 반영 과정에서의 실패/개선 루프',
    '- 재현 가능한 스크립트/운영 규칙',
    '',
    '검토 후 공유/소개가 가능하시면 감사하겠습니다.',
    '',
    '원문 링크: <블로그 링크 삽입>',
    '감사합니다.'
  ].join('\n');

  const outDir = path.join(ROOT, 'logs', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${id}.md`);
  fs.writeFileSync(outFile, `# ${title}\n\n${body}\n`, 'utf8');

  const tracker = loadTracker();
  tracker.entries = Array.isArray(tracker.entries) ? tracker.entries : [];
  tracker.entries.push({
    id,
    createdAt: now.toISOString(),
    post: post.slug,
    target,
    contact,
    status: 'drafted',
    draftFile: path.relative(ROOT, outFile),
  });
  saveTracker(tracker);

  console.log(JSON.stringify({ ok: true, id, draftFile: outFile, status: 'drafted' }, null, 2));
}

function showStatus() {
  const tracker = loadTracker();
  const entries = Array.isArray(tracker.entries) ? tracker.entries : [];
  const by = {};
  for (const e of entries) by[e.status] = (by[e.status] || 0) + 1;
  console.log(JSON.stringify({ ok: true, total: entries.length, byStatus: by, recent: entries.slice(-10) }, null, 2));
}

function markStatus() {
  const args = parseArgs(process.argv);
  const id = String(args.id || '').trim();
  const status = String(args.status || '').trim();
  if (!id || !status) throw new Error('Usage: node scripts/backlink_outreach_bot.js mark --id <id> --status <drafted|sent|accepted|declined>');
  const tracker = loadTracker();
  const entries = Array.isArray(tracker.entries) ? tracker.entries : [];
  const hit = entries.find((e) => e.id === id);
  if (!hit) throw new Error(`id not found: ${id}`);
  hit.status = status;
  hit.updatedAt = new Date().toISOString();
  saveTracker(tracker);
  console.log(JSON.stringify({ ok: true, id, status }, null, 2));
}

if (require.main === module) {
  const cmd = process.argv[2] || 'plan';
  try {
    if (cmd === 'plan') runPlan();
    else if (cmd === 'draft') makeDraft();
    else if (cmd === 'status') showStatus();
    else if (cmd === 'mark') markStatus();
    else throw new Error('Unknown command. Use: plan|draft|status|mark');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { runPlan };
