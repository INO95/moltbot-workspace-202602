const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const creds = require('../data/secure/google_creds.json');
const config = require('../data/config.json');
const { sendCommand } = require('./ag_bridge_client');
const financeManager = require('./finance_manager');

class MoltEngine {
    constructor() {
        const auth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: [
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive'
            ],
        });
        this.doc = new GoogleSpreadsheet(config.spreadsheetId, auth);
        this.config = config;
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;
        await this.doc.loadInfo();
        console.log(`✅ Connected to: ${this.doc.title}`);
        this.initialized = true;
    }

    // ==================== 날짜 유틸리티 ====================

    getFormattedDate(date = new Date()) {
        const days = ['일', '월', '화', '수', '목', '금', '토'];
        const yy = String(date.getFullYear()).slice(-2);
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const day = days[date.getDay()];
        return `${yy} ${mm} ${dd} ${day}`;
    }

    getIsoDate(date = new Date()) {
        return date.toISOString().split('T')[0];
    }

    csvEscape(value) {
        const s = String(value ?? '');
        if (/[",\n]/.test(s)) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    }

    appendCsvRow(filePath, header, rowValues) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, `${header.join(',')}\n`, 'utf8');
        }
        const line = rowValues.map(v => this.csvEscape(v)).join(',');
        fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    }

    // ==================== 자연어 파싱 ====================

    /**
     * 자연어에서 금액 추출
     * 예: "커피 450", "1280엔 안약", "점심 1200円"
     */
    parseAmount(text) {
        // 숫자만 먼저 모두 찾기 (콤마 포함 또는 연속 숫자)
        const numbers = text.match(/\d+(?:,\d+)*|\d+/g);
        if (!numbers) return null;

        // 가장 큰 숫자를 금액으로 선택 (보통 금액이 가장 큼)
        let maxAmount = 0;
        for (const numStr of numbers) {
            const num = parseInt(numStr.replace(/,/g, ''));
            if (num > maxAmount) {
                maxAmount = num;
            }
        }

        return maxAmount > 0 ? maxAmount : null;
    }

    /**
     * 결제수단 추출
     */
    parsePaymentMethod(text) {
        const lowerText = text.toLowerCase();
        if (lowerText.includes('올리브')) {
            if (/(데빗|debit|체크)/i.test(lowerText)) {
                return '올리브 카드 (데빗)';
            }
            return '올리브 카드 (크레짓)';
        }
        if (lowerText.includes('아마존')) {
            return '아마존 카드';
        }

        let best = { method: '현금', score: 0 };
        for (const [method, info] of Object.entries(this.config.paymentMethods)) {
            const names = [method, ...(info.aliases || [])].map(v => String(v).toLowerCase());
            for (const name of names) {
                if (!name) continue;
                if (!lowerText.includes(name)) continue;
                const score = name.length;
                if (score > best.score) {
                    best = { method, score };
                }
            }
        }
        return best.method;
    }

    /**
     * 카테고리 자동 분류
     */
    parseCategory(text) {
        const lowerText = text.toLowerCase();

        for (const [category, info] of Object.entries(this.config.categories)) {
            for (const keyword of info.keywords || []) {
                if (lowerText.includes(keyword.toLowerCase())) {
                    return this.normalizeCategoryLabel(category, lowerText);
                }
            }
        }
        return this.normalizeCategoryLabel('기타', lowerText);
    }

    normalizeCategoryLabel(category, lowerText = '') {
        const map = {
            '교통비': '교통',
            '통신비': '통신',
            '생활용품': '생활',
        };
        let normalized = map[category] || category || '기타';
        if (/(약|안약|병원|약국|치과|건강|영양제)/i.test(lowerText || '')) {
            normalized = '건강';
        }
        return normalized;
    }

    hasSettlementKeyword(text) {
        return /(받음|받았다|돌려받|정산\s*받|환급|더치페이|몫|보내줌|송금받)/i.test(String(text || ''));
    }

    hasFoodKeyword(text) {
        return /(식비|점심|저녁|식당|카페|커피|외식|삼겹살|치킨|런치|디너|밥)/i.test(String(text || ''));
    }

    hasKnownSettlementPerson(text) {
        const names = Array.isArray(this.config.financePolicy?.settlementPeople)
            ? this.config.financePolicy.settlementPeople
            : [];
        const target = String(text || '').toLowerCase();
        return names.some(name => target.includes(String(name || '').toLowerCase()));
    }

    resolveFinanceCategory(rawCategory, text, intentType) {
        const lowerText = String(text || '').toLowerCase();
        if (intentType === 'reimbursement_food') return '식비정산환급';
        if (intentType === 'reimbursement') return '정산환급';
        return this.normalizeCategoryLabel(rawCategory, lowerText);
    }

    /**
     * 항목명 추출 (금액, 결제수단 제거 후 나머지)
     */
    parseItemName(text) {
        let item = text;

        // 금액 제거
        item = item.replace(/\d{1,3}(?:,\d{3})*|\d+/g, '');
        item = item.replace(/엔|円|yen/gi, '');

        // 결제수단 제거
        for (const [method, info] of Object.entries(this.config.paymentMethods)) {
            item = item.replace(new RegExp(method, 'gi'), '');
            for (const alias of info.aliases || []) {
                item = item.replace(new RegExp(alias, 'gi'), '');
            }
        }
        item = item.replace(/(신용카드|체크카드|카드|데빗|debit|체크|크레딧|크레짓)/gi, ' ');

        // 정리
        item = item.replace(/(으로|로|한테서|에게서|한테|에게)/g, ' ');
        item = item.replace(/[()[\],]/g, ' ');
        item = item.replace(/\s+/g, ' ').trim();
        return item || '항목';
    }

    /**
     * 수입인지 지출인지 판단
     */
    isIncome(text) {
        const incomeKeywords = ['월급', '급여', '입금', '보너스', '수입', '이자', '받음', '환급'];
        return incomeKeywords.some(k => text.includes(k));
    }

    hasActivityShortcut(text) {
        const lowerText = String(text || '').toLowerCase();
        return Object.keys(this.config.activityShortcuts || {}).some(shortcut =>
            lowerText.includes(shortcut.toLowerCase()),
        );
    }

    shouldTreatAsExpense(text) {
        const lowerText = String(text || '').toLowerCase();
        const wordPrefix = String(this.config.commandPrefixes?.word || '단어:').toLowerCase();
        if (lowerText.startsWith(wordPrefix)) return false;
        const amount = this.parseAmount(lowerText);
        if (!amount) return false;

        const financeHints = [
            '엔', '円', '원', '¥', '지출', '수입', '입금', '월급',
            '카드', '현금', '스미토모', '라쿠텐', '아마존', '올리브',
        ];
        const dynamicMethodHints = Object.keys(this.config.paymentMethods || {}).map(v => String(v).toLowerCase());

        // Avoid false positives such as "알고 3문제", "운동 30분".
        const hasFinanceHint =
            financeHints.some(h => lowerText.includes(h)) ||
            dynamicMethodHints.some(h => lowerText.includes(h));
        if (this.hasActivityShortcut(lowerText) && !hasFinanceHint) {
            return false;
        }

        return true;
    }

    splitIngestSegments(text) {
        const normalized = this.stripKnownPrefix(String(text || ''));
        return normalized
            .replace(/그리고/gi, ',')
            .replace(/[|/]/g, ',')
            .split(/\n|[,;]|(?:\s{2,})/)
            .map(s => s.trim())
            .filter(Boolean);
    }

    stripKnownPrefix(text) {
        const prefixes = Object.values(this.config.commandPrefixes || {})
            .map(v => String(v || '').trim())
            .filter(Boolean);
        for (const prefix of prefixes) {
            if (String(text).startsWith(prefix)) {
                return String(text).slice(prefix.length).trim();
            }
        }
        return String(text || '').trim();
    }

    parseReferencedCreditCards(text) {
        const lowerText = String(text || '').toLowerCase();
        const cards = [];
        const targetCards =
            Array.isArray(this.config.financePolicy?.creditCards) && this.config.financePolicy.creditCards.length > 0
                ? this.config.financePolicy.creditCards
                : Object.entries(this.config.paymentMethods || {})
                      .filter(([, info]) => info.type === 'credit')
                      .map(([name]) => name);

        for (const card of targetCards) {
            const info = this.config.paymentMethods[card];
            if (!info) continue;
            const names = [card, ...(info.aliases || [])].map(v => String(v).toLowerCase());
            if (names.some(name => lowerText.includes(name))) {
                cards.push(card);
            }
        }
        return [...new Set(cards)];
    }

    detectFinanceIntent(text, paymentMethod) {
        const lowerText = String(text || '').toLowerCase();
        const paymentType = this.config.paymentMethods[paymentMethod]?.type;

        if (/신용카드\s*대금|카드대금|카드\s*결제|대금\s*빠져나감|결제일/i.test(text)) {
            return { transactionType: 'credit_settlement', isIncome: false, category: '신용카드정산' };
        }
        if (/월급|급여|상여|보너스/i.test(text)) {
            return { transactionType: 'income_salary', isIncome: true, category: '급여' };
        }
        if (this.hasSettlementKeyword(text) && (this.hasFoodKeyword(text) || this.hasKnownSettlementPerson(text))) {
            return { transactionType: 'reimbursement_food', isIncome: true, category: '식비정산환급' };
        }
        if (this.hasSettlementKeyword(text)) {
            return { transactionType: 'reimbursement', isIncome: true, category: '정산환급' };
        }
        if (paymentType === 'credit') {
            return { transactionType: 'expense_credit', isIncome: false };
        }
        if (this.isIncome(lowerText)) {
            return { transactionType: 'income', isIncome: true };
        }
        return { transactionType: 'expense', isIncome: false };
    }

    previewFinanceParse(naturalText, memo = '') {
        const normalizedText = this.stripKnownPrefix(naturalText);
        const amount = this.parseAmount(normalizedText);
        if (!amount) {
            return { success: false, error: '금액을 찾을 수 없습니다.' };
        }
        let paymentMethod = this.parsePaymentMethod(normalizedText);
        const intent = this.detectFinanceIntent(normalizedText, paymentMethod);
        const referencedCards =
            intent.transactionType === 'credit_settlement' || intent.transactionType === 'expense_credit'
                ? this.parseReferencedCreditCards(normalizedText)
                : [];
        const category = this.resolveFinanceCategory(intent.category || this.parseCategory(normalizedText), normalizedText, intent.transactionType);
        let item = this.parseItemName(normalizedText);

        if (intent.transactionType === 'credit_settlement') {
            const paymentType = this.config.paymentMethods[paymentMethod]?.type;
            if (paymentType === 'credit' || !paymentMethod || paymentMethod === '현금') {
                paymentMethod = this.config.financePolicy?.defaultSettlementAccount || '스미토모';
            }
            if (!item || item === '항목') item = '신용카드 대금 결제';
        }
        if (intent.transactionType === 'income_salary') {
            if (paymentMethod === '현금' && this.config.financePolicy?.defaultIncomeAccount) {
                paymentMethod = this.config.financePolicy.defaultIncomeAccount;
            }
        }
        if ((intent.transactionType === 'reimbursement' || intent.transactionType === 'reimbursement_food') && (!item || item === '항목')) {
            item = '공동결제 정산 받음';
        }

        const finalAmount = intent.isIncome ? amount : -Math.abs(amount);
        const taggedMemo = [memo, `tx:${intent.transactionType}`].filter(Boolean).join(' | ');

        return {
            success: true,
            data: {
                item,
                amount: finalAmount,
                paymentMethod,
                category,
                transactionType: intent.transactionType,
                referencedCards,
                memo: taggedMemo,
            },
        };
    }

    // ==================== 가계부 기능 ====================

    /**
     * 자연어로 가계부 기록 (메인 함수)
     * 예: "커피 450", "점심 1200엔 아마존", "월급 265000 스미토모"
     */
    async parseAndRecordExpense(naturalText, memo = '') {
        const normalizedText = this.stripKnownPrefix(naturalText);
        const amount = this.parseAmount(normalizedText);
        if (!amount) {
            return { success: false, error: '금액을 찾을 수 없습니다.' };
        }

        let paymentMethod = this.parsePaymentMethod(normalizedText);
        const intent = this.detectFinanceIntent(normalizedText, paymentMethod);
        const referencedCards =
            intent.transactionType === 'credit_settlement' || intent.transactionType === 'expense_credit'
                ? this.parseReferencedCreditCards(normalizedText)
                : [];
        const category = this.resolveFinanceCategory(intent.category || this.parseCategory(normalizedText), normalizedText, intent.transactionType);
        const isIncome = intent.isIncome;
        let item = this.parseItemName(normalizedText);

        if (intent.transactionType === 'credit_settlement') {
            const paymentType = this.config.paymentMethods[paymentMethod]?.type;
            if (paymentType === 'credit' || !paymentMethod || paymentMethod === '현금') {
                paymentMethod = this.config.financePolicy?.defaultSettlementAccount || '스미토모';
            }
            if (!item || item === '항목') item = '신용카드 대금 결제';
        } else if (intent.transactionType === 'income_salary') {
            if (paymentMethod === '현금' && this.config.financePolicy?.defaultIncomeAccount) {
                paymentMethod = this.config.financePolicy.defaultIncomeAccount;
            }
        } else if ((intent.transactionType === 'reimbursement' || intent.transactionType === 'reimbursement_food') && (!item || item === '항목')) {
            item = '공동결제 정산 받음';
            if (!paymentMethod) paymentMethod = '현금';
        }

        // 지출이면 음수로 변환
        const finalAmount = isIncome ? amount : -Math.abs(amount);
        const taggedMemo = [memo, `tx:${intent.transactionType}`].filter(Boolean).join(' | ');
        const today = this.getFormattedDate();
        let remoteSynced = false;
        let remoteError = null;
        try {
            await this.init();
            const sheet = this.doc.sheetsByTitle[this.config.sheets.finance];
            if (!sheet) throw new Error(`시트 '${this.config.sheets.finance}'를 찾을 수 없습니다.`);
            await sheet.addRow({
                '날짜': today,
                '항목': item,
                '금액 (엔)': finalAmount,
                '결제수단': paymentMethod,
                '카테고리': category,
                '메모': taggedMemo
            });
            remoteSynced = true;
        } catch (error) {
            remoteError = error.message;
            this.logError(`Finance sheet sync skipped: ${error.message}`);
        }

        console.log(
            `💸 가계부 기록: ${item} (${finalAmount}엔) - ${paymentMethod} [${category}] (${intent.transactionType})` +
                (remoteSynced ? ' [remote=ok]' : ' [remote=skip]'),
        );

        // Keep a local ledger copy for audit/recovery even if remote sheets drift.
        let localTransactionId = null;
        try {
            const localTx = financeManager.addTransaction(
                item,
                finalAmount,
                category,
                paymentMethod,
                taggedMemo,
                {
                    transactionType: intent.transactionType,
                    meta: {
                        source: 'bridge',
                        referencedCards,
                    },
                },
            );
            localTransactionId = localTx.id;
            if (intent.transactionType === 'expense_credit') {
                financeManager.registerCreditCharge(paymentMethod, Math.abs(finalAmount));
            }
            if (intent.transactionType === 'credit_settlement') {
                financeManager.registerCreditSettlement(Math.abs(finalAmount), referencedCards);
            }
        } catch (error) {
            this.logError(`Local finance DB write failed: ${error.message}`);
        }

        // CSV mirror for Excel-friendly workflows and quick local fallback.
        try {
            this.appendCsvRow(
                path.join(__dirname, '../data/expenses.csv'),
                ['date', 'amount', 'category', 'payment_method', 'item', 'transaction_type', 'memo'],
                [this.getIsoDate(), finalAmount, category, paymentMethod, item, intent.transactionType, taggedMemo],
            );
        } catch (error) {
            this.logError(`Expense CSV write failed: ${error.message}`);
        }

        return {
            success: true,
            data: {
                date: today,
                item,
                amount: finalAmount,
                paymentMethod,
                category,
                transactionType: intent.transactionType,
                memo: taggedMemo,
                localTransactionId,
                remoteSynced,
                ...(remoteError ? { remoteError } : {}),
            }
        };
    }

    /**
     * 잔고 조회 (거래 기반 계산)
     */
    async getBalance(accountName = null) {
        await this.init();

        const sheet = this.doc.sheetsByTitle[this.config.sheets.finance];
        const rows = await sheet.getRows();

        const balances = {};

        // 각 계좌별 초기 잔고
        for (const [name, info] of Object.entries(this.config.accounts)) {
            balances[name] = info.initialBalance || 0;
        }

        // 거래 내역 합산
        for (const row of rows) {
            const amount = parseInt(row.get('금액 (엔)')) || 0;
            const method = row.get('결제수단');

            const methodInfo = this.config.paymentMethods[method];
            if (methodInfo) {
                // Credit card charges do not move bank balance until settlement.
                if (methodInfo.type === 'credit') {
                    continue;
                }
                const account = methodInfo.account;
                if (balances[account] !== undefined) {
                    balances[account] += amount;
                }
            }
        }

        if (accountName) {
            return { [accountName]: balances[accountName] || 0 };
        }

        return balances;
    }

    /**
     * 월별 통계
     */
    async getMonthlyStats(year = null, month = null) {
        await this.init();

        const now = new Date();
        year = year || now.getFullYear();
        month = month || now.getMonth() + 1;

        const sheet = this.doc.sheetsByTitle[this.config.sheets.finance];
        const rows = await sheet.getRows();

        const prefix = `${String(year).slice(-2)} ${String(month).padStart(2, '0')}`;

        let income = 0;
        let expense = 0;
        const byCategory = {};

        for (const row of rows) {
            const date = row.get('날짜') || '';
            if (!date.startsWith(prefix)) continue;

            const amount = parseInt(row.get('금액 (엔)')) || 0;
            const category = row.get('카테고리') || '기타';

            if (amount > 0) income += amount;
            else expense += amount;

            byCategory[category] = (byCategory[category] || 0) + amount;
        }

        const reimbursements = byCategory['정산환급'] || 0;
        const grossExpense = Math.abs(expense);
        const effectiveExpense = Math.max(0, grossExpense - Math.max(0, reimbursements));

        return {
            year,
            month,
            income,
            expense,
            balance: income + expense,
            byCategory,
            reimbursements,
            grossExpense,
            effectiveExpense,
        };
    }

    getCreditLiabilityStatus() {
        try {
            return financeManager.getCreditLiabilities();
        } catch (error) {
            this.logError(`Credit liability read failed: ${error.message}`);
            return {};
        }
    }

    // ==================== 체크리스트 기능 ====================

    /**
     * 오늘 자 행 가져오기 (없으면 생성)
     */
    async getOrCreateTodayRow() {
        await this.init();

        const sheet = this.doc.sheetsByTitle[this.config.sheets.checklist];
        const rows = await sheet.getRows();
        const today = this.getFormattedDate();

        let row = rows.find(r => r.get('날짜') === today);

        if (!row) {
            row = await sheet.addRow({ '날짜': today });
            console.log(`✨ 새로운 체크리스트 행 생성: ${today}`);
        }

        return row;
    }

    /**
     * 활동 기록 (단축어 지원)
     * 예: "운완", "안키", "알고3", "운동 하체"
     */
    async recordActivity(text) {
        const lowerText = text.toLowerCase();
        let recorded = [];

        // 단축어 처리
        for (const [shortcut, info] of Object.entries(this.config.activityShortcuts)) {
            if (lowerText.includes(shortcut.toLowerCase())) {
                const column = info.column;
                let value = info.value;

                // 값이 null이면 추가 정보 추출 (예: "알고3" -> "3문제")
                if (value === null) {
                    const match = text.match(new RegExp(`${shortcut}\\s*(\\d+|\\S+)`, 'i'));
                    if (match && match[1]) {
                        value = shortcut === '알고' || shortcut === '알고리즘'
                            ? `${match[1]}문제`
                            : match[1];
                    } else {
                        value = 'O';
                    }
                }

                recorded.push({ column, value });
                console.log(`📝 ${column}: ${value}`);
            }
        }

        // 단축어에 매칭되지 않으면 기타에 기록
        if (recorded.length === 0) {
            recorded.push({ column: '기타', value: text });
            console.log(`📝 기타: ${text}`);
        }

        let remoteSynced = false;
        let remoteError = null;
        try {
            const row = await this.getOrCreateTodayRow();
            for (const rec of recorded) {
                if (rec.column === '기타') {
                    const existing = row.get('기타') || '';
                    const newValue = existing ? `${existing}, ${rec.value}` : rec.value;
                    row.set('기타', newValue);
                } else {
                    row.set(rec.column, rec.value);
                }
            }
            await row.save();
            remoteSynced = true;
        } catch (error) {
            remoteError = error.message;
            this.logError(`Checklist sheet sync skipped: ${error.message}`);
        }

        try {
            for (const rec of recorded) {
                this.appendCsvRow(
                    path.join(__dirname, '../data/todos.csv'),
                    ['date', 'task', 'status', 'completed_at'],
                    [this.getIsoDate(), rec.column, rec.value, new Date().toISOString()],
                );
            }
        } catch (error) {
            this.logError(`Checklist CSV write failed: ${error.message}`);
        }

        return {
            success: true,
            recorded,
            remoteSynced,
            ...(remoteError ? { remoteError } : {}),
        };
    }

    /**
     * 오늘 기록 요약
     */
    async getTodaySummary() {
        try {
            const row = await this.getOrCreateTodayRow();
            const sheet = this.doc.sheetsByTitle[this.config.sheets.checklist];

            const summary = {};
            for (const header of sheet.headerValues) {
                const value = row.get(header);
                if (value) {
                    summary[header] = value;
                }
            }
            return summary;
        } catch (error) {
            const csvPath = path.join(__dirname, '../data/todos.csv');
            const today = this.getIsoDate();
            if (!fs.existsSync(csvPath)) {
                return { error: `체크리스트 조회 실패: ${error.message}` };
            }
            const lines = fs.readFileSync(csvPath, 'utf8').split('\n').slice(1).filter(Boolean);
            const summary = {};
            for (const line of lines) {
                const [date, task, status] = line.split(',');
                if (date !== today) continue;
                summary[task] = status;
            }
            if (Object.keys(summary).length === 0) {
                summary.error = `체크리스트 조회 실패(원격), 로컬 데이터 없음: ${error.message}`;
            }
            return summary;
        }
    }

    async ingestNaturalText(text) {
        const raw = String(text || '').trim();
        const wordPrefix = this.config.commandPrefixes?.word || '단어:';
        const healthPrefix = this.config.commandPrefixes?.health || '운동:';
        if (raw.startsWith(wordPrefix) || raw.startsWith(healthPrefix)) {
            return {
                input: text,
                segments: 0,
                finance: [],
                checklist: [],
                skipped: [text],
            };
        }

        const segments = this.splitIngestSegments(text);
        const result = {
            input: text,
            segments: segments.length,
            finance: [],
            checklist: [],
            skipped: [],
        };

        for (const segment of segments) {
            const hasChecklist = this.hasActivityShortcut(segment);
            const hasExpense = this.shouldTreatAsExpense(segment);

            if (!hasChecklist && !hasExpense) {
                result.skipped.push(segment);
                continue;
            }

            if (hasExpense) {
                const expense = await this.parseAndRecordExpense(segment);
                if (expense && expense.success) {
                    result.finance.push(expense.data);
                } else {
                    result.skipped.push(segment);
                }
            }

            if (hasChecklist) {
                const check = await this.recordActivity(segment);
                result.checklist.push(check);
            }
        }

        return result;
    }

    // ==================== 브릿지 & 원격 기능 ====================

    /**
     * Antigravity에게 원격 명령 전달
     */
    async handleRemoteCommand(command) {
        try {
            const response = await sendCommand(command);
            return {
                success: true,
                message: response.result,
                actions: response.actions
            };
        } catch (error) {
            this.logError(`Remote command failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 에러 로그 기록 (Self-Healing용)
     */
    logError(message) {
        const errorLogPath = path.join(__dirname, '../logs/error.log');
        const logDir = path.dirname(errorLogPath);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] Error: ${message}\n`;

        fs.appendFileSync(errorLogPath, logEntry);
        console.error(`❌ Error logged: ${message}`);
    }
}

module.exports = new MoltEngine();
