const axios = require('axios');
const { normalizeIso, toSnippet, stripHtml, hashLike } = require('./_utils');

function normalizeRedditUrl(row) {
    const explicit = String(row.url_overridden_by_dest || row.url || '').trim();
    if (/^https?:\/\//i.test(explicit)) return explicit;
    const permalink = String(row.permalink || '').trim();
    if (permalink) return `https://www.reddit.com${permalink}`;
    return '';
}

async function resolveAccessToken(source) {
    if (source && source.oauthToken) return String(source.oauthToken).trim();

    const clientId = String(process.env.REDDIT_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.REDDIT_CLIENT_SECRET || '').trim();
    const userAgent = String(process.env.REDDIT_USER_AGENT || 'moltbot-news/2.0').trim();
    if (!clientId || !clientSecret) {
        return '';
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');

    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const response = await axios({
        method: 'post',
        url: 'https://www.reddit.com/api/v1/access_token',
        timeout: 15000,
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': userAgent,
        },
        data: body.toString(),
        validateStatus: (status) => status >= 200 && status < 300,
    });

    const token = response && response.data && response.data.access_token
        ? String(response.data.access_token).trim()
        : '';
    if (!token) {
        throw new Error('reddit access token not returned');
    }
    return token;
}

function parseAtomTag(entryXml, tagName) {
    const match = entryXml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'));
    return match ? String(match[1] || '').trim() : '';
}

function parseAtomLink(entryXml) {
    const match = entryXml.match(/<link\b[^>]*\bhref="([^"]+)"/i);
    return match ? String(match[1] || '').trim() : '';
}

function parseAtomEntries(xml, limit = 10) {
    const blocks = String(xml || '').match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];
    const rows = [];
    for (const block of blocks.slice(0, limit)) {
        const id = parseAtomTag(block, 'id');
        const title = stripHtml(parseAtomTag(block, 'title'));
        const published = parseAtomTag(block, 'published') || parseAtomTag(block, 'updated');
        const author = stripHtml(parseAtomTag(block, 'name'));
        const link = parseAtomLink(block);
        const content = stripHtml(stripHtml(parseAtomTag(block, 'content')));
        rows.push({ id, title, published, author, link, content });
    }
    return rows;
}

async function collect({ source, maxItems, http, now }) {
    const subreddits = Array.isArray(source.subreddits) && source.subreddits.length
        ? source.subreddits
        : ['technology', 'programming', 'MachineLearning', 'artificial', 'opensource'];
    const target = Math.max(1, Number(maxItems || 12));
    const perSubreddit = Math.max(1, Math.min(Number(source.perSubreddit || Math.ceil(target / subreddits.length)), 10));
    const feedTypeRaw = String(source.feedType || 'hot').trim().toLowerCase();
    const feedType = ['hot', 'new', 'top'].includes(feedTypeRaw) ? feedTypeRaw : 'hot';

    const userAgent = String(process.env.REDDIT_USER_AGENT || source.userAgent || 'moltbot-news/2.0').trim();
    let token = '';
    try {
        token = await resolveAccessToken(source);
    } catch (_) {
        token = '';
    }
    let oauthAvailable = Boolean(token);
    const items = [];
    const seen = new Set();

    for (const subreddit of subreddits) {
        if (items.length >= target) break;

        if (oauthAvailable) {
            try {
                const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/${feedType}?limit=${perSubreddit}&raw_json=1`;
                const response = await http.getJson(url, {
                    stateKey: `reddit:${subreddit}`,
                    headers: {
                        Accept: 'application/json',
                        Authorization: `Bearer ${token}`,
                        'User-Agent': userAgent,
                    },
                });
                if (response.notModified) continue;

                const rows = response && response.data && response.data.data && Array.isArray(response.data.data.children)
                    ? response.data.data.children
                    : [];

                for (const row of rows) {
                    if (items.length >= target) break;
                    const data = row && row.data ? row.data : null;
                    if (!data) continue;
                    const postId = String(data.name || data.id || '').trim();
                    const title = String(data.title || '').trim();
                    if (!postId || !title || seen.has(postId)) continue;
                    seen.add(postId);

                    const createdAt = Number(data.created_utc || 0) > 0
                        ? Number(data.created_utc) * 1000
                        : data.created;
                    const communityName = String(data.subreddit || subreddit).trim();

                    items.push({
                        source: 'reddit',
                        community: `reddit:r/${communityName}`,
                        post_id: postId,
                        title,
                        body: toSnippet(data.selftext || ''),
                        comments_text: toSnippet(String(data.link_flair_text || '').trim(), 100),
                        author: String(data.author || ''),
                        created_at: normalizeIso(createdAt, now),
                        score: Number(data.score || 0),
                        comments: Number(data.num_comments || 0),
                        url: normalizeRedditUrl(data),
                    });
                }
                continue;
            } catch (_) {
                // OAuth 경로가 막혀도 RSS 경로로 계속 수집한다.
                oauthAvailable = false;
            }
        }

        const rssUrl = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${feedType}/.rss?limit=${perSubreddit}`;
        const rssResponse = await http.getText(rssUrl, {
            stateKey: `reddit:rss:${subreddit}`,
            headers: {
                Accept: 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
                'User-Agent': userAgent,
            },
        });
        if (rssResponse.notModified) continue;

        const entries = parseAtomEntries(rssResponse.data, perSubreddit);
        for (const entry of entries) {
            if (items.length >= target) break;
            const postId = String(entry.id || '').trim() || hashLike(`${entry.link}:${entry.title}`);
            const title = String(entry.title || '').trim();
            if (!postId || !title || seen.has(postId)) continue;
            seen.add(postId);

            items.push({
                source: 'reddit',
                community: `reddit:r/${String(subreddit).trim()}`,
                post_id: postId,
                title,
                body: toSnippet(entry.content || ''),
                comments_text: '',
                author: String(entry.author || '').replace(/^\/u\//, ''),
                created_at: normalizeIso(entry.published, now),
                score: 0,
                comments: 0,
                url: String(entry.link || '').trim(),
            });
        }
    }

    return { items, statePatch: {} };
}

module.exports = { collect };
