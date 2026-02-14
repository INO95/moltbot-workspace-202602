const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { loadRuntimeEnv } = require('./env_runtime');

const notionBase = 'https://api.notion.com/v1';
const notionVersion = '2022-06-28';
const indexPath = path.join(__dirname, '../data/notion_blog_index.json');
const logLatestPath = path.join(__dirname, '../logs/notion_sync_latest.json');
const logHistoryPath = path.join(__dirname, '../logs/notion_sync_history.jsonl');
const defaultSyncPolicy = Object.freeze({
    categories: ['project'],
    langs: ['en'],
});

function ensureIndexFile() {
    if (fs.existsSync(indexPath)) return;
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify({ pagesBySlug: {} }, null, 2), 'utf8');
}

function readIndex() {
    ensureIndexFile();
    try {
        return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch {
        return { pagesBySlug: {} };
    }
}

function writeIndex(index) {
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
}

function sha256(input) {
    return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function pickPrimaryCategory(categories) {
    if (Array.isArray(categories) && categories.length > 0) {
        return String(categories[0] || '').trim().toLowerCase();
    }
    if (typeof categories === 'string' && categories.trim()) {
        return categories.trim().toLowerCase();
    }
    return '';
}

function normalizePolicyList(input, fallback, allowed) {
    const base = Array.isArray(input)
        ? input
        : String(input || '').split(',');
    const picked = base
        .map((x) => String(x || '').trim().toLowerCase())
        .filter(Boolean)
        .filter((x, idx, arr) => arr.indexOf(x) === idx)
        .filter((x) => !Array.isArray(allowed) || allowed.includes(x));
    return picked.length ? picked : [...fallback];
}

function normalizeSyncPolicy(input) {
    const src = input && typeof input === 'object' ? input : {};
    return {
        categories: normalizePolicyList(src.categories, defaultSyncPolicy.categories, ['log', 'briefing', 'project']),
        langs: normalizePolicyList(src.langs, defaultSyncPolicy.langs, ['en', 'ja', 'ko']),
    };
}

function isPolicyAllowed(policy, category, lang) {
    const c = String(category || '').trim().toLowerCase();
    const l = String(lang || '').trim().toLowerCase();
    return policy.categories.includes(c) && policy.langs.includes(l);
}

function appendSyncLog(entry) {
    const payload = {
        timestamp: new Date().toISOString(),
        ...entry,
    };
    fs.mkdirSync(path.dirname(logLatestPath), { recursive: true });
    fs.writeFileSync(logLatestPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.appendFileSync(logHistoryPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function withRetry(label, fn, { retries = 3, baseDelayMs = 350 } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastErr = error;
            const status = error && error.response && error.response.status;
            const retryable = !status || status >= 500 || status === 429;
            if (!retryable || attempt > retries) break;
            const delay = Math.min(baseDelayMs * (2 ** (attempt - 1)), 5000);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error(`${label}_failed: ${lastErr ? lastErr.message : 'unknown'}`);
}

function notionClient(token) {
    return axios.create({
        baseURL: notionBase,
        timeout: 30000,
        headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': notionVersion,
            'Content-Type': 'application/json',
        },
    });
}

function richText(content) {
    const text = String(content || '');
    return [
        {
            type: 'text',
            text: {
                content: text.slice(0, 2000),
            },
        },
    ];
}

function markdownToBlocks(markdown) {
    const lines = String(markdown || '').split('\n');
    const blocks = [];
    for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;

        if (line.startsWith('### ')) {
            blocks.push({
                object: 'block',
                type: 'heading_3',
                heading_3: { rich_text: richText(line.replace(/^###\s*/, '')) },
            });
            continue;
        }
        if (line.startsWith('## ')) {
            blocks.push({
                object: 'block',
                type: 'heading_2',
                heading_2: { rich_text: richText(line.replace(/^##\s*/, '')) },
            });
            continue;
        }
        if (line.startsWith('# ')) {
            blocks.push({
                object: 'block',
                type: 'heading_1',
                heading_1: { rich_text: richText(line.replace(/^#\s*/, '')) },
            });
            continue;
        }
        if (line.startsWith('- ')) {
            blocks.push({
                object: 'block',
                type: 'bulleted_list_item',
                bulleted_list_item: { rich_text: richText(line.replace(/^- /, '')) },
            });
            continue;
        }
        if (line === '---') {
            blocks.push({
                object: 'block',
                type: 'divider',
                divider: {},
            });
            continue;
        }
        blocks.push({
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: richText(line) },
        });
    }
    return blocks.slice(0, 200);
}

async function archivePage(client, pageId) {
    if (!pageId) return;
    try {
        await withRetry('archive_page', () => client.patch(`/pages/${pageId}`, { archived: true }));
    } catch {
        // Ignore archive errors to keep sync non-blocking.
    }
}

async function createPage(client, parentPageId, title, blocks) {
    const firstBatch = blocks.slice(0, 100);
    const res = await withRetry(
        'create_page',
        () => client.post('/pages', {
            parent: { type: 'page_id', page_id: parentPageId },
            properties: {
                title: {
                    title: richText(title),
                },
            },
            children: firstBatch,
        }),
    );
    const pageId = res.data && res.data.id;
    if (!pageId) return null;

    if (blocks.length > 100) {
        for (let i = 100; i < blocks.length; i += 100) {
            await withRetry(
                'append_children',
                () => client.patch(`/blocks/${pageId}/children`, {
                    children: blocks.slice(i, i + 100),
                }),
            );
        }
    }
    return pageId;
}

async function syncBlogMemoToNotion(input) {
    loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true });
    const token = process.env.NOTION_API_KEY || '';
    const parentPageId = process.env.NOTION_PARENT_PAGE_ID || '';
    const policy = normalizeSyncPolicy(input && input.syncPolicy);
    if (!token || !parentPageId) {
        const result = {
            synced: false,
            skipped: true,
            reason: 'missing_notion_env',
            required: ['NOTION_API_KEY', 'NOTION_PARENT_PAGE_ID'],
            policy,
        };
        appendSyncLog({
            ok: true,
            action: 'skip',
            slug: String(input && input.slug ? input.slug : ''),
            title: String(input && input.title ? input.title : ''),
            reason: result.reason,
        });
        return result;
    }

    const slug = String(input.slug || '').trim();
    const title = String(input.title || '').trim();
    const category = pickPrimaryCategory(input.categories);
    const lang = String(input.lang || '').trim().toLowerCase();
    if (!slug || !title) {
        const result = {
            synced: false,
            skipped: true,
            reason: 'missing_slug_or_title',
            policy,
        };
        appendSyncLog({
            ok: true,
            action: 'skip',
            slug,
            title,
            reason: result.reason,
        });
        return result;
    }
    if (input.enforcePolicy !== false && !isPolicyAllowed(policy, category, lang)) {
        const result = {
            synced: false,
            skipped: true,
            reason: 'policy_filtered',
            policy,
            category,
            lang,
        };
        appendSyncLog({
            ok: true,
            action: 'skip',
            slug,
            title,
            reason: result.reason,
        });
        return result;
    }

    const markdown = String(input.markdown || '').trim();
    const metadataLines = [
        '## Metadata',
        `- Slug: ${slug}`,
        `- Categories: ${(input.categories || []).join(', ') || '-'}`,
        `- Tags: ${(input.tags || []).join(', ') || '-'}`,
        `- Source files: ${(input.sourceFiles || []).map(f => path.basename(f)).join(', ') || '-'}`,
    ];
    const fullMarkdown = `${markdown}\n\n${metadataLines.join('\n')}`;
    const blocks = markdownToBlocks(fullMarkdown);

    const index = readIndex();
    const existing = index.pagesBySlug && index.pagesBySlug[slug];
    const contentHash = sha256(`${title}\n${fullMarkdown}`);
    if (existing && existing.contentHash === contentHash) {
        const result = {
            synced: true,
            skipped: true,
            reason: 'unchanged_content',
            pageId: existing.pageId || null,
        };
        appendSyncLog({
            ok: true,
            action: 'skip',
            slug,
            title,
            reason: result.reason,
            pageId: result.pageId,
        });
        return result;
    }

    const client = notionClient(token);
    if (existing && existing.pageId) {
        await archivePage(client, existing.pageId);
    }

    const pageId = await createPage(client, parentPageId, title, blocks);
    if (!pageId) {
        appendSyncLog({
            ok: false,
            action: 'create',
            slug,
            title,
            reason: 'create_page_failed',
        });
        return {
            synced: false,
            skipped: false,
            reason: 'create_page_failed',
        };
    }

    index.pagesBySlug = index.pagesBySlug || {};
    index.pagesBySlug[slug] = {
        pageId,
        title,
        contentHash,
        updatedAt: new Date().toISOString(),
    };
    writeIndex(index);

    const result = {
        synced: true,
        skipped: false,
        pageId,
    };
    appendSyncLog({
        ok: true,
        action: existing && existing.pageId ? 'replace' : 'create',
        slug,
        title,
        pageId,
    });
    return result;
}

if (require.main === module) {
    const payloadPath = process.argv[2];
    if (!payloadPath || !fs.existsSync(payloadPath)) {
        console.error('Usage: node scripts/notion_blog_sync.js <payload.json>');
        process.exit(1);
    }
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    syncBlogMemoToNotion(payload)
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => {
            console.error(error.message);
            process.exit(1);
        });
}

module.exports = {
    pickPrimaryCategory,
    syncBlogMemoToNotion,
};
