function decodeHtmlEntities(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/gi, '/');
}

function stripHtml(text) {
    return decodeHtmlEntities(String(text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function toSnippet(text, maxLen = 160) {
    const clean = stripHtml(text);
    if (clean.length <= maxLen) return clean;
    return `${clean.slice(0, Math.max(0, maxLen - 1))}…`;
}

function normalizeIso(dateLike, fallback = new Date()) {
    const date = dateLike ? new Date(dateLike) : fallback;
    if (!Number.isFinite(date.getTime())) return fallback.toISOString();
    return date.toISOString();
}

function hashLike(input) {
    let hash = 0;
    const s = String(input || '');
    for (let i = 0; i < s.length; i += 1) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(16);
}

function getTagText(itemXml, tagName) {
    const cdata = itemXml.match(new RegExp(`<${tagName}>\\s*<!\\[CDATA\\[(.*?)\\]\\]>\\s*</${tagName}>`, 'is'));
    if (cdata) return String(cdata[1] || '').trim();
    const plain = itemXml.match(new RegExp(`<${tagName}>(.*?)</${tagName}>`, 'is'));
    return plain ? stripHtml(plain[1]) : '';
}

function parseRssItems(xml, limit = 10) {
    const text = String(xml || '');
    const blocks = text.match(/<item>([\s\S]*?)<\/item>/gi) || [];
    const results = [];
    for (const block of blocks.slice(0, limit)) {
        const title = getTagText(block, 'title');
        const link = getTagText(block, 'link');
        const description = getTagText(block, 'description');
        const pubDate = getTagText(block, 'pubDate');
        const author = getTagText(block, 'dc:creator') || getTagText(block, 'author');
        results.push({ title, link, description, pubDate, author });
    }
    return results;
}

module.exports = {
    stripHtml,
    toSnippet,
    normalizeIso,
    hashLike,
    parseRssItems,
};
