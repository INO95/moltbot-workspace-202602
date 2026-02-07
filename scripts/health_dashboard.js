/**
 * 통합 건강 관리 대시보드
 * - Apple Health / MiBand 데이터 연동
 * - 수면, 운동, 영양 분석
 * - 맞춤 추천 엔진
 */

const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const healthCapture = require('./health_capture');

const creds = require('../data/secure/google_creds.json');
const config = require('../data/config.json');

class HealthDashboard {
    constructor() {
        this.userProfile = {
            weight: 70, // kg
            height: 175, // cm
            age: 25,
            activityLevel: 'moderate', // sedentary, light, moderate, active, very_active
            goals: ['muscle_gain', 'endurance']
        };

        this.exerciseTypes = {
            push: { name: '밀기(가슴/삼두/어깨전면)', recovery: 48 },
            pull: { name: '당기기(등/이두/어깨후면)', recovery: 48 },
            legs: { name: '하체', recovery: 72 },
            core: { name: '코어', recovery: 24 },
            cardio: { name: '유산소', recovery: 24 }
        };

        this.nutritionTargets = {
            protein: () => this.userProfile.weight * 1.6, // g
            calories: () => this.calculateTDEE(),
            water: () => this.userProfile.weight * 35 // ml
        };
    }

    // 기초대사량 계산 (Mifflin-St Jeor)
    calculateBMR() {
        const { weight, height, age } = this.userProfile;
        return 10 * weight + 6.25 * height - 5 * age + 5;
    }

    // 총 일일 에너지 소비량
    calculateTDEE() {
        const bmr = this.calculateBMR();
        const multipliers = {
            sedentary: 1.2,
            light: 1.375,
            moderate: 1.55,
            active: 1.725,
            very_active: 1.9
        };
        return Math.round(bmr * multipliers[this.userProfile.activityLevel]);
    }

    // 운동 기록 파싱
    parseExerciseInput(text) {
        const result = {
            type: 'other',
            exercises: [],
            duration: null,
            notes: text
        };

        // 운동 종류 감지
        if (/하체|스쿼트|레그|런지/i.test(text)) result.type = 'legs';
        else if (/등|풀업|로우|랫/i.test(text)) result.type = 'pull';
        else if (/가슴|벤치|푸쉬|삼두/i.test(text)) result.type = 'push';
        else if (/복근|플랭크|코어/i.test(text)) result.type = 'core';
        else if (/러닝|런닝|유산소|걷기|조깅/i.test(text)) result.type = 'cardio';

        // 세트/횟수 파싱 (예: "스쿼트 60kg 5x5")
        const setMatch = text.match(/(\d+)\s*[xX×]\s*(\d+)/);
        if (setMatch) {
            result.sets = parseInt(setMatch[1]);
            result.reps = parseInt(setMatch[2]);
        }

        // 중량 파싱
        const weightMatch = text.match(/(\d+)\s*kg/i);
        if (weightMatch) {
            result.weight = parseInt(weightMatch[1]);
        }

        // 시간 파싱 (유산소용)
        const timeMatch = text.match(/(\d+)\s*분/);
        if (timeMatch) {
            result.duration = parseInt(timeMatch[1]);
        }

        return result;
    }

    // 다음 운동 추천
    async getNextWorkoutRecommendation(exerciseHistory = []) {
        const now = Date.now();
        const recoveryStatus = {};

        // 각 부위별 마지막 운동 시간 확인
        for (const [type, info] of Object.entries(this.exerciseTypes)) {
            const lastSession = exerciseHistory
                .filter(e => e.type === type)
                .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

            if (lastSession) {
                const hoursSince = (now - new Date(lastSession.date).getTime()) / (1000 * 60 * 60);
                recoveryStatus[type] = {
                    name: info.name,
                    hoursSince: Math.round(hoursSince),
                    recovered: hoursSince >= info.recovery,
                    readyIn: Math.max(0, info.recovery - hoursSince)
                };
            } else {
                recoveryStatus[type] = {
                    name: info.name,
                    hoursSince: 999,
                    recovered: true,
                    readyIn: 0
                };
            }
        }

        // 회복된 부위 중 가장 오래된 것 추천
        const recommendations = Object.entries(recoveryStatus)
            .filter(([_, status]) => status.recovered)
            .sort((a, b) => b[1].hoursSince - a[1].hoursSince)
            .slice(0, 3);

        return { recoveryStatus, recommendations };
    }

