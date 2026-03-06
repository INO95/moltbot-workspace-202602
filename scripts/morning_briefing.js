/**
 * 아침 브리핑 자동화
 * 매일 오전 7시에 실행되어 Telegram으로 종합 보고서 전송
 */

// 각 모듈 로드
const https = require('https');
const fs = require('fs');
const path = require('path');
const moltEngine = require('./molt_engine');
const { enqueueBridgePayload } = require('./bridge_queue');
const { readRecursiveImproveHealth } = require('./lib/recursive_improve_health');
const NIGHTLY_AUTOPILOT_LOG = path.join(__dirname, '..', 'logs', 'nightly_autopilot_latest.json');

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(raw));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.setTimeout(7000, () => req.destroy(new Error('weather timeout')));
        req.on('error', reject);
    });
}

function weatherCodeToKo(code) {
    const map = {
        0: '맑음',
        1: '대체로 맑음',
        2: '약간 흐림',
        3: '흐림',
        45: '안개',
        48: '서리 안개',
        51: '이슬비',
        53: '약한 비',
        55: '비',
        61: '비',
        63: '비',
        65: '강한 비',
        71: '눈',
        73: '눈',
        75: '강한 눈',
        80: '소나기',
        81: '소나기',
        82: '강한 소나기',
        95: '뇌우',
    };
    return map[code] || '날씨 정보';
}

async function fetchWeatherSummary() {
    const lat = Number(process.env.MORNING_BRIEFING_WEATHER_LAT || 35.6764);
    const lon = Number(process.env.MORNING_BRIEFING_WEATHER_LON || 139.6500);
    const tz = process.env.MORNING_BRIEFING_TIMEZONE || 'Asia/Tokyo';
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=${encodeURIComponent(tz)}&current=temperature_2m,apparent_temperature,weather_code&daily=sunrise,sunset&forecast_days=1`;
    const data = await httpGetJson(url);

    const cw = data.current || {};
    const daily = data.daily || {};
    const sunrise = Array.isArray(daily.sunrise) && daily.sunrise[0] ? String(daily.sunrise[0]).slice(11, 16) : '--:--';
    const sunset = Array.isArray(daily.sunset) && daily.sunset[0] ? String(daily.sunset[0]).slice(11, 16) : '--:--';
    const temp = Number.isFinite(cw.temperature_2m) ? Math.round(cw.temperature_2m) : null;
    const feels = Number.isFinite(cw.apparent_temperature) ? Math.round(cw.apparent_temperature) : null;
    const desc = weatherCodeToKo(cw.weather_code);

    return {
        desc,
        temp,
        feels,
        sunrise,
        sunset,
    };
}

async function generateMorningBriefing() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('ko-KR', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });

    let briefing = `🌅 **${dateStr} 아침 브리핑**\n\n`;

    // 1. 날씨 (실시간 API, 실패 시 폴백)
    try {
        const weather = await fetchWeatherSummary();
        const t = weather.temp == null ? '-' : `${weather.temp}°C`;
        const f = weather.feels == null ? '-' : `${weather.feels}°C`;
        briefing += `☀️ **날씨**: ${weather.desc}, ${t} (체감 ${f})\n`;
        briefing += `   일출 ${weather.sunrise} / 일몰 ${weather.sunset}\n\n`;
    } catch {
        briefing += `☀️ **날씨**: 실시간 정보 조회 실패\n`;
        briefing += `   일출 --:-- / 일몰 --:--\n\n`;
    }

    // 2. 오늘 할 일 (체크리스트에서)
    try {
        const today = await moltEngine.getTodaySummary();
        const todoItems = Object.entries(today).filter(([k, v]) => !v || v === '');

        if (todoItems.length > 0) {
            briefing += `📋 **오늘 해야 할 것**\n`;
            briefing += todoItems.slice(0, 5).map(([k]) => `   • ${k}`).join('\n');
            briefing += `\n\n`;
        }
    } catch (e) {
        // 체크리스트 없으면 생략
    }

    // 3. TOEIC 학습 리마인더
    briefing += `📚 **학습 리마인더**\n`;
    briefing += `   • TOEIC 문법 일일 퀴즈\n`;
    briefing += `   • Anki 복습 카드\n\n`;

    // 4. 야간 자동개선 요약
    try {
        if (fs.existsSync(NIGHTLY_AUTOPILOT_LOG)) {
            const raw = fs.readFileSync(NIGHTLY_AUTOPILOT_LOG, 'utf8');
            const report = JSON.parse(raw);
            const s = report && report.summary ? report.summary : null;
            if (s) {
                briefing += `🌙 **야간 자동개선 요약**\n`;
                briefing += `   점검 ${s.total || 0}건 / 성공 ${s.ok || 0} / 실패 ${s.failed || 0}\n`;
                if (Array.isArray(s.failedNames) && s.failedNames.length > 0) {
                    briefing += `   실패 항목: ${s.failedNames.slice(0, 3).join(', ')}\n`;
                }
                briefing += `\n`;
            }
        }
    } catch (_) {
        // 야간 리포트 파싱 실패는 브리핑 본문을 막지 않는다.
    }

    // 5. 자정 재귀개선 요약
    try {
        const recursiveImprove = readRecursiveImproveHealth(path.join(__dirname, '..'));
        briefing += `🛠️ **자정 재귀개선**\n`;
        if (!recursiveImprove.exists) {
            briefing += `   리포트 없음 · 자정 크론 및 latest 리포트를 확인하세요\n\n`;
        } else if (!recursiveImprove.fresh) {
            briefing += `   리포트 stale · 최근 자정 실행 결과가 오래되었습니다\n`;
            briefing += `   다음 조치: ${recursiveImprove.nextAction}\n\n`;
        } else if (recursiveImprove.ok) {
            briefing += `   성공`;
            if (recursiveImprove.preflightRepaired) briefing += ` · 워크트리 자동복구`;
            if (recursiveImprove.prUrl) briefing += ` · PR 생성/갱신`;
            briefing += `\n\n`;
        } else {
            briefing += `   실패 · ${recursiveImprove.failureCode || 'unknown'} · 연속 ${recursiveImprove.consecutiveFailures}회\n`;
            briefing += `   다음 조치: ${recursiveImprove.nextAction}\n\n`;
        }
    } catch (_) {
        briefing += `🛠️ **자정 재귀개선**: 요약 조회 실패\n\n`;
    }

    // 6. 마무리
    briefing += `━━━━━━━━━━━━━━━━━━━━\n`;
    briefing += `좋은 하루 되세요! 🚀\n`;
    briefing += `_Powered by Moltbot + Antigravity_`;

    return briefing;
}

// Telegram 알림 전송 (OpenClaw Bridge 활용)
async function sendToTelegram(message) {
    const payload = {
        taskId: `briefing-${Date.now()}`,
        command: `[NOTIFY] ${message}`,
        timestamp: new Date().toISOString(),
        status: 'pending'
    };

    enqueueBridgePayload(payload);
    console.log('📨 Briefing sent to Telegram queue');
}

// 실행
if (require.main === module) {
    generateMorningBriefing()
        .then(briefing => {
            console.log(briefing);
            return sendToTelegram(briefing);
        })
        .then(() => console.log('✅ Morning briefing complete'))
        .catch(err => console.error('Error:', err));
}

module.exports = { generateMorningBriefing, sendToTelegram };
