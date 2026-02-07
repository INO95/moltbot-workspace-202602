/**
 * 건강 관리 모듈
 * - 수면 데이터 분석 (MiBand → Google Fit)
 * - 운동 기록 및 휴식일 추적
 * - 영양 계산
 */

class HealthManager {
    constructor() {
        this.config = {
            bodyWeight: 70, // kg (사용자 설정 필요)
            proteinTarget: 1.6, // g per kg
            exerciseSchedule: {
                push: ['가슴', '삼두', '어깨 전면'],
                pull: ['등', '이두', '어깨 후면'],
                legs: ['하체', '코어'],
                cardio: ['러닝', '유산소', '조깅']
            },
            restDays: {
                push: 2,
                pull: 2,
                legs: 3,
                cardio: 1
            }
        };

        // 운동 기록 캐시
        this.exerciseHistory = [];
    }

    /**
     * 운동 타입 판별
     */
    categorizeExercise(input) {
        const text = input.toLowerCase();

        if (['가슴', '밀기', 'push', '삼두', '벤치'].some(k => text.includes(k))) {
            return { category: 'push', name: input };
        }
        if (['등', '당기기', 'pull', '이두', '로우'].some(k => text.includes(k))) {
            return { category: 'pull', name: input };
        }
        if (['하체', '스쿼트', '레그', '코어', '복근'].some(k => text.includes(k))) {
            return { category: 'legs', name: input };
        }
        if (['러닝', '런닝', '유산소', '조깅', '걷기', '존'].some(k => text.includes(k))) {
            return { category: 'cardio', name: input };
        }

        return { category: 'other', name: input };
    }

    /**
     * 다음 운동 부위 추천
     */
    getNextExerciseRecommendation(history = []) {
        // 최근 운동 기록에서 각 부위 마지막 날짜 확인
        const today = new Date();
        const lastWorkouts = {
            push: null,
            pull: null,
            legs: null,
            cardio: null
        };

        for (const record of history.reverse()) {
            const cat = this.categorizeExercise(record.exercise).category;
            if (cat !== 'other' && !lastWorkouts[cat]) {
                lastWorkouts[cat] = new Date(record.date);
            }
        }

        // 휴식일 계산
        const recommendations = [];
        for (const [category, lastDate] of Object.entries(lastWorkouts)) {
            const requiredRest = this.config.restDays[category];
            if (!lastDate) {
                recommendations.push({ category, priority: 'high', reason: '기록 없음' });
            } else {
                const daysSince = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));
                if (daysSince >= requiredRest) {
                    recommendations.push({ category, priority: 'ready', days: daysSince });
                }
            }
        }

        return recommendations;
    }

    /**
     * 일일 단백질 권장량 계산
     */
    getProteinTarget() {
        const target = Math.round(this.config.bodyWeight * this.config.proteinTarget);
        return {
            target,
            message: `🥩 일일 단백질 목표: ${target}g (체중 ${this.config.bodyWeight}kg × ${this.config.proteinTarget}g)`
        };
    }

    /**
     * 수면 데이터 분석 (Google Fit 연동 시)
     */
    analyzeSleepData(sleepRecords) {
        if (!sleepRecords || sleepRecords.length === 0) {
            return { message: '수면 데이터가 없습니다.' };
        }

        const avgHours = sleepRecords.reduce((sum, r) => sum + r.hours, 0) / sleepRecords.length;
        const avgDeepSleep = sleepRecords.reduce((sum, r) => sum + (r.deepSleepPercent || 0), 0) / sleepRecords.length;

        let recommendation = '';
        if (avgHours < 7) {
            recommendation = '⚠️ 수면 시간이 부족합니다. 7-8시간 권장.';
        } else if (avgDeepSleep < 15) {
            recommendation = '⚠️ 깊은 수면 비율이 낮습니다. 취침 전 카페인/스크린 제한 권장.';
        } else {
            recommendation = '✅ 수면 패턴이 양호합니다.';
        }

        return {
            avgHours: avgHours.toFixed(1),
            avgDeepSleepPercent: avgDeepSleep.toFixed(1),
            recommendation,
            message: `😴 주간 평균: ${avgHours.toFixed(1)}시간, 깊은잠 ${avgDeepSleep.toFixed(0)}%\n${recommendation}`
        };
    }

    /**
     * 주간 운동 요약
     */
    getWeeklySummary(exerciseRecords) {
        const counts = { push: 0, pull: 0, legs: 0, cardio: 0, other: 0 };

        for (const record of exerciseRecords) {
            const cat = this.categorizeExercise(record.exercise).category;
            counts[cat]++;
        }

        return {
            push: counts.push,
            pull: counts.pull,
            legs: counts.legs,
            cardio: counts.cardio,
            total: Object.values(counts).reduce((a, b) => a + b, 0),
            message: `🏋️ 주간 운동: 밀기${counts.push} 당기기${counts.pull} 하체${counts.legs} 유산소${counts.cardio}`
        };
    }
}

module.exports = new HealthManager();

// 테스트
if (require.main === module) {
    const health = new HealthManager();

    console.log('='.repeat(50));
    console.log('🏃 건강 관리 모듈 테스트');
    console.log('='.repeat(50));

    // 단백질 권장량
    console.log('\n' + health.getProteinTarget().message);

    // 운동 분류 테스트
    const tests = ['하체 스쿼트', '등 운동', '러닝 30분', '가슴 벤치프레스'];
    console.log('\n📋 운동 분류 테스트:');
    tests.forEach(t => {
        const cat = health.categorizeExercise(t);
        console.log(`  "${t}" → ${cat.category}`);
    });

    // 수면 분석 테스트
    const sleepData = [
        { hours: 7.5, deepSleepPercent: 18 },
        { hours: 6.5, deepSleepPercent: 15 },
        { hours: 8.0, deepSleepPercent: 22 }
    ];
    console.log('\n' + health.analyzeSleepData(sleepData).message);
}
