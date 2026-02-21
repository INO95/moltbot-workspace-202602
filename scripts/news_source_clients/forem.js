const { normalizeIso, toSnippet } = require('./_utils');

async function collect({ source, maxItems, http, now }) {
    const tags = Array.isArray(source.tags) && source.tags.length
        ? source.tags
        : ['ai', 'vibecoding', 'cursor', 'windsurf', 'lovable'];
    const target = Math.max(1, Number(maxItems || 10));
    const perTag = Math.max(1, Math.min(Number(source.perTag || Math.ceil(target / tags.length)), 6));

    const items = [];
    const seen = new Set();

    for (const tag of tags) {
        if (items.length >= target) break;
        const url = `https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&per_page=${perTag}&top=7`;
        const resp = await http.getJson(url, {
            stateKey: `forem:tag:${tag}`,
            headers: { Accept: 'application/json' },
        });
        if (resp.notModified) continue;
        const rows = Array.isArray(resp.data) ? resp.data : [];

        for (const row of rows) {
            if (items.length >= target) break;
            const postId = String(row.id || '');
            if (!postId || seen.has(postId)) continue;
            seen.add(postId);
            items.push({
                source: 'forem',
                community: `dev.to/${tag}`,
                post_id: postId,
                title: String(row.title || '').trim(),
                body: toSnippet(row.description || ''),
                comments_text: Array.isArray(row.tag_list) ? row.tag_list.join(', ') : '',
                author: String((row.user && row.user.name) || ''),
                created_at: normalizeIso(row.published_at || row.created_at, now),
                score: Number(row.positive_reactions_count || row.public_reactions_count || 0),
                comments: Number(row.comments_count || 0),
                url: String(row.canonical_url || row.url || '').trim(),
            });
        }
    }

    return { items, statePatch: {} };
}

module.exports = { collect };
