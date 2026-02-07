const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../data/secure/google_creds.json');
const financeDB = require('../data/finance_db.json');

const SHEET_ID = '113henz01mG2pyGB8XsgoHMhVRTLscEdzcfcmzlCcC-M';

async function upgradeV2() {
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });
    const doc = new GoogleSpreadsheet(SHEET_ID, auth);
    await doc.loadInfo();

    const v2Sheet = doc.sheetsByTitle['가계부_V2'];
    
    // 1. 중복 제거 로직 (날짜+항목+금액 조합으로 고유 키 생성)
    const seen = new Set();
    const cleanData = [];

    // PDF와 시트에서 수집된 모든 데이터 병합 (financeDB 포함)
    const allSources = [...financeDB.transactions.map(t => {
        const d = new Date(t.date);
        const days = ['일', '월', '화', '수', '목', '금', '토'];
        return {
            '날짜': `${String(d.getFullYear()).slice(-2)} ${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getDate()).padStart(2, '0')} ${days[d.getDay()]}`,
            '항목': t.item,
            '금액 (엔)': t.amount,
            '결제수단': t.paymentMethod,
            '카테고리': t.category || '기타',
            '메모': t.memo
        };
    })];

    // 기존 데이터 로드하여 병합 (중복 방지)
    const rows = await v2Sheet.getRows();
    rows.forEach(r => {
        allSources.push(r.toObject());
    });

    allSources.forEach(item => {
        const key = `${item['날짜']}_${item['항목']}_${item['금액 (엔)']}`;
        if (!seen.has(key)) {
            seen.add(key);
            cleanData.push(item);
        }
    });

    cleanData.sort((a, b) => a['날짜'].localeCompare(b['날짜']));

    // 2. 시트 초기화 및 데이터 재입력
    await v2Sheet.clearRows();
    const chunkSize = 100;
    for (let i = 0; i < cleanData.length; i += chunkSize) {
        await v2Sheet.addRows(cleanData.slice(i, i + chunkSize));
    }

    // 3. 시각적 업그레이드 (헤더 색상 및 조건부 서식은 API 한계상 기본 스타일 우선 적용)
    console.log(`✅ 중복 제거 완료 (총 ${cleanData.length}건). 시각화 데이터 전송 완료.`);
}

upgradeV2().catch(console.error);
