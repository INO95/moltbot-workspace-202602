const assert = require('assert');

const { collect: collectReddit } = require('./news_source_clients/reddit');
const { collect: collectProductHunt } = require('./news_source_clients/producthunt');
const { collect: collectGithubTrending } = require('./news_source_clients/github_trending');
const { listSupportedSources } = require('./news_sources_registry');

async function expectReject(fn, messageFragment) {
    let rejected = false;
    try {
        await fn();
    } catch (error) {
        rejected = true;
        if (messageFragment) {
            const text = String((error && error.message) || error);
            assert.ok(text.includes(messageFragment), `expected "${messageFragment}" in "${text}"`);
        }
    }
    assert.ok(rejected, 'expected promise to reject');
}

async function testRedditCollector() {
    const now = new Date('2026-02-14T12:00:00.000Z');
    const baseSource = {
        oauthToken: 'test-token',
        subreddits: ['technology'],
        perSubreddit: 2,
    };

    const normal = await collectReddit({
        source: baseSource,
        maxItems: 5,
        now,
        http: {
            getJson: async () => ({
                notModified: false,
                data: {
                    data: {
                        children: [
                            {
                                data: {
                                    name: 't3_abc',
                                    title: 'Reddit trend title',
                                    selftext: 'Reddit body',
                                    subreddit: 'technology',
                                    author: 'alice',
                                    created_utc: 1760000000,
                                    score: 120,
                                    num_comments: 24,
                                    url: 'https://example.com/reddit',
                                },
                            },
                        ],
                    },
                },
            }),
        },
    });
    assert.strictEqual(normal.items.length, 1);
    assert.strictEqual(normal.items[0].source, 'reddit');
    assert.strictEqual(normal.items[0].title, 'Reddit trend title');

    const empty = await collectReddit({
        source: baseSource,
        maxItems: 5,
        now,
        http: {
            getJson: async () => ({ notModified: false, data: { data: { children: [] } } }),
        },
    });
    assert.strictEqual(empty.items.length, 0);

    const malformed = await collectReddit({
        source: baseSource,
        maxItems: 5,
        now,
        http: {
            getJson: async () => ({ notModified: false, data: { invalid: true } }),
        },
    });
    assert.strictEqual(malformed.items.length, 0);

    const fallback = await collectReddit({
        source: {
            subreddits: ['technology'],
            perSubreddit: 2,
        },
        maxItems: 5,
        now,
        http: {
            getText: async () => ({
                notModified: false,
                data: `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>t3_fallback</id>
    <title>Reddit RSS Fallback Title</title>
    <published>2026-02-14T00:00:00+00:00</published>
    <author><name>/u/rssuser</name></author>
    <link href="https://www.reddit.com/r/technology/comments/fallback/post" />
    <content type="html">&lt;div&gt;fallback content&lt;/div&gt;</content>
  </entry>
</feed>`,
            }),
        },
    });
    assert.strictEqual(fallback.items.length, 1);
    assert.strictEqual(fallback.items[0].title, 'Reddit RSS Fallback Title');
    assert.strictEqual(fallback.items[0].author, 'rssuser');

    await expectReject(
        () => collectReddit({
            source: baseSource,
            maxItems: 5,
            now,
            http: {
                getJson: async () => {
                    throw new Error('429 too many requests');
                },
                getText: async () => {
                    throw new Error('429 too many requests');
                },
            },
        }),
        '429'
    );
}

