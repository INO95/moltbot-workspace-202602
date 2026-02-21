const { normalizeIso, parseRssItems, toSnippet, hashLike } = require('./_utils');

async function collect({ source, maxItems, http, now }) {
    const topics = Array.isArray(source.topics) && source.topics.length
        ? source.topics
        : ['ai', 'llm', 'openai', 'claude'];
    const target = Math.max(1, Number(maxItems || 8));
    const perTopic = Math.max(1, Math.min(Number(source.perTopic || Math.ceil(target / topics.length)), 4));

    const items = [];
    const seen = new Set();

    for (const topic of topics) {
        if (items.length >= target) break;
        const url = `https://zenn.dev/topics/${encodeURIComponent(topic)}/feed`;
        const resp = await http.getText(url, { stateKey: `zenn:topic:${topic}` });
        if (resp.notModified) continue;
        const parsed = parseRssItems(resp.data, perTopic);
        for (const row of parsed) {
            if (items.length >= target) break;
            const postId = row.link ? hashLike(row.link) : hashLike(`${topic}:${row.title}`);
            if (seen.has(postId)) continue;
            seen.add(postId);
            items.push({
                source: 'zenn',
                community: `zenn:${topic}`,
                post_id: postId,
                title: String(row.title || '').trim(),
                body: toSnippet(row.description || ''),
                comments_text: '',
                author: String(row.author || ''),
                created_at: normalizeIso(row.pubDate, now),
                score: 0,
                comments: 0,
                url: String(row.link || '').trim(),
            });
        }
    }

    return { items, statePatch: {} };
}

module.exports = { collect };
