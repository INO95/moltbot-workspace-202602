const axios = require('axios');
const { normalizeIso, toSnippet, stripHtml, hashLike } = require('./_utils');

function parseGraphqlRows(payload) {
    const edges = payload && payload.data && payload.data.posts && Array.isArray(payload.data.posts.edges)
        ? payload.data.posts.edges
        : [];
    return edges
        .map((edge) => (edge && edge.node ? edge.node : null))
        .filter(Boolean);
}

function graphqlErrorText(payload) {
    if (!payload || !Array.isArray(payload.errors) || !payload.errors.length) return '';
    return payload.errors
        .map((row) => String((row && row.message) || '').trim())
        .filter(Boolean)
        .join('; ');
}

async function requestGraphql(token, query, variables) {
    const response = await axios({
        method: 'post',
        url: 'https://api.producthunt.com/v2/api/graphql',
        timeout: 15000,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'moltbot-news/2.0',
        },
        data: { query, variables },
        validateStatus: (status) => status >= 200 && status < 300,
    });
    return response && response.data ? response.data : {};
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

async function collectFromAtom({ target, http, now }) {
    if (!http || typeof http.getText !== 'function') {
        throw new Error('producthunt atom fallback requires http.getText');
    }
    const response = await http.getText('https://www.producthunt.com/feed', {
        stateKey: `producthunt:feed:${target}`,
        headers: {
            Accept: 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
            'User-Agent': 'moltbot-news/2.0',
        },
    });
    if (response.notModified) return [];

    const entries = parseAtomEntries(response.data, target);
    const items = [];
    const seen = new Set();
    for (const entry of entries) {
        if (items.length >= target) break;
        const postId = String(entry.id || '').trim() || hashLike(`${entry.link}:${entry.title}`);
        const title = String(entry.title || '').trim();
        if (!postId || !title || seen.has(postId)) continue;
        seen.add(postId);

        items.push({
            source: 'producthunt',
            community: 'producthunt:feed',
            post_id: postId,
            title,
            body: toSnippet(entry.content || ''),
            comments_text: '',
            author: String(entry.author || ''),
            created_at: normalizeIso(entry.published, now),
            score: 0,
            comments: 0,
            url: String(entry.link || '').trim(),
        });
    }
    return items;
}

async function collect({ source, maxItems, now, http }) {
    const token = String(source.apiToken || process.env.PRODUCT_HUNT_TOKEN || '').trim();
    const requestGraphqlFn = typeof source.requestGraphql === 'function'
        ? source.requestGraphql
        : requestGraphql;

    const target = Math.max(1, Math.min(Number(maxItems || 12), 20));
    if (!token) {
        const items = await collectFromAtom({ target, http, now });
        return { items, statePatch: {} };
    }

    const daysWindow = Math.max(1, Number(source.postedDaysWindow || 7));
    const postedAfter = new Date(now.getTime() - daysWindow * 24 * 60 * 60 * 1000).toISOString();

    const queryWithWindow = `
query TechTrendPosts($first: Int!, $postedAfter: DateTime) {
  posts(first: $first, postedAfter: $postedAfter) {
    edges {
      node {
        id
        name
        tagline
        description
        url
        createdAt
        votesCount
        commentsCount
        user { name }
        topics(first: 6) { edges { node { name } } }
      }
    }
  }
}
`;

    const queryFallback = `
query TechTrendPosts($first: Int!) {
  posts(first: $first) {
    edges {
      node {
        id
        name
        tagline
        description
        url
        createdAt
        votesCount
        commentsCount
        user { name }
        topics(first: 6) { edges { node { name } } }
      }
    }
  }
}
`;

    let payload;
    try {
        payload = await requestGraphqlFn(token, queryWithWindow, { first: target, postedAfter });
        let errorText = graphqlErrorText(payload);
        if (errorText && /unknown argument|type mismatch|date/i.test(errorText)) {
            payload = await requestGraphqlFn(token, queryFallback, { first: target });
            errorText = graphqlErrorText(payload);
        }
        if (errorText) throw new Error(`producthunt_graphql_error: ${errorText}`);
    } catch (error) {
        // API 호출이 실패하면 공개 Atom 피드로 자동 강등한다.
        const items = await collectFromAtom({ target, http, now });
        return { items, statePatch: {} };
    }

    const rows = parseGraphqlRows(payload);
    const items = [];
    const seen = new Set();

    for (const row of rows) {
        if (items.length >= target) break;
        const postId = String(row.id || '').trim();
        const name = String(row.name || '').trim();
        if (!postId || !name || seen.has(postId)) continue;
        seen.add(postId);

        const tagline = String(row.tagline || '').trim();
        const title = tagline ? `${name} - ${tagline}` : name;
        const topics = row.topics && Array.isArray(row.topics.edges)
            ? row.topics.edges
                .map((edge) => (edge && edge.node && edge.node.name ? String(edge.node.name).trim() : ''))
                .filter(Boolean)
            : [];

        items.push({
            source: 'producthunt',
            community: 'producthunt',
            post_id: postId,
            title,
            body: toSnippet(row.description || row.tagline || ''),
            comments_text: topics.join(', '),
            author: String((row.user && row.user.name) || ''),
            created_at: normalizeIso(row.createdAt, now),
            score: Number(row.votesCount || 0),
            comments: Number(row.commentsCount || 0),
            url: String(row.url || '').trim(),
        });
    }

    return { items, statePatch: {} };
}

module.exports = { collect };
