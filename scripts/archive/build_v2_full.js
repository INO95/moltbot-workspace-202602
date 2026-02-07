const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../data/secure/google_creds.json');
const financeDB = require('../data/finance_db.json');

const SHEET_ID = '113henz01mG2pyGB8XsgoHMhVRTLscEdzcfcmzlCcC-M';

async function buildUltimateV2() {
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });
    const doc = new GoogleSpreadsheet(SHEET_ID, auth);
    await doc.loadInfo();

    const v2Sheet = doc.sheetsByTitle['가계부_V2'];
    const archiveSheet = doc.sheetsByTitle['가계부_2025'];
    
    console.log('--- 데이터 통합 및 정규화 시작 ---');
    
    let allData = [];

    // 1. 2025년 데이터 가져오기 및 정규화
    if (archiveSheet) {
        const rows25 = await archiveSheet.getRows();
        console.log(`2025년 데이터 ${rows25.length}건 로드 완료`);
        rows25.forEach(r => {
            let amt = parseInt(r.get('금액 (엔)')) || 0;
            const item = r.get('항목') || '';
            // 지출 음수화 (수입 키워드 제외)
            if (!item.includes('월급') && !item.includes('입금') && amt > 0) {
                amt = -amt;
            }
            allData.push({
                '날짜': r.get('날짜'),
                '항목': item,
                '금액 (엔)': amt,
                '결제수단': r.get('결제수단'),
                '카테고리': r.get('카테고리') || '기타',
                '메모': r.get('메모')
            });
        });
    }

    // 2. 2026년 데이터(로컬 DB) 통합
    console.log(`2026년 데이터 ${financeDB.transactions.length}건 통합 중...`);
    financeDB.transactions.forEach(t => {
        // 날짜 형식 변환 (YYYY-MM-DD -> YY MM DD 요일) 
        // 시트의 기존 형식을 따르기 위해 변환 로직 적용
        const d = new Date(t.date);
        const days = ['일', '월', '화', '수', '목', '금', '토'];
        const formattedDate = `${String(d.getFullYear()).slice(-2)} ${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getDate()).padStart(2, '0')} ${days[d.getDay()]}`;
        
        allData.push({
            '날짜': formattedDate,
            '항목': t.item,
            '금액 (엔)': t.amount,
            '결제수단': t.paymentMethod,
            '카테고리': t.category,
            '메모': t.memo
        });
    });

    // 날짜순 정렬 (오름차순)
    allData.sort((a, b) => a.날짜.localeCompare(b.날짜));

    // 3. V2 시트 초기화 및 전체 데이터 삽입
    await v2Sheet.clearRows();
    
    // 대량 데이터 처리를 위해 청크 단위로 삽입
    const chunkSize = 100;
    for (let i = 0; i < allData.length; i += chunkSize) {
        const chunk = allData.slice(i, i + chunkSize);
        await v2Sheet.addRows(chunk);
        console.log(`${i + chunk.length} / ${allData.length} 완료...`);
    }

    console.log('✅ 2025-2026 전체 데이터 통합 완료!');
}

buildUltimateV2().catch(console.error);
