const path = require('path');
const blogAutomation = require('./blog_automation');
const { syncBlogMemoToNotion } = require('./notion_blog_sync');

function shouldSyncToNotion(category, lang) {
    return category === 'project' && lang === 'en';
}

function parseArgs(argv) {
    return {
        skipTranslation: argv.includes('--skip-translation'),
    };
}

function buildPortfolioContent() {
    const dateLabel = new Date().toLocaleDateString('en-US');
    return [
        '# Anki x OpenClaw Integration Portfolio',
        '',
        '![Anki OpenClaw Flow](/images/portfolio/anki-openclaw-flow.svg)',
        '',
        '![Anki OpenClaw Metrics](/images/portfolio/anki-openclaw-metrics.svg)',
        '',
        '## 1) Goal',
        '- Store vocabulary into Anki `TOEIC_AI` from Telegram messages automatically.',
        '- Handle both single-word and multi-word batches (newline-delimited) safely.',
        '- Make failures traceable and reduce retry overhead during operation.',
        '',
        '## 2) Current Flow',
        '1. Telegram 메시지 수신',
        '2. OpenClaw bridge routing (`학습:` / `단어:`)',
        '3. Vocabulary parsing (newline-first, comma fallback)',
        '4. Meaning/example enrichment per term',
        '5. Card creation via AnkiConnect',
        '6. Summary reply after batch save completes',
        '',
        '## 3) Design Highlights',
        '- Cost efficiency: lightweight routes on fast models, complex jobs on codex route.',
        '- Reliability: AnkiConnect host fallback (`host.docker.internal -> 127.0.0.1 -> localhost`).',
        '- Input robustness: literal `\\\\n` converted into real newlines for batch parsing.',
        '- Operability: immediate Telegram feedback with failure reason and failed terms.',
        '',
        '## 4) Issues Resolved',
        '- Fixed merged-card bug by enforcing newline tokenization.',
        '- Fixed empty-meaning bug with dictionary lookup and TOEIC fallback.',
        '- Fixed missing external test link with explicit link route and URL rewrite logic.',
        '',
        '## 5) Operator Guide',
        '- Single term: `학습: be willing to`',
        '- Batch terms: send one term per line.',
        '- Status checks: `상태:` or `운영: 액션: 상태; 대상: all`.',
        '- Public links: `링크: 프롬프트`.',
        '',
        '## 6) Security & Data Policy',
        '- Sensitive tokens are managed in `.env` and private repositories only.',
        '- Public repositories exclude operational data, PII, and secrets.',
        '- External message delivery remains under explicit approval boundaries.',
        '',
        '## 7) Next Steps',
        '- Improve TOEIC-priority dictionary coverage for better meanings.',
        '- Upgrade Anki result report: success/failure counts + failed term list.',
        '- Integrate nightly checks into morning briefing.',
        '',
        '## 8) Business Impact',
        '- Reduced manual card-entry overhead by consolidating repeated input flows into one command path.',
        '- Improved operator response speed by returning success/failure diagnostics in the same Telegram thread.',
        '- Increased reusability by documenting an automation-first workflow that can be replicated across study domains.',
        '',
        '## 9) Reliability Metrics (Operational)',
        '- Batch save outcome is summarized per request (success/failure count + failed tokens).',
        '- Fallback strategy covers both language enrichment and AnkiConnect host connectivity.',
        '- Daily operations are observable through bridge logs, cron monitors, and Notion sync dashboards.',
        '',
        '## 10) Decision Trade-offs',
        '- Fast model route for lightweight commands keeps latency/cost low.',
        '- Deep reasoning route is reserved for structured work/inspection/deploy templates.',
        '- Strict prefix routing improves predictability but requires onboarding for new operators.',
        '',
        '## 11) Production Constraints',
        '- Secret keys and operational tokens stay outside public repositories.',
        '- External link replies are forced to publicly reachable URLs (no localhost leakage).',
        '- DB governance requires explicit approval before Notion conversation DB writes.',
        '',
        '## 12) Next 90-Day Plan',
        '- Expand TOEIC phrase coverage with domain-priority dictionaries.',
        '- Automate conversation-to-Notion sync using approval-gated batch windows.',
        '- Track skill improvement ROI (rework reduction, recurrence rate, response quality).',
        '',
        '---',
        `Published: ${dateLabel}`,
        'This post is generated from operational logs as a portfolio summary.',
    ].join('\n');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const title = `Anki OpenClaw Integration Portfolio ${new Date().toISOString().slice(0, 10)}`;
    const contentEn = buildPortfolioContent();
    const category = 'project';
    const tags = ['anki', 'openclaw', 'telegram', 'toeic_ai', 'moltbot'];

    const posts = await blogAutomation.createMultilingualPost(title, contentEn, tags, {
        categories: [category],
        sourceLang: 'en',
        langs: ['en', 'ja', 'ko'],
        skipTranslation: args.skipTranslation,
    });
    const enPost = posts.find((p) => p.includes(`${path.sep}en${path.sep}`)) || posts[0] || '';
    const slug = enPost
        ? path.basename(enPost, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '')
        : '';

    let notion = { synced: false, skipped: true, reason: 'policy_filtered' };
    if (shouldSyncToNotion(category, 'en')) {
        notion = await syncBlogMemoToNotion({
            slug,
            title,
            markdown: contentEn,
            categories: [category],
            lang: 'en',
            tags,
            sourceFiles: ['manual:publish_anki_portfolio_post'],
        });
    }

    const deploy = await blogAutomation.deployToGitHub();
    const out = {
        ok: true,
        title,
        posts,
        notion,
        deploy,
    };
    console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = {
    shouldSyncToNotion,
    buildPortfolioContent,
};
