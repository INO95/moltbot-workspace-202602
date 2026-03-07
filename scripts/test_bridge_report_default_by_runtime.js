const assert = require('assert');
const { handleAutoRoutedCommand } = require('./lib/bridge_auto_routes');

function withApiMeta(payload, meta) {
    return {
        ...payload,
        ...meta,
    };
}

function pickPreferredModelMeta(result, fallbackAlias = 'fast', fallbackReasoning = 'low') {
    const source = result && typeof result === 'object' ? result : {};
    return {
        preferredModelAlias: String(source.preferredModelAlias || fallbackAlias),
        preferredReasoning: String(source.preferredReasoning || fallbackReasoning),
        activeModelStage: String(source.activeModelStage || ''),
    };
}

function buildDeps() {
    return {
        withApiMeta,
        appendExternalLinks: (text) => String(text || ''),
        pickPreferredModelMeta,
        normalizeReportNewsPayload: (text) => String(text || '').trim() || '지금요약',
        isResearchRuntime: (env) => String(env && env.MOLTBOT_BOT_ID || '').trim() === 'bot-research',
        handleNewsCommand: async () => ({
            success: true,
            telegramReply: '리포트 완료',
            preferredModelAlias: 'gpt',
            preferredReasoning: 'high',
            activeModelStage: 'write',
        }),
        buildDailySummary: async () => ({
            success: true,
            telegramReply: '리포트 완료',
        }),
        publishFromReports: async () => ({
            success: true,
            telegramReply: '리포트 완료',
        }),
        buildWeeklyReport: async () => ({
            success: true,
            telegramReply: '리포트 완료',
        }),
    };
}

async function runReport(botId) {
    return handleAutoRoutedCommand({
        routed: {
            route: 'report',
            payload: '보내줘',
        },
        fullText: '리포트: 보내줘',
        env: {
            ...process.env,
            MOLTBOT_BOT_ID: botId,
            MOLTBOT_BOT_ROLE: 'worker',
        },
    }, buildDeps());
}

async function main() {
    const researchOut = await runReport('bot-research');
    assert.strictEqual(researchOut.route, 'report');
    assert.strictEqual(researchOut.routeHint, 'report-tech-trend');
    assert.ok(!String(researchOut.telegramReply || '').includes('알 수 없는 소식 명령'));
    assert.strictEqual(researchOut.preferredModelAlias, 'gpt');
    assert.strictEqual(researchOut.activeModelStage, 'write');

    const devOut = await runReport('bot-dev');
    assert.strictEqual(devOut.route, 'report');
    assert.strictEqual(devOut.routeHint, 'report-daily');
    assert.ok(!String(devOut.telegramReply || '').includes('알 수 없는 소식 명령'));
    assert.strictEqual(devOut.preferredModelAlias, 'fast');

    console.log('test_bridge_report_default_by_runtime: ok');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
