/**
 * Moltbot 엔진 테스트 스크립트
 * 가계부 기록과 체크리스트 기록 기능 테스트
 */

const engine = require('./molt_engine.js');

async function runTests() {
    console.log('='.repeat(60));
    console.log('🧪 Moltbot 엔진 테스트 시작');
    console.log('='.repeat(60));

    try {
        // 1. 연결 테스트
        console.log('\n📡 1. 구글 시트 연결 테스트...');
        await engine.init();
        console.log('✅ 연결 성공!\n');

        // 2. 자연어 파싱 테스트 (실제 기록 없이)
        console.log('📝 2. 자연어 파싱 테스트...');
        const testCases = [
            '커피 450',
            '점심 1200엔 아마존',
            '안약 1280 올리브',
            '월급 265000 스미토모',
            '전철 200엔',
        ];

        for (const text of testCases) {
            const amount = engine.parseAmount(text);
            const method = engine.parsePaymentMethod(text);
            const category = engine.parseCategory(text);
            const item = engine.parseItemName(text);
            const income = engine.isIncome(text);

            console.log(`  "${text}"`);
            console.log(`    → 금액: ${amount}, 결제: ${method}, 카테고리: ${category}, 항목: ${item}, 수입: ${income}`);
        }
        console.log('✅ 파싱 테스트 완료!\n');

        // 3. 현재 잔고 조회
        console.log('💰 3. 잔고 조회 테스트...');
        const balances = await engine.getBalance();
        console.log('  현재 잔고:');
        for (const [account, balance] of Object.entries(balances)) {
            console.log(`    ${account}: ¥${balance.toLocaleString()}`);
        }
        console.log('✅ 잔고 조회 완료!\n');

        // 4. 월별 통계
        console.log('📊 4. 월별 통계 테스트 (2026년 2월)...');
        const stats = await engine.getMonthlyStats(2026, 2);
        console.log(`  수입: ¥${stats.income.toLocaleString()}`);
        console.log(`  지출: ¥${stats.expense.toLocaleString()}`);
        console.log(`  잔액: ¥${stats.balance.toLocaleString()}`);
        console.log('  카테고리별:');
        for (const [cat, amount] of Object.entries(stats.byCategory)) {
            console.log(`    ${cat}: ¥${amount.toLocaleString()}`);
        }
        console.log('✅ 월별 통계 완료!\n');

        // 5. 오늘 체크리스트 요약
        console.log('📋 5. 오늘 체크리스트 요약...');
        const summary = await engine.getTodaySummary();
        console.log('  오늘 기록:');
        for (const [col, val] of Object.entries(summary)) {
            console.log(`    ${col}: ${val}`);
        }
        console.log('✅ 체크리스트 요약 완료!\n');

        console.log('='.repeat(60));
        console.log('🎉 모든 테스트 성공!');
        console.log('='.repeat(60));

    } catch (error) {
        console.error('❌ 테스트 실패:', error.message);
        console.error(error.stack);
    }
}

runTests();
