const registry = {
    hn: require('./news_source_clients/hn'),
    reddit: require('./news_source_clients/reddit'),
    producthunt: require('./news_source_clients/producthunt'),
    github_trending: require('./news_source_clients/github_trending'),
    forem: require('./news_source_clients/forem'),
    qiita: require('./news_source_clients/qiita'),
    zenn: require('./news_source_clients/zenn'),
    mastodon: require('./news_source_clients/mastodon'),
    stackexchange: require('./news_source_clients/stackexchange'),
};

function listSupportedSources() {
    return Object.keys(registry);
}

function getSourceCollector(sourceId) {
    const key = String(sourceId || '').trim();
    const mod = registry[key];
    if (!mod || typeof mod.collect !== 'function') {
        throw new Error(`unsupported source id: ${key}`);
    }
    return mod.collect;
}

module.exports = {
    listSupportedSources,
    getSourceCollector,
};
