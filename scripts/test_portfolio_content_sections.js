const assert = require('assert');
const { buildPortfolioContent } = require('./publish_anki_portfolio_post');

function main() {
    const content = buildPortfolioContent();
    const requiredSections = [
        '## 8) Business Impact',
        '## 9) Reliability Metrics (Operational)',
        '## 10) Decision Trade-offs',
        '## 11) Production Constraints',
        '## 12) Next 90-Day Plan',
    ];
    for (const section of requiredSections) {
        assert.ok(content.includes(section), `missing section: ${section}`);
    }
    console.log('test_portfolio_content_sections: ok');
}

main();
