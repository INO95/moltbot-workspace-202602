/**
 * Moltbot 엔진 테스트 스크립트
 * 체크리스트 기록/요약 기능 테스트
 */

const engine = require('./molt_engine.js');

async function runTests() {
    console.log('='.repeat(60));
    console.log('🧪 Moltbot 엔진 테스트 시작');
    console.log('='.repeat(60));

    try {
        console.log('\n📡 1. 구글 시트 연결 테스트...');
        await engine.init();
        console.log('✅ 연결 성공!\n');

        console.log('📝 2. 체크리스트 기록 테스트...');
        const inputs = ['안키', '알고3', '다이어리'];
        for (const input of inputs) {
            const out = await engine.recordActivity(input);
            console.log(`  "${input}" -> ${JSON.stringify(out.recorded)}`);
        }
        console.log('✅ 기록 테스트 완료!\n');

        console.log('📋 3. 오늘 체크리스트 요약...');
        const summary = await engine.getTodaySummary();
        for (const [k, v] of Object.entries(summary)) {
            console.log(`  ${k}: ${v}`);
        }
        console.log('✅ 요약 테스트 완료!\n');

        console.log('='.repeat(60));
        console.log('🎉 모든 테스트 성공!');
        console.log('='.repeat(60));
    } catch (error) {
        console.error('❌ 테스트 실패:', error.message);
        console.error(error.stack);
    }
}

runTests();
