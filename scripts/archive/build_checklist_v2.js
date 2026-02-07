const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../data/secure/google_creds.json');

const SHEET_ID = '113henz01mG2pyGB8XsgoHMhVRTLscEdzcfcmzlCcC-M';

async function buildChecklistV2() {
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(SHEET_ID, auth);
    await doc.loadInfo();

    let sheet = doc.sheetsByTitle['체크리스트_V2'];
    if (sheet) await sheet.delete();
    sheet = await doc.addSheet({ 
        title: '체크리스트_V2', 
        headerValues: ['날짜', 'anki', '알고리즘', '다이어리', '운동', '기타'] 
    });

    // PDF 기반 샘플 데이터 입력 (26 01 01 ~ 01 05)
    const sampleData = [
        { '날짜': '26 01 01 목', '운동': 'O (밀기/유산소)', '기타': '화장실 환풍구 커버 교체' },
        { '날짜': '26 01 02 금', '운동': 'O (존 2 한시간)' },
        { '날짜': '26 01 03 토', '운동': 'O (당기기)', '기타': '카페인 알약 폐기' },
        { '날짜': '26 01 04 일', '운동': 'O (존 2 한시간)', '기타': 'AWS Lightsail 삭제' },
        { '날짜': '26 01 05 월', '운동': 'O (밀기)', '기타': '이력서 초고 작성' }
    ];

    await sheet.addRows(sampleData);
    console.log('✅ 체크리스트_V2 시트 생성 및 초기 데이터 입력 완료');
}

buildChecklistV2().catch(console.error);
