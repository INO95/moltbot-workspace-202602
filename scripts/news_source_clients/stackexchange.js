const { normalizeIso, toSnippet } = require('./_utils');

function toEpochSeconds(value) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000);
}

async function collect({ source, sourceState, maxItems, http, now }) {
    const site = String(source.site || 'stackoverflow').trim();
    const tagged = Array.isArray(source.tagged) && source.tagged.length
        ? source.tagged
        : ['artificial-intelligence', 'large-language-model'];
    const target = Math.max(1, Math.min(Number(maxItems || 6), 20));

    const query = new URLSearchParams();
    query.set('order', 'desc');
    query.set('sort', 'creation');
    query.set('site', site);
    query.set('pagesize', String(target));
    query.set('tagged', tagged.join(';'));

    const fromDate = toEpochSeconds(sourceState.lastRunAt);
    if (fromDate) query.set('fromdate', String(Math.max(0, fromDate - 1800)));

    const url = `https://api.stackexchange.com/2.3/questions?${query.toString()}`;
    const resp = await http.getJson(url, {
        stateKey: `stackexchange:${site}:${tagged.join(';')}`,
        headers: {
            Accept: 'application/json',
        },
    });
    if (resp.notModified) {
        return { items: [], statePatch: {} };
    }

    const rows = (resp.data && Array.isArray(resp.data.items)) ? resp.data.items : [];
    const items = rows.slice(0, target).map((row) => ({
        source: 'stackexchange',
        community: `stackexchange:${site}`,
        post_id: String(row.question_id || ''),
        title: String(row.title || '').trim(),
        body: toSnippet((row.tags || []).join(', ')),
        comments_text: '',
        author: String((row.owner && row.owner.display_name) || ''),
        created_at: normalizeIso(Number(row.creation_date || 0) * 1000, now),
        score: Number(row.score || 0),
        comments: Number(row.answer_count || 0),
        url: String(row.link || '').trim(),
    })).filter((item) => item.post_id && item.title);

    return { items, statePatch: {} };
}

module.exports = { collect };
