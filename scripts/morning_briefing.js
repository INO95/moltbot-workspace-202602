/**
 * 아침 브리핑 자동화
 * 매일 오전 7시에 실행되어 Telegram으로 종합 보고서 전송
 */

// 각 모듈 로드
const moltEngine = require('./molt_engine');
const healthDashboard = require('./health_dashboard');
const healthCapture = require('./health_capture');
const financeManager = require('./finance_manager');
const { enqueueBridgePayload } = require('./bridge_queue');

async function generateMorningBriefing() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('ko-KR', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });

    let briefing = `🌅 **${dateStr} 아침 브리핑**\n\n`;

    // 1. 날씨 (TODO: 실제 API 연동)
    briefing += `☀️ **날씨**: 맑음, 12°C (체감 10°C)\n`;
    briefing += `   일출 06:52 / 일몰 18:15\n\n`;

    // 2. 가계부 요약
    try {
        const stats = await moltEngine.getMonthlyStats();
        const balance = await moltEngine.getBalance();

        briefing += `💰 **이번 달 가계부**\n`;
        briefing += `   수입: +${stats.income?.toLocaleString() || 0}엔\n`;
        briefing += `   지출: ${stats.expense?.toLocaleString() || 0}엔\n`;
        briefing += `   실질 지출: ${stats.effectiveExpense?.toLocaleString() || 0}엔\n`;
        briefing += `   잔액: ${Object.values(balance).reduce((a, b) => a + b, 0).toLocaleString()}엔\n\n`;
    } catch (e) {
        const now = new Date();
        const local = financeManager.getStats(now.getFullYear(), now.getMonth() + 1);
        briefing += `💰 **이번 달 가계부(로컬 폴백)**\n`;
        briefing += `   수입: +${(local.income || 0).toLocaleString()}엔\n`;
        briefing += `   지출: ${(local.expense || 0).toLocaleString()}엔\n`;
        briefing += `   실질 지출: ${Math.abs(local.expense || 0).toLocaleString()}엔\n\n`;
    }

    // 3. 건강 대시보드
    try {
        const health = await healthDashboard.generateDashboard({
            sleepData: [],
            exerciseHistory: healthCapture.getRecentExerciseHistory(21),
        });
        const monthly = healthCapture.getMonthlySummary();

        briefing += `🏥 **건강 상태**\n`;
        briefing += `   ${health.nutrition.message}\n`;
        briefing += `   🏃 이번달 러닝: ${monthly.running.sessions}회 / ${monthly.running.distanceKm}km\n`;
        briefing += `   🏋️ 이번달 웨이트: ${monthly.workouts.sessions}회\n`;
        if (health.workout.recommendations.length > 0) {
            briefing += `   🏋️ 오늘 추천 운동: ${health.workout.recommendations[0][1].name}\n`;
        }
        briefing += `\n`;
    } catch (e) {
        briefing += `🏥 **건강**: 대시보드 준비 중\n\n`;
    }

    // 4. 오늘 할 일 (체크리스트에서)
    try {
        const today = await moltEngine.getTodaySummary();
        const todoItems = Object.entries(today).filter(([k, v]) => !v || v === '');

        if (todoItems.length > 0) {
            briefing += `📋 **오늘 해야 할 것**\n`;
            briefing += todoItems.slice(0, 5).map(([k]) => `   • ${k}`).join('\n');
            briefing += `\n\n`;
        }
    } catch (e) {
        // 체크리스트 없으면 생략
    }

    // 5. TOEIC 학습 리마인더
    briefing += `📚 **학습 리마인더**\n`;
    briefing += `   • TOEIC 문법 일일 퀴즈\n`;
    briefing += `   • Anki 복습 카드\n\n`;

    // 6. 마무리
    briefing += `━━━━━━━━━━━━━━━━━━━━\n`;
    briefing += `좋은 하루 되세요! 🚀\n`;
    briefing += `_Powered by Moltbot + Antigravity_`;

    return briefing;
}

// Telegram 알림 전송 (OpenClaw Bridge 활용)
async function sendToTelegram(message) {
    const payload = {
        taskId: `briefing-${Date.now()}`,
        command: `[NOTIFY] ${message}`,
        timestamp: new Date().toISOString(),
        status: 'pending'
    };

    enqueueBridgePayload(payload);
    console.log('📨 Briefing sent to Telegram queue');
}

// 실행
if (require.main === module) {
    generateMorningBriefing()
        .then(briefing => {
            console.log(briefing);
            return sendToTelegram(briefing);
        })
        .then(() => console.log('✅ Morning briefing complete'))
        .catch(err => console.error('Error:', err));
}

module.exports = { generateMorningBriefing, sendToTelegram };