    // 수면 분석
    analyzeSleep(sleepData) {
        if (!sleepData || sleepData.length === 0) {
            return {
                message: '수면 데이터가 없습니다.',
                avgHours: '0.0',
                avgDeepPercent: '0.0',
                quality: 'unknown',
                suggestions: ['수면 데이터를 연동하면 정확한 분석이 가능합니다.'],
                score: 0,
            };
        }

        const avgHours = sleepData.reduce((sum, d) => sum + d.hours, 0) / sleepData.length;
        const avgDeep = sleepData.reduce((sum, d) => sum + (d.deepPercent || 20), 0) / sleepData.length;

        let quality = 'good';
        const suggestions = [];

        if (avgHours < 7) {
            quality = 'poor';
            suggestions.push('수면 시간이 부족합니다. 최소 7시간을 목표로 하세요.');
        }
        if (avgDeep < 15) {
            quality = quality === 'poor' ? 'poor' : 'fair';
            suggestions.push('깊은 수면 비율이 낮습니다. 취침 전 카페인/스크린 제한을 권장합니다.');
        }
        if (avgHours > 9) {
            suggestions.push('과수면은 피로감을 유발할 수 있습니다.');
        }

        return {
            avgHours: avgHours.toFixed(1),
            avgDeepPercent: avgDeep.toFixed(1),
            quality,
            suggestions,
            score: Math.round(Math.min(100, (avgHours / 8 * 50) + (avgDeep / 25 * 50)))
        };
    }

    // 오늘의 영양 목표
    getDailyNutritionTargets() {
        return {
            protein: Math.round(this.nutritionTargets.protein()),
            calories: this.nutritionTargets.calories(),
            water: Math.round(this.nutritionTargets.water() / 1000), // L
            message: `🥩 단백질: ${Math.round(this.nutritionTargets.protein())}g | 🔥 칼로리: ${this.nutritionTargets.calories()}kcal | 💧 수분: ${(this.nutritionTargets.water() / 1000).toFixed(1)}L`
        };
    }

    // 종합 대시보드 생성
    async generateDashboard(data = {}) {
        const fallbackHistory = healthCapture.getRecentExerciseHistory(21);
        const { exerciseHistory = fallbackHistory, sleepData = [] } = data;

        const nutrition = this.getDailyNutritionTargets();
        const sleep = this.analyzeSleep(sleepData);
        const workout = await this.getNextWorkoutRecommendation(exerciseHistory);

        return {
            date: new Date().toISOString().split('T')[0],
            nutrition,
            sleep,
            workout,
            summary: `
📊 **오늘의 건강 대시보드**
━━━━━━━━━━━━━━━━━━━━
${nutrition.message}

😴 **수면 품질**: ${sleep.quality} (${sleep.avgHours}시간, 깊은잠 ${sleep.avgDeepPercent}%)
${sleep.suggestions.length > 0 ? '  💡 ' + sleep.suggestions[0] : ''}

🏋️ **추천 운동**: ${workout.recommendations.length > 0 ? workout.recommendations[0][1].name : '휴식'}
━━━━━━━━━━━━━━━━━━━━
            `.trim()
        };
    }
}

module.exports = new HealthDashboard();

// 테스트
if (require.main === module) {
    const dashboard = new HealthDashboard();

    const testData = {
        exerciseHistory: [
            { type: 'push', date: '2026-02-05T10:00:00Z' },
            { type: 'legs', date: '2026-02-04T10:00:00Z' }
        ],
        sleepData: [
            { hours: 7.5, deepPercent: 18 },
            { hours: 6.5, deepPercent: 15 },
            { hours: 8.0, deepPercent: 22 }
        ]
    };

    dashboard.generateDashboard(testData).then(result => {
        console.log(result.summary);
    });
}
