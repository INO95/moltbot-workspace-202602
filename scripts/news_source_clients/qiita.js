const { normalizeIso, toSnippet } = require('./_utils');

async function collect({ source, maxItems, http, now }) {
    const tags = Array.isArray(source.tags) && source.tags.length ? source.tags : ['ai', 'llm', 'python'];
    const target = Math.max(1, Number(maxItems || 6));
    const perTag = Math.max(1, Math.min(Number(source.perTag || 1), 2));
    const items = [];
    const seen = new Set();

    for (const tag of tags) {
        if (items.length >= target) break;
        const query = encodeURIComponent(`tag:${tag}`);
        const url = `https://qiita.com/api/v2/items?query=${query}&page=1&per_page=${perTag}`;
        const resp = await http.getJson(url, {
            stateKey: `qiita:tag:${tag}`,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'moltbot-news/2.0',
            },
        });
        if (resp.notModified) continue;
        const rows = Array.isArray(resp.data) ? resp.data : [];

        for (const row of rows) {
            if (items.length >= target) break;
            const postId = String(row.id || '');
            if (!postId || seen.has(postId)) continue;
            seen.add(postId);

            items.push({
                source: 'qiita',
                community: `qiita:${tag}`,
                post_id: postId,
                title: String(row.title || '').trim(),
                body: toSnippet(row.body || row.rendered_body || row.title || ''),
                comments_text: Array.isArray(row.tags) ? row.tags.map((x) => x.name).join(', ') : '',
                author: String((row.user && (row.user.id || row.user.name)) || ''),
                created_at: normalizeIso(row.created_at, now),
                score: Number(row.likes_count || 0),
                comments: Number(row.comments_count || 0),
                url: String(row.url || '').trim(),
            });
        }
    }

    return { items, statePatch: {} };
}

module.exports = { collect };
