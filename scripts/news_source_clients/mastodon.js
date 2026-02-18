const { normalizeIso, stripHtml, toSnippet } = require('./_utils');

async function collect({ source, maxItems, http, now }) {
    const instance = String(source.instance || 'mastodon.social').trim();
    const hashtags = Array.isArray(source.hashtags) && source.hashtags.length
        ? source.hashtags
        : ['ai', 'llm', 'vibecoding', 'cursor'];
    const target = Math.max(1, Number(maxItems || 8));
    const perTag = Math.max(1, Math.min(Number(source.perTag || Math.ceil(target / hashtags.length)), 5));

    const items = [];
    const seen = new Set();

    for (const tag of hashtags) {
        if (items.length >= target) break;
        const url = `https://${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${perTag}`;
        const resp = await http.getJson(url, {
            stateKey: `mastodon:${instance}:${tag}`,
            headers: {
                Accept: 'application/json',
            },
        });
        if (resp.notModified) continue;
        const rows = Array.isArray(resp.data) ? resp.data : [];
        for (const row of rows) {
            if (items.length >= target) break;
            const postId = String(row.id || '');
            if (!postId || seen.has(postId)) continue;
            seen.add(postId);
            const contentText = stripHtml(row.content || '');
            const tagsText = Array.isArray(row.tags) ? row.tags.map((x) => x.name).join(', ') : '';
            items.push({
                source: 'mastodon',
                community: `mastodon:${tag}`,
                post_id: postId,
                title: toSnippet(contentText, 120) || `#${tag}`,
                body: toSnippet(contentText),
                comments_text: tagsText,
                author: String((row.account && (row.account.username || row.account.acct)) || ''),
                created_at: normalizeIso(row.created_at, now),
                score: Number(row.favourites_count || 0) + Number(row.reblogs_count || 0),
                comments: Number(row.replies_count || 0),
                url: String(row.url || '').trim(),
            });
        }
    }

    return { items, statePatch: {} };
}

module.exports = { collect };
