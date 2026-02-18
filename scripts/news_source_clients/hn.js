const { normalizeIso, toSnippet } = require('./_utils');

function normalizeHnUrl(url, id) {
    if (url && /^https?:\/\//i.test(url)) return url;
    return `https://news.ycombinator.com/item?id=${id}`;
}

async function collect({ source, sourceState, maxItems, http, now }) {
    const feeds = Array.isArray(source.feeds) && source.feeds.length ? source.feeds : ['topstories', 'newstories'];
    const target = Math.max(1, Number(maxItems || 10));
    const collected = [];
    const seenIds = new Set();

    const lastSeenId = Number(sourceState.lastSeenId || 0);
    let maxSeenId = lastSeenId;

    for (const feed of feeds) {
        if (collected.length >= target) break;
        const listResp = await http.getJson(`https://hacker-news.firebaseio.com/v0/${feed}.json`, {
            stateKey: `hn:${feed}`,
        });
        if (listResp.notModified) continue;
        const ids = Array.isArray(listResp.data) ? listResp.data : [];
        for (const id of ids) {
            if (collected.length >= target) break;
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            if (lastSeenId && Number(id) <= lastSeenId) continue;

            const itemResp = await http.getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
                stateKey: `hn:item:${id}`,
            });
            if (itemResp.notModified) continue;
            const item = itemResp.data;
            if (!item || item.deleted || item.dead) continue;
            if (!item.title) continue;
            if (item.type && item.type !== 'story') continue;

            maxSeenId = Math.max(maxSeenId, Number(item.id || 0));
            const createdIso = normalizeIso((item.time || 0) * 1000, now);
            collected.push({
                source: 'hn',
                community: 'hackernews',
                post_id: String(item.id),
                title: String(item.title || '').trim(),
                body: toSnippet(item.text || ''),
                comments_text: '',
                author: String(item.by || ''),
                created_at: createdIso,
                score: Number(item.score || 0),
                comments: Number(item.descendants || 0),
                url: normalizeHnUrl(item.url, item.id),
            });
        }
    }

    return {
        items: collected,
        statePatch: { lastSeenId: maxSeenId || lastSeenId || null },
    };
}

module.exports = { collect };
