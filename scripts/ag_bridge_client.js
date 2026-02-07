/**
 * Antigravity Bridge Client
 * OpenClaw(Moltbot)에서 Antigravity(AI Agent)로 명령을 전달하는 인터페이스
 * 
 * 사용법: node scripts/ag_bridge_client.js "명령어 내용"
 */

const path = require('path');
const { enqueueBridgeCommand, BRIDGE_DIR } = require('./bridge_queue');

const OUTBOX_PATH = path.join(BRIDGE_DIR, 'outbox.json');
const fs = require('fs');

async function sendCommand(command) {
    const payload = enqueueBridgeCommand(command, { prefix: 'bridge' });
    const { taskId, ackId } = payload;

    console.log(`🚀 [OpenClaw] Antigravity에게 명령 전송 중: ${command}`);
    console.log(`🧾 [OpenClaw] ACK: ${ackId} (taskId=${taskId})`);

    // 결과 대기 (최대 60초)
    console.log(`⏳ [OpenClaw] 결과를 기다리는 중... (Antigravity 작업 중)`);

    return new Promise((resolve, reject) => {
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;

            if (fs.existsSync(OUTBOX_PATH)) {
                try {
                    const response = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8'));
                    if (response.taskId === taskId) {
                        clearInterval(interval);
                        // 완료 후 outbox 삭제 (선택 사항)
                        // fs.unlinkSync(OUTBOX_PATH);
                        resolve(response);
                    }
                } catch (e) {
                    // 읽기 오류 (동시 쓰기 등) 무시
                }
            }

            if (attempts > 120) { // 60초 초과
                clearInterval(interval);
                reject(new Error('Antigravity 응답 시간 초과 (60s)'));
            }
        }, 500);
    });
}

// CLI 실행 시
if (require.main === module) {
    const command = process.argv.slice(2).join(' ');
    if (!command) {
        console.error('Usage: node ag_bridge_client.js "명령어"');
        process.exit(1);
    }

    sendCommand(command)
        .then(res => {
            console.log('\n✅ [Antigravity 응답]');
            console.log(res.result);
            if (res.actions) {
                console.log('\n🛠 [수행된 작업]');
                res.actions.forEach(a => console.log(`- ${a}`));
            }
            process.exit(0);
        })
        .catch(err => {
            console.error(`\n❌ 오류: ${err.message}`);
            process.exit(1);
        });
}

module.exports = { sendCommand };
