/**
 * Antigravity Self-Healing Monitor
 * 로그 파일을 감시하다가 에러 발생 시 Antigravity에게 자동으로 수정을 요청함
 */

const fs = require('fs');
const path = require('path');
const { sendCommand } = require('./ag_bridge_client');

const LOG_FILE = path.join(__dirname, '../logs/error.log');

console.log(`🔍 [Self-Healing] 에러 로그 감시 시작: ${LOG_FILE}`);

// 로그 파일이 없으면 생성
if (!fs.existsSync(path.dirname(LOG_FILE))) {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}
if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, '');
}

// 파일 감시
fs.watchFile(LOG_FILE, (curr, prev) => {
    if (curr.size > prev.size) {
        // 새로 추가된 내용 읽기
        const stream = fs.createReadStream(LOG_FILE, { start: prev.size, end: curr.size });
        let newContent = '';

        stream.on('data', (chunk) => {
            newContent += chunk;
        });

        stream.on('end', async () => {
            const errorMatch = newContent.match(/Error: (.+)/i);
            if (errorMatch) {
                const errorMessage = errorMatch[0];
                console.log(`⚠️ [Self-Healing] 에러 감지됨: ${errorMessage}`);

                try {
                    console.log(`🛠 [Self-Healing] Antigravity에게 자동 수선 요청 중...`);
                    const response = await sendCommand(`[AUTO-FIX] 다음 에러를 분석하고 코드를 수정해줘: ${newContent}`);
                    console.log(`✅ [Self-Healing] 수선 완료 보고: ${response.result}`);
                } catch (err) {
                    console.error(`❌ [Self-Healing] 자동 수선 실패: ${err.message}`);
                }
            }
        });
    }
});
