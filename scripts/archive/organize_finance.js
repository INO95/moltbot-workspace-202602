const engine = require('./molt_engine.js');

async function run() {
    await engine.init();
    const sheet = engine.doc.sheetsByTitle['가계부'];
    const rows = await sheet.getRows();
    
    // 1. 2025년 데이터 아카이브
    const rows2025 = rows.filter(r => r.get('날짜') && r.get('날짜').startsWith('25 '));
    if (rows2025.length > 0) {
        let archiveSheet = engine.doc.sheetsByTitle['가계부_2025'];
        if (!archiveSheet) {
            archiveSheet = await engine.doc.addSheet({ 
                title: '가계부_2025', 
                headerValues: ['날짜', '항목', '금액 (엔)', '결제수단', '메모', '스미토모 잔고', '현금 잔고', '라쿠텐 잔고'] 
            });
        }
        await archiveSheet.addRows(rows2025.map(r => r.toObject()));
        console.log(`✅ 2025년 데이터 ${rows2025.length}건 이동 완료.`);
        
        // 원본에서 삭제
        for (const row of rows2025) {
            await row.delete();
        }
    }

    // 2. 2026년 데이터 리팩터링 (지출 음수화)
    const rows2026 = rows.filter(r => r.get('날짜') && r.get('날짜').startsWith('26 '));
    console.log(`🔄 2026년 데이터 ${rows2026.length}건 리팩터링 시작...`);
    
    for (const row of rows2026) {
        const item = row.get('항목') || '';
        let amount = parseInt(row.get('금액 (엔)')) || 0;
        
        // 지출인데 양수로 되어있으면 음수로 변경
        if (!item.includes('월급') && !item.includes('입금') && amount > 0) {
            row.set('금액 (엔)', -amount);
            await row.save();
        } else if ((item.includes('월급') || item.includes('입금')) && amount < 0) {
            // 혹시 수입인데 음수면 양수로 변경
            row.set('금액 (엔)', Math.abs(amount));
            await row.save();
        }
    }
    console.log('✅ 2026년 데이터 리팩터링 완료.');
}

run().catch(console.error);
