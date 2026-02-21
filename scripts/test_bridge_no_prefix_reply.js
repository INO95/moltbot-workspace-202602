const assert = require('assert');

const {
    buildNoPrefixGuide,
    inferPathListReply,
    isLegacyPersonaSwitchAttempt,
    buildDailyCasualNoPrefixReply,
    buildNoPrefixReply,
} = require('./lib/bridge_no_prefix_reply');

function main() {
    const guide = buildNoPrefixGuide();
    assert.ok(guide.includes('자연어로 바로 요청하셔도 됩니다.'));
    assert.ok(guide.includes('브릿지 라우터 리팩터링 작업해줘'));
    assert.ok(guide.includes('기존 템플릿 형식(`작업:`, `점검:`, `프로젝트:`)'));

    const listReply = inferPathListReply('프로젝트 폴더 목록 보여줘', {
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        extractPreferredProjectBasePath: () => '/Users/moltbot/Projects/Moltbot_Workspace',
        readDirectoryListPreview: () => 'notes\nscripts\ndata',
    });
    assert.ok(listReply.includes('/Users/moltbot/Projects/Moltbot_Workspace 안에는 지금 이게 있어:'));
    assert.ok(listReply.includes('notes'));

    const noListReply = inferPathListReply('안녕', {
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        extractPreferredProjectBasePath: () => '/tmp',
        readDirectoryListPreview: () => 'x',
    });
    assert.strictEqual(noListReply, '');

    assert.strictEqual(isLegacyPersonaSwitchAttempt('페르소나 바꿔줘'), true);
    assert.strictEqual(isLegacyPersonaSwitchAttempt('character mode'), true);
    assert.strictEqual(isLegacyPersonaSwitchAttempt('상태 알려줘'), false);

    const personaReply = buildDailyCasualNoPrefixReply('페르소나 바꿔줘', {
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        buildPersonaStatusReply: () => '페르소나 모드: 활성',
    });
    assert.ok(personaReply.includes('페르소나 모드: 활성'));
    assert.ok(personaReply.includes('설정 변경: `운영: 액션: 페르소나; 대상: daily; 이름: Adelia; 톤: 귀족; 스타일: 조언중심`'));

    const pathWins = buildNoPrefixReply('anything', { isHubRuntime: true }, {
        inferPathListReply: () => 'PATH_REPLY',
        buildDailyCasualNoPrefixReply: () => 'CASUAL_REPLY',
        buildNoPrefixGuide: () => 'GUIDE_REPLY',
    });
    assert.strictEqual(pathWins, 'PATH_REPLY');

    const hubReply = buildNoPrefixReply('anything', { isHubRuntime: true }, {
        inferPathListReply: () => '',
        buildDailyCasualNoPrefixReply: () => 'CASUAL_REPLY',
        buildNoPrefixGuide: () => 'GUIDE_REPLY',
    });
    assert.strictEqual(hubReply, 'CASUAL_REPLY');

    const normalReply = buildNoPrefixReply('anything', { isHubRuntime: false }, {
        inferPathListReply: () => '',
        buildDailyCasualNoPrefixReply: () => 'CASUAL_REPLY',
        buildNoPrefixGuide: () => 'GUIDE_REPLY',
    });
    assert.strictEqual(normalReply, 'GUIDE_REPLY');

    console.log('test_bridge_no_prefix_reply: ok');
}

main();
