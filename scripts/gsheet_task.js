const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('./google_creds.json');

const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet('113henz01mG2pyGB8XsgoHMhVRTLscEdzcfcmzlCcC-M', serviceAccountAuth);

async function run() {
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  
  // 날짜 형식 파악 (최근 행 기준)
  const lastRow = rows[rows.length - 1];
  const lastDate = lastRow.get('날짜');
  console.log('--- 시트 정보 ---');
  console.log('마지막 행 날짜:', lastDate);

  // 2월 4일 행 찾기 (형식: 26 02 04)
  const rowToUpdate = rows.find(r => {
    const d = r.get('날짜');
    return d && d.includes('26 02 04');
  });
  
  if (rowToUpdate) {
    const oldDate = rowToUpdate.get('날짜');
    rowToUpdate.set('기타', '오픈클로 세팅');
    await rowToUpdate.save();
    console.log(`✅ [${oldDate}] 행 업데이트 완료: '오픈클로 세팅'`);
  } else {
    console.log('❌ 2월 4일 행을 찾지 못했습니다.');
    console.log('참고: 현재 마지막 3개 행 날짜 목록:');
    rows.slice(-3).forEach(r => console.log(`- ${r.get('날짜')}`));
  }
}

run().catch(console.error);
