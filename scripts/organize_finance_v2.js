const engine = require('./molt_engine.js');

async function run() {
    await engine.init();
    const mainSheet = engine.doc.sheetsByTitle['가계부'];
    const archiveSheet = engine.doc.sheetsByTitle['가계부_2025'] || await engine.doc.addSheet({ title: '가계부_2025', headerValues: ['날짜', '항목', '금액 (엔)', '결제수단', '메모', '스미토모 잔고', '현금 잔고', '라쿠텐 잔고'] });
    
    const rows = await mainSheet.getRows();
    const rows2025 = [];
    const rows2026 = [];

    console.log('--- 데이터 분류 시작 ---');
    for (const row of rows) {
        const data = row.toObject();
        const dateStr = data['날짜'] || '';
        
        if (dateStr.startsWith('25 ')) {
            rows2025.push(data);
        } else if (dateStr.startsWith('26 ')) {
            // 지출 음수화 처리
            let amount = parseInt(data['금액 (엔)']) || 0;
            const item = data['항목'] || '';
            if (!item.includes('월급') && !item.includes('입금') && amount > 0) {
                data['금액 (엔)'] = -amount;
            }
            rows2026.push(data);
        }
    }

    // 1. 2025 데이터 아카이브 시트에 추가
    if (rows2025.length > 0) {
        await archiveSheet.addRows(rows2025);
        console.log(`✅ 2025년 데이터 ${rows2025.length}건 아카이브 완료.`);
    }

    // 2. 메인 시트 초기화 후 2026 데이터만 다시 쓰기
    await mainSheet.clearRows();
    if (rows2026.length > 0) {
        await mainSheet.addRows(rows2026);
        console.log(`✅ 2026년 데이터 ${rows2026.length}건 리팩터링 및 복구 완료.`);
    }
}

run().catch(console.error);