async function testProductHuntCollector() {
    const now = new Date('2026-02-14T12:00:00.000Z');
    const requestGraphql = async () => ({
        data: {
            posts: {
                edges: [
                    {
                        node: {
                            id: 'ph_1',
                            name: 'Product Hunt Tool',
                            tagline: 'AI workflow',
                            description: 'A practical AI app',
                            url: 'https://www.producthunt.com/posts/example',
                            createdAt: '2026-02-14T00:00:00.000Z',
                            votesCount: 345,
                            commentsCount: 17,
                            user: { name: 'maker' },
                            topics: { edges: [{ node: { name: 'AI' } }] },
                        },
                    },
                ],
            },
        },
    });

    const normal = await collectProductHunt({
        source: { apiToken: 'token', requestGraphql, postedDaysWindow: 7 },
        maxItems: 5,
        now,
    });
    assert.strictEqual(normal.items.length, 1);
    assert.strictEqual(normal.items[0].source, 'producthunt');
    assert.ok(normal.items[0].title.includes('Product Hunt Tool'));

    const empty = await collectProductHunt({
        source: { apiToken: 'token', requestGraphql: async () => ({ data: { posts: { edges: [] } } }) },
        maxItems: 5,
        now,
    });
    assert.strictEqual(empty.items.length, 0);

    const malformed = await collectProductHunt({
        source: { apiToken: 'token', requestGraphql: async () => ({ data: { invalid: true } }) },
        maxItems: 5,
        now,
        http: {
            getText: async () => ({
                notModified: false,
                data: `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
            }),
        },
    });
    assert.strictEqual(malformed.items.length, 0);

    const atomFallback = await collectProductHunt({
        source: {},
        maxItems: 5,
        now,
        http: {
            getText: async () => ({
                notModified: false,
                data: `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:www.producthunt.com,2005:Post/999</id>
    <published>2026-02-14T00:00:00-08:00</published>
    <title>PH Atom Fallback</title>
    <link rel="alternate" href="https://www.producthunt.com/products/example" />
    <content type="html">&lt;p&gt;Fallback content&lt;/p&gt;</content>
    <author><name>maker</name></author>
  </entry>
</feed>`,
            }),
        },
    });
    assert.strictEqual(atomFallback.items.length, 1);
    assert.strictEqual(atomFallback.items[0].title, 'PH Atom Fallback');

    await expectReject(
        () => collectProductHunt({
            source: {
                apiToken: 'token',
                requestGraphql: async () => {
                    throw new Error('429 too many requests');
                },
            },
            maxItems: 5,
            now,
            http: {
                getText: async () => {
                    throw new Error('429 too many requests');
                },
            },
        }),
        '429'
    );
}

async function testGithubTrendingCollector() {
    const now = new Date('2026-02-14T12:00:00.000Z');
    const source = { createdDaysWindow: 7, minStars: 50, query: 'topic:ai' };

    const normal = await collectGithubTrending({
        source,
        maxItems: 5,
        now,
        http: {
            getJson: async () => ({
                notModified: false,
                data: {
                    items: [
                        {
                            id: 101,
                            full_name: 'org/repo',
                            description: 'GitHub trending proxy item',
                            owner: { login: 'org' },
                            created_at: '2026-02-10T00:00:00.000Z',
                            stargazers_count: 777,
                            open_issues_count: 8,
                            html_url: 'https://github.com/org/repo',
                            language: 'TypeScript',
                            topics: ['ai', 'agent'],
                        },
                    ],
                },
            }),
        },
    });
    assert.strictEqual(normal.items.length, 1);
    assert.strictEqual(normal.items[0].source, 'github_trending');
    assert.strictEqual(normal.items[0].title, 'org/repo');

    const empty = await collectGithubTrending({
        source,
        maxItems: 5,
        now,
        http: { getJson: async () => ({ notModified: false, data: { items: [] } }) },
    });
    assert.strictEqual(empty.items.length, 0);

    const malformed = await collectGithubTrending({
        source,
        maxItems: 5,
        now,
        http: { getJson: async () => ({ notModified: false, data: { invalid: true } }) },
    });
    assert.strictEqual(malformed.items.length, 0);

    await expectReject(
        () => collectGithubTrending({
            source,
            maxItems: 5,
            now,
            http: {
                getJson: async () => {
                    throw new Error('429 rate limit exceeded');
                },
            },
        }),
        '429'
    );
}

async function main() {
    const supported = new Set(listSupportedSources());
    assert.ok(supported.has('reddit'));
    assert.ok(supported.has('producthunt'));
    assert.ok(supported.has('github_trending'));

    await testRedditCollector();
    await testProductHuntCollector();
    await testGithubTrendingCollector();

    console.log(JSON.stringify({ ok: true }));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
