const { normalizeIso, toSnippet } = require('./_utils');

function buildSearchQuery(source, now) {
    const daysWindow = Math.max(1, Number(source.createdDaysWindow || 7));
    const minStars = Math.max(0, Number(source.minStars || 50));
    const createdSince = new Date(now.getTime() - (daysWindow * 24 * 60 * 60 * 1000))
        .toISOString()
        .slice(0, 10);

    const queryParts = [`created:>=${createdSince}`];
    if (minStars > 0) queryParts.push(`stars:>=${minStars}`);
    if (source.query) queryParts.push(String(source.query).trim());

    return {
        query: queryParts.join(' '),
        stateKey: `github_trending:${createdSince}:${minStars}:${String(source.query || '').trim()}`,
    };
}

async function collect({ source, maxItems, http, now }) {
    const target = Math.max(1, Math.min(Number(maxItems || 20), 50));
    const { query, stateKey } = buildSearchQuery(source, now);
    const token = String(process.env.GITHUB_TOKEN || '').trim();

    const params = new URLSearchParams();
    params.set('q', query);
    params.set('sort', 'stars');
    params.set('order', 'desc');
    params.set('per_page', String(target));

    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'moltbot-news/2.0',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await http.getJson(`https://api.github.com/search/repositories?${params.toString()}`, {
        stateKey,
        headers,
    });
    if (response.notModified) return { items: [], statePatch: {} };

    const rows = response && response.data && Array.isArray(response.data.items)
        ? response.data.items
        : [];
    const items = [];
    const seen = new Set();

    for (const row of rows) {
        if (items.length >= target) break;
        const postId = String(row.id || '').trim();
        const title = String(row.full_name || '').trim();
        if (!postId || !title || seen.has(postId)) continue;
        seen.add(postId);

        const topics = Array.isArray(row.topics) ? row.topics.filter(Boolean) : [];
        const language = String(row.language || '').trim();
        const metaTags = [];
        if (language) metaTags.push(`lang:${language}`);
        metaTags.push(...topics.map((tag) => String(tag).trim()).filter(Boolean));

        items.push({
            source: 'github_trending',
            community: 'github:trending-proxy',
            post_id: postId,
            title,
            body: toSnippet(row.description || ''),
            comments_text: metaTags.join(', '),
            author: String((row.owner && row.owner.login) || ''),
            created_at: normalizeIso(row.created_at || row.updated_at, now),
            score: Number(row.stargazers_count || 0),
            comments: Number(row.open_issues_count || 0),
            url: String(row.html_url || '').trim(),
        });
    }

    return { items, statePatch: {} };
}

module.exports = { collect };
