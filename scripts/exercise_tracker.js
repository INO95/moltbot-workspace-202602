/**
 * 운동 기록 및 추천 시스템
 * - 웨이트/러닝 입력 파싱
 * - Google Sheets 자동 기록
 * - 부위별 휴식일 관리 및 다음 운동 추천
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

const creds = require('../data/secure/google_creds.json');
const config = require('../data/config.json');
const healthDashboard = require('./health_dashboard');

class ExerciseTracker {
    constructor() {
        this.auth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        this.doc = new GoogleSpreadsheet(config.spreadsheetId, this.auth);
        this.initialized = false;

        this.sheetName = '운동기록';
    }

    async init() {
        if (this.initialized) return;
        await this.doc.loadInfo();
        this.initialized = true;

        // 운동기록 시트가 없으면 생성
        if (!this.doc.sheetsByTitle[this.sheetName]) {
            await this.doc.addSheet({
                title: this.sheetName,
                headerValues: ['날짜', '시간', '종류', '부위', '운동명', '세트', '횟수', '중량(kg)', '소요시간(분)', '메모', '컨디션']
            });
            console.log(`✅ Created new sheet: ${this.sheetName}`);
        }
    }

    // 운동 기록 추가
    async recordExercise(input, memo = '') {
        await this.init();

        const parsed = healthDashboard.parseExerciseInput(input);
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toTimeString().slice(0, 5);

        const sheet = this.doc.sheetsByTitle[this.sheetName];

        const rowData = {
            '날짜': dateStr,
            '시간': timeStr,
            '종류': parsed.type,
            '부위': healthDashboard.exerciseTypes[parsed.type]?.name || '기타',
            '운동명': input.split(/\d/)[0].trim() || input,
            '세트': parsed.sets || '',
            '횟수': parsed.reps || '',
            '중량(kg)': parsed.weight || '',
            '소요시간(분)': parsed.duration || '',
            '메모': memo,
            '컨디션': ''
        };

        await sheet.addRow(rowData);

        console.log(`🏋️ 운동 기록 완료: ${rowData['부위']} - ${rowData['운동명']}`);

        // 다음 운동 추천 계산
        const history = await this.getRecentHistory(7);
        const recommendation = await healthDashboard.getNextWorkoutRecommendation(history);

        return {
            recorded: rowData,
            recommendation
        };
    }

    // 러닝/유산소 기록
    async recordCardio(distanceKm, durationMin, memo = '') {
        await this.init();

        const now = new Date();
        const sheet = this.doc.sheetsByTitle[this.sheetName];

        const pace = durationMin / distanceKm;
        const paceStr = `${Math.floor(pace)}'${Math.round((pace % 1) * 60)}"`;

        const rowData = {
            '날짜': now.toISOString().split('T')[0],
            '시간': now.toTimeString().slice(0, 5),
            '종류': 'cardio',
            '부위': '유산소',
            '운동명': `러닝 ${distanceKm}km`,
            '세트': '',
            '횟수': '',
            '중량(kg)': '',
            '소요시간(분)': durationMin,
            '메모': `페이스: ${paceStr}/km ${memo}`.trim(),
            '컨디션': ''
        };

        await sheet.addRow(rowData);
        console.log(`🏃 러닝 기록: ${distanceKm}km / ${durationMin}분 (${paceStr}/km)`);

        return { recorded: rowData };
    }

    // 최근 운동 기록 조회
    async getRecentHistory(days = 7) {
        await this.init();

        const sheet = this.doc.sheetsByTitle[this.sheetName];
        if (!sheet) return [];

        const rows = await sheet.getRows();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const history = [];
        for (const row of rows) {
            const dateStr = row.get('날짜');
            if (!dateStr) continue;

            const date = new Date(dateStr);
            if (date >= cutoff) {
                history.push({
                    date: dateStr,
                    type: row.get('종류'),
                    name: row.get('운동명'),
                    sets: row.get('세트'),
                    reps: row.get('횟수'),
                    weight: row.get('중량(kg)'),
                    duration: row.get('소요시간(분)')
                });
            }
        }

        return history;
    }

    // 부위별 볼륨 분석
    async analyzeWeeklyVolume() {
        const history = await this.getRecentHistory(7);

        const volumeByType = {};
        for (const entry of history) {
            const type = entry.type || 'other';
            if (!volumeByType[type]) {
                volumeByType[type] = { sessions: 0, totalSets: 0, totalWeight: 0 };
            }
            volumeByType[type].sessions++;
            volumeByType[type].totalSets += parseInt(entry.sets) || 0;
            volumeByType[type].totalWeight += (parseInt(entry.sets) || 0) * (parseInt(entry.reps) || 0) * (parseInt(entry.weight) || 0);
        }

        // 부족한 부위 찾기
        const allTypes = ['push', 'pull', 'legs', 'core', 'cardio'];
        const missing = allTypes.filter(t => !volumeByType[t] || volumeByType[t].sessions === 0);

        return {
            volumeByType,
            missing,
            recommendation: missing.length > 0
                ? `💪 이번 주 빠진 부위: ${missing.map(t => healthDashboard.exerciseTypes[t]?.name || t).join(', ')}`
                : '✅ 모든 부위 균형 잡힌 운동 완료!'
        };
    }
}

module.exports = new ExerciseTracker();

// 테스트
if (require.main === module) {
    const tracker = new ExerciseTracker();

    // 예시 입력 테스트
    console.log('Parsing: "벤치프레스 80kg 4x8"');
    console.log(healthDashboard.parseExerciseInput('벤치프레스 80kg 4x8'));

    console.log('\nParsing: "러닝 5km 25분"');
    console.log(healthDashboard.parseExerciseInput('러닝 5km 25분'));
}
