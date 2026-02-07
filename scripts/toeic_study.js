/**
 * TOEIC 학습 모듈
 * 6주 900점 도전 프로젝트
 * 
 * 주요 기능:
 * - 일일 문법 퀴즈 (Part 5, 6 집중)
 * - 오답 노트 및 분석
 * - Anki 카드 자동 생성
 * - 진도 추적
 */

const engine = require('./molt_engine.js');

class TOEICStudy {
    constructor() {
        this.config = {
            currentLevel: 700,
            targetLevel: 900,
            examDate: '2026-03-22', // 약 6주 후
            focusAreas: ['grammar', 'part5', 'part6']
        };

        // 핵심 문법 포인트 (Part 5, 6 빈출)
        this.grammarTopics = {
            week1_2: [
                { topic: 'verb_tenses', name: '동사 시제', examples: ['have been', 'will be', 'had done'] },
                { topic: 'subject_verb_agreement', name: '주어-동사 일치', examples: ['The number of...is', 'A variety of...are'] },
                { topic: 'word_forms', name: '품사 구별', examples: ['-tion(명)', '-ly(부)', '-ive(형)'] }
            ],
            week3_4: [
                { topic: 'conditionals', name: '조건문', examples: ['If...were', 'Had...known'] },
                { topic: 'connectors', name: '접속사/전치사', examples: ['despite/although', 'due to/because'] },
                { topic: 'relative_clauses', name: '관계사', examples: ['which/that', 'whose', 'in which'] }
            ],
            week5_6: [
                { topic: 'modals', name: '조동사', examples: ['should have done', 'must be'] },
                { topic: 'comparatives', name: '비교급', examples: ['more...than', 'as...as', 'the + 비교급'] },
                { topic: 'parallelism', name: '병렬 구조', examples: ['not only A but also B', 'both A and B'] }
            ]
        };

        // 문법 퀴즈 데이터 (Part 5 스타일)
        this.quizBank = [
            {
                id: 1,
                topic: 'verb_tenses',
                question: 'The project _____ by the time the manager arrives tomorrow.',
                options: ['A) will complete', 'B) will be completed', 'C) completes', 'D) completed'],
                answer: 'B',
                explanation: '미래 완료 수동태. "내일 도착할 때까지" → 미래 시점 기준 완료'
            },
            {
                id: 2,
                topic: 'subject_verb_agreement',
                question: 'The number of employees who work remotely _____ increased significantly.',
                options: ['A) have', 'B) has', 'C) are', 'D) were'],
                answer: 'B',
                explanation: '"The number of"는 단수 취급 → has. cf) "A number of"는 복수'
            },
            {
                id: 3,
                topic: 'word_forms',
                question: 'The manager made a _____ decision regarding the budget.',
                options: ['A) strategy', 'B) strategic', 'C) strategically', 'D) strategize'],
                answer: 'B',
                explanation: '명사(decision) 앞에는 형용사(strategic)가 와야 함'
            },
            {
                id: 4,
                topic: 'connectors',
                question: '_____ the heavy rain, the outdoor event was postponed.',
                options: ['A) Because', 'B) Although', 'C) Due to', 'D) Despite of'],
                answer: 'C',
                explanation: '"Due to + 명사구", "Because + 절". "Despite of"는 틀림 (Despite만 사용)'
            },
            {
                id: 5,
                topic: 'conditionals',
                question: 'If the proposal _____ earlier, we could have started the project last month.',
                options: ['A) approved', 'B) was approved', 'C) had been approved', 'D) has been approved'],
                answer: 'C',
                explanation: '가정법 과거완료: If + had p.p., ... could have p.p.'
            }
        ];
    }

    /**
     * 현재 학습 주차 계산
     */
    getCurrentWeek() {
        const startDate = new Date('2026-02-05');
        const today = new Date();
        const diffDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
        const week = Math.floor(diffDays / 7) + 1;
        return Math.min(week, 6);
    }

    /**
     * 이번 주 학습 주제 가져오기
     */
    getWeeklyTopics() {
        const week = this.getCurrentWeek();
        if (week <= 2) return this.grammarTopics.week1_2;
        if (week <= 4) return this.grammarTopics.week3_4;
        return this.grammarTopics.week5_6;
    }

    /**
     * 일일 문법 퀴즈 생성 (랜덤 5문제)
     */
    getDailyQuiz(count = 5) {
        const shuffled = [...this.quizBank].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, Math.min(count, shuffled.length));
    }

    /**
     * 퀴즈 포맷팅 (텔레그램용)
     */
    formatQuizForTelegram(quiz) {
        let message = `📝 **TOEIC 문법 퀴즈** (${quiz.length}문제)\n\n`;

        quiz.forEach((q, i) => {
            message += `**문제 ${i + 1}** [${q.topic}]\n`;
            message += `${q.question}\n`;
            message += q.options.join('\n') + '\n\n';
        });

        return message;
    }

    /**
     * 정답 및 해설 포맷팅
     */
    formatAnswers(quiz) {
        let message = `✅ **정답 및 해설**\n\n`;

        quiz.forEach((q, i) => {
            message += `**${i + 1}. 정답: ${q.answer}**\n`;
            message += `💡 ${q.explanation}\n\n`;
        });

        return message;
    }

    /**
     * 오답 기록 (구글 시트에 저장)
     */
    async recordMistake(questionId, topic, userAnswer) {
        // 나중에 구글 시트 연동
        console.log(`❌ 오답 기록: Q${questionId} [${topic}] - 선택: ${userAnswer}`);
        return {
            logged: true,
            suggestion: `📖 ${topic} 관련 복습이 필요합니다.`
        };
    }

    /**
     * 학습 진도 요약
     */
    getProgressSummary() {
        const week = this.getCurrentWeek();
        const daysRemaining = Math.floor((new Date(this.config.examDate) - new Date()) / (1000 * 60 * 60 * 24));
        const topics = this.getWeeklyTopics();

        return {
            currentWeek: week,
            daysUntilExam: daysRemaining,
            weeklyFocus: topics.map(t => t.name).join(', '),
            currentLevel: this.config.currentLevel,
            targetLevel: this.config.targetLevel,
            message: `📊 Week ${week}/6 | D-${daysRemaining} | 목표: ${this.config.targetLevel}점\n이번 주 집중: ${topics.map(t => t.name).join(', ')}`
        };
    }

    /**
     * Anki 카드 형식 생성 (문법 규칙용)
     */
    createAnkiCard(topic, rule, example) {
        return {
            deckName: 'TOEIC::Grammar',
            modelName: 'Basic',
            fields: {
                Front: `[TOEIC 문법] ${topic}`,
                Back: `${rule}\n\n예시: ${example}`
            },
            tags: ['toeic', 'grammar', topic.replace(/\s/g, '_')]
        };
    }
}

module.exports = new TOEICStudy();

// 테스트 실행
if (require.main === module) {
    const toeic = new TOEICStudy();

    console.log('='.repeat(50));
    console.log('🎯 TOEIC 900점 프로젝트');
    console.log('='.repeat(50));

    // 진도 요약
    const progress = toeic.getProgressSummary();
    console.log('\n' + progress.message);

    // 일일 퀴즈
    console.log('\n' + '='.repeat(50));
    const quiz = toeic.getDailyQuiz(3);
    console.log(toeic.formatQuizForTelegram(quiz));
    console.log(toeic.formatAnswers(quiz));
}
