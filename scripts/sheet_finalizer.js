/**
 * Google Sheets Finalizer (v6 - Fix Everything)
 * - 날짜: 'YY MM DD 요일' 및 'YYYY MM DD' 등 다양한 포맷 강력 파싱
 * - 금액: 소스별 부호 차이(V2는 음수, 사본은 양수) 자동 보정
 * - 잔고: 26-02-04 기준점 사용하되, 흐름(Flow) 계산을 정교화
 * - 요약: 날짜 파싱이 잘 되면 자동으로 해결됨
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../data/secure/google_creds.json');
const config = require('../data/config.json');
class SheetFinalizer {
    constructor() {
        this.auth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        this.doc = new GoogleSpreadsheet(config.spreadsheetId, this.auth);

        // 기준점 (2026-02-04 점심 마파두부)
        // 스미토모: 206288 / 현금: 3268 / 라쿠텐: 13047 (사본 기록값)
        // 주의: 이 값은 해당 거래 '후' 잔고인지 '전' 잔고인지? 보통 가계부는 '후' 잔고.
        this.refPoint = {
            dateStr: '2026-02-04',
            itemKeyword: '마파두부',
            balances: { sum: 206288, rak: 13047, cas: 5515 } // *현금 5515 아님? 로그엔 5515였는데 사용자는 3268이라 함. 사용자 말 따름.
            // 정정: 사용자 요청 "현금 3268". (로그의 5515는 계산된 값일 수 있음).
        };
        this.userRefCash = 3268;

        // User-approved canonical choices for ambiguous duplicate transactions.
        this.manualChoices = new Map([
            ['2025-12-22|승민이 사다줄 담배|520|OUT', { method: '현금', category: '기타' }],
            ['2026-02-04|안약 6개|1280|OUT', { method: '올리브 카드 (크레짓)', category: '건강' }],
        ]);

        // User-requested test rows to exclude from final sheets.
        this.excludeEntries = new Set([
            '2026-02-05|테스트|100|OUT',
        ]);

        // User-confirmed exception: this withdrawal was exchanged/spent outside tracked cash pool.
        this.withdrawalNoCashIncrease = new Set([
            '2025-12-24|현금 인출|100000',
        ]);

        // User-confirmed monthly summary baseline (authoritative for these months).
        this.summaryOverrides = {
            '급여': { '25년 10월': 263119, '25년 11월': 263119, '25년 12월': 263119, '26년 01월': 265275 },
            '이자': { '25년 10월': 0, '25년 11월': 0, '25년 12월': 0, '26년 01월': 0, '26년 02월': 0 },
            '기타': { '25년 10월': 0, '25년 11월': 65140, '25년 12월': 8923, '26년 01월': 657, '26년 02월': 0 },
            '월세': { '25년 10월': 80830, '25년 11월': 80830, '25년 12월': 80830, '26년 01월': 90830 },
            '통신': { '25년 10월': 4675, '25년 11월': 7425, '25년 12월': 7425, '26년 01월': 866 },
            '교육': { '25년 10월': 3695, '25년 11월': 3743, '25년 12월': 3734, '26년 01월': 10710, '26년 02월': 782 },
            '건강': { '25년 10월': 2120, '25년 11월': 2120, '25년 12월': 0, '26년 01월': 6492, '26년 02월': 1280 },
            '식비': { '25년 10월': 42774, '25년 11월': 41044, '25년 12월': 63169, '26년 01월': 53785, '26년 02월': 12686 },
            '식비(총무)': { '25년 10월': 60534, '25년 11월': 65794, '25년 12월': 20378, '26년 01월': 30524 },
            '계좌이체(식비받은거)': { '25년 10월': 22384, '25년 11월': 34393, '25년 12월': 14900, '26년 01월': 15390 },
            '현금받음(식비)': { '25년 10월': 18200, '25년 11월': 7100, '25년 12월': 4100, '26년 01월': 5800 },
            '실질 식비 합계': { '25년 10월': 62724, '25년 11월': 65345, '25년 12월': 64547, '26년 01월': 63119, '26년 02월': 12686 },
            '교통': { '25년 10월': 23160, '25년 11월': 29710, '25년 12월': 4300, '26년 01월': 28710, '26년 02월': 26710 },
            '생활': { '25년 10월': 33844, '25년 11월': 35338, '25년 12월': 49059, '26년 01월': 20150 },
            '미용': { '25년 10월': 12106, '25년 11월': 0, '25년 12월': 0, '26년 01월': 26013 },
            '취미': { '25년 10월': 700, '25년 11월': 0, '25년 12월': 0, '26년 01월': 4160 },
            'ATM 출금': { '25년 10월': 5000, '25년 11월': 0, '25년 12월': 100000, '26년 01월': 10000 },
            '계좌이체(보냄)': { '25년 11월': 1162 },
            '투자': {},
            '아마존 카드값': { '25년 10월': 167498, '25년 11월': 161084, '25년 12월': 116293, '26년 01월': 107296, '26년 02월': 672 },
            '올리브 카드값': { '25년 10월': 0, '25년 11월': 0, '25년 12월': 0, '26년 01월': 38444, '26년 02월': 38539 },
            '월말 스미토모': { '25년 10월': 174662, '25년 11월': 254842, '25년 12월': 165593, '26년 01월': 206288, '26년 02월': 206288 },
            '월말 라쿠텐': { '25년 10월': 13047, '25년 11월': 13047, '25년 12월': 13047, '26년 01월': 13047 },
            '월말 현금': { '25년 10월': 13933, '25년 11월': 16391, '25년 12월': 2606, '26년 01월': 5515, '26년 02월': 3268 },
        };
    }

    async init() {
        await this.doc.loadInfo();
    }

    parseDate(raw) {
        if (!raw) return null;
        let str = String(raw).trim();

        // Excel Serial Number (e.g. 45000)
        if (/^\d{5}$/.test(str)) {
            // Google Sheets / Excel base date is Dec 30 1899
            const date = new Date(1899, 11, 30);
            date.setDate(date.getDate() + parseInt(str));
            return date.toISOString().split('T')[0];
        }

        // 25 04 24 목
        if (/^\d{2}\s\d{2}\s\d{2}/.test(str)) {
            const parts = str.split(' '); // ['25', '04', '24', '목']
            return `20${parts[0]}-${parts[1]}-${parts[2]}`;
        }

        // 2025 04 24
        if (/^\d{4}\s\d{2}\s\d{2}/.test(str)) {
            return str.replace(/\s/g, '-');
        }

        // YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

        return null;
    }

    inferCategory(item, currentCat) {
        const i = item.toLowerCase();
        // 기 분류된 것 우선 (단, '기타' 제외)
        if (currentCat && currentCat !== '기타' && currentCat !== '') return currentCat;

        if (i.includes('급여') || i.includes('월급')) return '급여';
        if (i.includes('이자')) return '이자';
        if (i.includes('월세')) return '월세';
        if (i.includes('통신') || i.includes('ahamo') || i.includes('softbank')) return '통신';
        if (i.includes('식비') || i.includes('로손') || i.includes('세븐') || i.includes('패밀리') || i.includes('마트') || i.includes('런치') || i.includes('점심') || i.includes('저녁') || i.includes('식당') || i.includes('커피') || i.includes('카페')) return '식비';
        if (i.includes('교통') || i.includes('suica') || i.includes('지하철') || i.includes('버스')) return '교통';
        if (i.includes('생활') || i.includes('아마존') || i.includes('다이소') || i.includes('니토리')) return '생활'; // 아마존도 생활로
        if (i.includes('미용') || i.includes('컷트')) return '미용';

        return '기타';
    }

    normalizeLabel(value) {
        return String(value || '').trim();
    }

    extractMemoCategoryLabel(memo) {
        const raw = this.normalizeLabel(memo);
        if (!raw) return '';
        const parts = raw
            .split('|')
            .map(v => this.normalizeLabel(v))
            .filter(Boolean);
        const userPart = parts.find(v => !/^tx:/i.test(v));
        return userPart || '';
    }

    // User rule: prefer memo text as canonical category label.
    resolveUnifiedCategory(baseCategory, memo, item) {
        const memoLabel = this.extractMemoCategoryLabel(memo);
        if (memoLabel) return memoLabel;
        const baseLabel = this.normalizeLabel(baseCategory);
        if (baseLabel) return baseLabel;
        return this.inferCategory(item, '');
    }

    toNumber(value) {
        return parseInt(String(value || 0).replace(/,/g, ''), 10) || 0;
    }

    inferPaymentInfo(methodLabel) {
        const raw = this.normalizeLabel(methodLabel);
        const lower = raw.toLowerCase();

        // Hard rule: plain olive card means credit unless debit/check hint is explicit.
        if (/올리브/.test(raw)) {
            if (/(체크|데빗|debit)/i.test(raw)) return { type: 'debit', account: '스미토모' };
            return { type: 'credit', account: '스미토모' };
        }
        if (/아마존/.test(raw)) return { type: 'credit', account: '스미토모' };

        let bestMatch = null;
        for (const [name, info] of Object.entries(config.paymentMethods || {})) {
            const candidates = [name, ...(info.aliases || [])]
                .map(v => this.normalizeLabel(v).toLowerCase())
                .filter(Boolean);
            for (const token of candidates) {
                if (!(lower.includes(token) || token.includes(lower))) continue;
                const score = token.length;
                if (!bestMatch || score > bestMatch.score) {
                    bestMatch = {
                        score,
                        type: info.type || '',
                        account: info.account || '',
                    };
                }
            }
        }
        if (bestMatch) return { type: bestMatch.type, account: bestMatch.account };

        if (lower.includes('현금')) return { type: 'cash', account: '현금' };
        if (lower.includes('스미토모')) return { type: 'bank_transfer', account: '스미토모' };
        if (lower.includes('라쿠텐')) return { type: 'bank_transfer', account: '라쿠텐' };
        return { type: '', account: '' };
    }

    normalizePaymentMethodLabel(methodLabel) {
        const raw = this.normalizeLabel(methodLabel);
        const lower = raw.toLowerCase();
        if (!raw) return '현금';
        if (raw.includes('현금 인출') || lower.includes('atm')) return '현금 인출';
        if (/올리브/.test(raw)) {
            return /(체크|데빗|debit)/i.test(raw) ? '올리브 카드 (데빗)' : '올리브 카드 (크레짓)';
        }
        if (/아마존/.test(raw)) return '아마존 카드';
        if (/라쿠텐/.test(raw) && /(체크|데빗|debit)/i.test(raw)) return '라쿠텐 체크카드';

        const pay = this.inferPaymentInfo(raw);
        if (pay.type === 'debit' && /라쿠텐/.test(raw)) return '라쿠텐 체크카드';
        if (/스미토모/.test(raw)) return '스미토모';
        if (/라쿠텐/.test(raw)) return '라쿠텐';
        if (/현금/.test(raw)) return '현금';
        return raw;
    }

    hasSettlementKeyword(text) {
        return /(받은거|받음|더치페이|정산|몫|보내줌|송금받음|돌려받|환급)/.test(String(text || ''));
    }

    hasFoodKeyword(text) {
        return /(식비|점심|저녁|식당|카페|커피|외식|삼겹살|치킨|런치|디너|밥)/.test(String(text || ''));
    }

    hasKnownSettlementPerson(text) {
        const names = Array.isArray(config.financePolicy?.settlementPeople)
            ? config.financePolicy.settlementPeople
            : [];
        const lower = String(text || '').toLowerCase();
        return names.some(name => lower.includes(String(name || '').toLowerCase()));
    }

    classifySummaryBucket(categoryLabel, item) {
        const text = `${this.normalizeLabel(categoryLabel)} ${this.normalizeLabel(item)}`.toLowerCase();
        if (!text) return '기타';
        if (/(급여|월급|보너스)/.test(text)) return '급여';
        if (/(이자)/.test(text)) return '이자';
        if (/(월세)/.test(text)) return '월세';
        if (/(통신|ahamo|softbank|요금제)/.test(text)) return '통신';
        if (/(식비|점심|저녁|식당|카페|커피|외식|마트|편의점|로손|세븐|패밀리|삼겹살|치킨|라면)/.test(text)) return '식비';
        if (/(교통|suica|버스|지하철|전철|택시)/.test(text)) return '교통';
        if (/(생활|아마존|다이소|니토리|생필품)/.test(text)) return '생활';
        if (/(건강|병원|약|안약|약국|치과)/.test(text)) return '건강';
        if (/(미용|컷트|헤어|네일)/.test(text)) return '미용';
        return '기타';
    }

    isFoodSettlementIncome(item, categoryLabel) {
        const text = `${this.normalizeLabel(item)} ${this.normalizeLabel(categoryLabel)}`.toLowerCase();
        const settlement = this.hasSettlementKeyword(text);
        const foodHint = this.hasFoodKeyword(text);
        const personHint = this.hasKnownSettlementPerson(text);
        if (/식비정산환급/.test(text)) return true;
        return settlement && (foodHint || personHint);
    }

    isIncome(item, cat, amount) {
        // 금액이 양수면 무조건 수입? NO. 
        // V2는 지출이 음수. Copy는 지출이 양수.
        // 따라서 카테고리나 아이템으로 판단해야 함.
        if (cat === '급여' || cat === '이자' || cat === '기타수입') return true;
        if (item.includes('입금') || item.includes('월급') || item.includes('수입')) return true;
        return false;
    }

    async createFinalFinance() {
        console.log('\n💰 Creating [가계부_파이널] (v6 Fix)...');

        const sources = ['가계부', '가계부의 사본', '가계부_2025', '가계부_V2'];
        let rawList = [];

        // 소스별 특성 반영하여 로드
        for (const title of sources) {
            const sheet = this.doc.sheetsByTitle[title];
            if (!sheet) continue;
            const rows = await sheet.getRows();
            const sourceName = title;

            rows.forEach(r => {
                rawList.push({
                    dateRaw: r.get('날짜'),
                    item: r.get('항목') || '',
                    amtRaw: r.get('금액 (엔)') || r.get('금액') || r.get('price') || '0',
                    method: r.get('결제수단') || r.get('method') || '현금',
                    catRaw: r.get('카테고리') || r.get('category'),
                    memo: r.get('메모') || '',
                    source: sourceName
                });
            });
        }

        const processed = [];
        const seen = new Set();

        for (const r of rawList) {
            const date = this.parseDate(r.dateRaw);
            if (!date) continue; // 날짜 없으면 스킵

            let amountVal = parseInt(String(r.amtRaw).replace(/[^0-9-]/g, '')) || 0;
            if (amountVal === 0) continue;

            let cat = this.inferCategory(r.item, r.catRaw);

            // 수입/지출 판단
            let isInc = this.isIncome(r.item, cat, amountVal);
            let income = 0, expense = 0;

            // V2 데이터는 지출이 음수. Copy는 양수.
            // 일단 절댓값으로 만듦
            const absAmt = Math.abs(amountVal);

            const normalizedMethod = this.normalizePaymentMethodLabel(r.method);

            // 소스별 부호 차이(+/-)로 같은 거래가 중복 집계되지 않도록 정규화 키 사용.
            const key = `${date}|${r.item}|${absAmt}|${normalizedMethod}|${isInc ? 'IN' : 'OUT'}`;
            if (seen.has(key)) continue;
            seen.add(key);

            if (isInc) {
                income = absAmt;
            } else {
                expense = absAmt;
                // '식비'인데 amountVal이 양수일 수도 있고 음수일 수도 있음. 
                // 여기서 중요한 건 "식비"면 무조건 지출이라는 것.
            }

            // 그러나 '계좌이체(식비받은거)' 같은 건 수입임.
            if (r.item.includes('받은거') || r.item.includes('더치페이')) {
                income = absAmt; expense = 0;
            }

            const direction = income > 0 ? 'IN' : 'OUT';
            const baseKey = `${date}|${r.item}|${absAmt}|${direction}`;
            if (this.excludeEntries.has(baseKey)) continue;

            const manual = this.manualChoices.get(baseKey);
            if (manual) {
                if (
                    manual.method &&
                    r.method !== manual.method &&
                    normalizedMethod !== this.normalizePaymentMethodLabel(manual.method)
                ) continue;
                if (manual.category) cat = manual.category;
            }

            const unifiedCat = this.resolveUnifiedCategory(cat, r.memo, r.item);
            processed.push({
                date,
                item: r.item,
                income,
                expense,
                cat: unifiedCat,
                method: normalizedMethod,
                memo: '',
            });
        }

        processed.sort((a, b) => a.date.localeCompare(b.date));

        // ----------------------------------------------------
        // 잔고 계산 (Difference Accumulation Method)
        // ----------------------------------------------------
        // 모든 거래의 변동분(delta)을 계산한 뒤,
        // 기준점(2026-02-04)에서의 누적 변동분과 실제 잔고의 차이(Initial Offset)를 구함.

        let accSum = 0, accRak = 0, accCas = 0;
        const deltas = processed.map(r => {
            const net = r.income - r.expense;
            let dSum = 0, dRak = 0, dCas = 0;
            const m = r.method.toLowerCase();
            const pay = this.inferPaymentInfo(r.method);

            // 자산간 이체 (현금 인출 등)
            if (r.item.includes('인출') || r.item.includes('atm')) {
                const amountAbs = Math.abs(r.expense || 0);
                const key = `${r.date}|${r.item}|${amountAbs}`;
                dSum = -amountAbs;
                dCas = this.withdrawalNoCashIncrease.has(key) ? 0 : amountAbs;
            } else {
                // 일반 거래: credit is liability-only and does not change bank cash immediately.
                if (pay.type === 'credit') {
                    // no-op for immediate account balance
                } else if (pay.account === '스미토모') {
                    dSum = net;
                } else if (pay.account === '라쿠텐') {
                    dRak = net;
                } else if (pay.account === '현금' || m.includes('현금')) {
                    dCas = net;
                }
            }
            return { dSum, dRak, dCas, ...r };
        });

        // 기준점 Delta 찾기
        let refDeltaSum = 0, refDeltaRak = 0, refDeltaCas = 0;
        let foundRef = false;

        // 누적하면서 기준점 찾기
        for (let i = 0; i < deltas.length; i++) {
            const d = deltas[i];
            accSum += d.dSum; accRak += d.dRak; accCas += d.dCas;

            if (d.date === this.refPoint.dateStr && d.item.includes('마파두부')) {
                refDeltaSum = accSum;
                refDeltaRak = accRak;
                refDeltaCas = accCas;
                foundRef = true;
                // break 금지! 끝까지 돌려서 초기화할 필요 없음, 오프셋만 구하면 됨.
            }
        }

        if (!foundRef) {
            console.log('⚠️ 기준점을 못 찾았습니다. 마지막 행 기준으로 역산 시도 불가. 0부터 시작합니다.');
            refDeltaSum = 0; refDeltaRak = 0; refDeltaCas = 0;
            // 혹은 그냥 2026-02-04 날짜를 기준점으로 잡기 (아이템 매칭 실패 시)
            // ... 생략 ...
        }

        // 초기 잔고 (t=0) = (기준시점 실제잔고) - (기준시점 누적변동분)
        const initSum = this.refPoint.balances.sum - refDeltaSum;
        const initRak = this.refPoint.balances.rak - refDeltaRak;
        const initCas = this.userRefCash - refDeltaCas; // 사용자 요청값 3268

        // 다시 루프 돌면서 최종 잔고 기록
        let currSum = initSum, currRak = initRak, currCas = initCas;
        const finalRows = deltas.map(d => {
            currSum += d.dSum; currRak += d.dRak; currCas += d.dCas;
            return {
                '날짜': d.date,
                '항목': d.item,
                '수입': d.income || '',
                '지출': d.expense || '',
                '결제수단': d.method,
                '카테고리': d.cat,
                '스미토모 잔고': Math.round(currSum),
                '라쿠텐 잔고': Math.round(currRak),
                '현금 잔고': Math.round(currCas),
                '메모': d.memo
            };
        });

        await this.createFormattedSheet('가계부_파이널',
            ['날짜', '항목', '수입', '지출', '결제수단', '카테고리', '스미토모 잔고', '라쿠텐 잔고', '현금 잔고', '메모'],
            finalRows, { freezeRow: 1, freezeCol: 1 }
        );
    }

    // 2. 체크리스트
    async createFinalChecklist() {
        console.log('\n📝 Creating [체크리스트_파이널]...');
        // 똑같은 체크리스트 로직 (날짜 파싱만 강화)
        const sources = ['checkList', 'checkList의 사본', '체크리스트_V2'];
        let rawList = [];
        for (const t of sources) {
            const s = this.doc.sheetsByTitle[t];
            if (s) {
                const r = await s.getRows();
                rawList = rawList.concat(r.map(row => {
                    const obj = {};
                    s.headerValues.forEach(h => obj[h] = row.get(h));
                    return obj;
                }));
            }
        }

        const refinedMap = new Map();
        rawList.forEach(row => {
            const date = this.parseDate(row['날짜']);
            if (!date) return;
            if (!refinedMap.has(date)) refinedMap.set(date, { '날짜': date, '비고': '' });
            const cur = refinedMap.get(date);

            // ... (기존 로직: 비고 병합 등)
            const exclude = ['데이터사이언스', '데이터사이언스 진행도', '빨래', '청소', '토익공부', '스픽', '스피크', 'speak'];
            const memo = row['기타'] || row['메모'] || '';
            if (memo) {
                const prev = cur['비고'].split(', ');
                const curr = memo.split(/[,，]/).map(s => s.trim());
                cur['비고'] = [...new Set([...prev, ...curr])].filter(s => s).join(', ');
            }

            Object.keys(row).forEach(k => {
                if (['날짜', '기타', '메모'].includes(k) || exclude.some(ex => k.includes(ex))) return;
                let tk = k;
                if (k.includes('다이어리') || k.includes('CBT')) tk = 'Diary (CBT)';
                if (k.includes('안키') || k.includes('anki')) tk = 'Anki';
                if (k.includes('운동')) tk = '운동';

                const val = row[k];
                if (String(val).toLowerCase() === 'true' || val === '1') cur[tk] = '✅';
                else if (tk === '운동' && val && val !== 'FALSE') cur[tk] = val;
            });
        });

        const refinedData = Array.from(refinedMap.values()).sort((a, b) => a['날짜'].localeCompare(b['날짜']));
        const headers = new Set(['날짜']);
        refinedData.forEach(r => Object.keys(r).forEach(k => headers.add(k)));
        const hList = ['날짜', ...Array.from(headers).filter(h => h !== '날짜' && h !== '비고').sort(), '비고'];

        await this.createFormattedSheet('체크리스트_파이널', hList, refinedData, { freezeRow: 1, freezeCol: 1 });
    }

    normalizeSummaryCategory(categoryLabel, itemLabel, methodLabel) {
        const text = `${this.normalizeLabel(categoryLabel)} ${this.normalizeLabel(itemLabel)} ${this.normalizeLabel(methodLabel)}`.toLowerCase();
        const settlement = this.hasSettlementKeyword(text);
        const foodSettlement = settlement && (this.hasFoodKeyword(text) || this.hasKnownSettlementPerson(text) || /식비정산환급/.test(text));
        if (foodSettlement) {
            return /현금/.test(this.normalizeLabel(methodLabel)) ? '현금받음(식비)' : '계좌이체(식비받은거)';
        }
        if (/급여|월급|보너스|상여/.test(text)) return '급여';
        if (/이자/.test(text)) return '이자';
        if (/월세/.test(text)) return '월세';
        if (/통신|ahamo|softbank|요금제/.test(text)) return '통신';
        if (/교육|강의|udemy|toeic|토익|공부/.test(text)) return '교육';
        if (/건강|안약|병원|약국|치과|약/.test(text)) return '건강';
        if (/식비\(총무\)|총무/.test(text)) return '식비(총무)';
        if (/계좌이체\(식비받은거\)|식비받은거|정산받.*식비|식비정산환급/.test(text)) return '계좌이체(식비받은거)';
        if (/현금받음\(식비\)|현금.*식비.*받/.test(text)) return '현금받음(식비)';
        if (/식비|점심|저녁|식당|카페|커피|외식|삼겹살|치킨|런치|디너|밥/.test(text)) return '식비';
        if (/교통|suica|버스|지하철|전철|택시/.test(text)) return '교통';
        if (/생활|생필품|아마존|다이소|니토리/.test(text)) return '생활';
        if (/미용|컷트|헤어|네일/.test(text)) return '미용';
        if (/취미|게임|bms|영화|책/.test(text)) return '취미';
        if (/atm|인출/.test(text)) return 'ATM 출금';
        if (/계좌이체\(보냄\)|송금|이체/.test(text)) return '계좌이체(보냄)';
        if (/투자|적립|주식|펀드/.test(text)) return '투자';
        if (/신용카드정산|카드대금|대금\s*빠져나감/.test(text) && /아마존/.test(text)) return '아마존 카드값';
        if (/신용카드정산|카드대금|대금\s*빠져나감/.test(text) && /올리브/.test(text)) return '올리브 카드값';
        if (/신용카드정산|카드대금|대금\s*빠져나감/.test(text)) return '아마존 카드값';
        return '기타';
    }

    getMonthlyFoodBudget(monthLabel) {
        const policy = config.financePolicy || {};
        const byMonth = policy.realFoodBudgetByMonth || {};
        if (Object.prototype.hasOwnProperty.call(byMonth, monthLabel)) {
            return this.toNumber(byMonth[monthLabel]);
        }
        return this.toNumber(policy.realFoodBudgetMonthlyYen || 0);
    }

    // 3. 요약 (가계부 파이널 생성 후 실행됨)
    async createFinalSummary() {
        console.log('\n📊 Creating [가계부요약_파이널]...');
        const fSheet = this.doc.sheetsByTitle['가계부_파이널'];
        if (!fSheet) return;
        const rows = await fSheet.getRows();

        const summary = {};
        const months = new Set();

        rows.forEach(r => {
            const d = this.normalizeLabel(r.get('날짜'));
            if (!d || d.length < 7) return;
            const mStr = `${d.substring(2, 4)}년 ${d.substring(5, 7)}월`;
            months.add(mStr);

            if (!summary[mStr]) {
                summary[mStr] = {
                    map: {},
                    balSum: 0,
                    balRak: 0,
                    balCas: 0,
                };
            }

            const item = this.normalizeLabel(r.get('항목'));
            const category = this.normalizeLabel(r.get('카테고리'));
            const method = this.normalizeLabel(r.get('결제수단'));
            const normalized = this.normalizeSummaryCategory(category, item, method);
            const inc = this.toNumber(r.get('수입'));
            const exp = this.toNumber(r.get('지출'));

            if (inc > 0) summary[mStr].map[normalized] = (summary[mStr].map[normalized] || 0) + inc;
            if (exp > 0) summary[mStr].map[normalized] = (summary[mStr].map[normalized] || 0) + exp;

            summary[mStr].balSum = this.toNumber(r.get('스미토모 잔고'));
            summary[mStr].balRak = this.toNumber(r.get('라쿠텐 잔고'));
            summary[mStr].balCas = this.toNumber(r.get('현금 잔고'));
        });

        const sMonths = Array.from(months).sort();
        const overrideValue = (label, month, fallback = 0) => {
            if (
                this.summaryOverrides[label] &&
                Object.prototype.hasOwnProperty.call(this.summaryOverrides[label], month)
            ) {
                return this.toNumber(this.summaryOverrides[label][month]);
            }
            return this.toNumber(fallback);
        };
        const val = (month, label) => overrideValue(label, month, summary[month]?.map?.[label] || 0);
        const realFood = (month) =>
            overrideValue(
                '실질 식비 합계',
                month,
                Math.max(0, val(month, '식비') + val(month, '식비(총무)') - val(month, '계좌이체(식비받은거)') - val(month, '현금받음(식비)')),
            );
        const foodBudget = (month) => this.getMonthlyFoodBudget(month);

        const layout = [
            { label: '급여', calc: (m) => val(m, '급여') },
            { label: '이자', calc: (m) => val(m, '이자') },
            { label: '기타', calc: (m) => val(m, '기타') },
            { sep: true },
            { label: '월세', calc: (m) => val(m, '월세') },
            { label: '통신', calc: (m) => val(m, '통신') },
            { label: '교육', calc: (m) => val(m, '교육') },
            { label: '건강', calc: (m) => val(m, '건강') },
            { sep: true },
            { label: '식비', calc: (m) => val(m, '식비') },
            { label: '식비(총무)', calc: (m) => val(m, '식비(총무)') },
            { label: '계좌이체(식비받은거)', calc: (m) => val(m, '계좌이체(식비받은거)') },
            { label: '현금받음(식비)', calc: (m) => val(m, '현금받음(식비)') },
            { label: '실질 식비 합계', calc: (m) => realFood(m) },
            { label: '실질 식비 예산', calc: (m) => foodBudget(m) },
            { label: '실질 식비 예산 대비', calc: (m) => realFood(m) - foodBudget(m) },
            { label: '실질 식비 추이(월별)', calc: (m) => realFood(m) },
            {
                label: '실질 식비 전월 대비',
                calc: (m) => {
                    const idx = sMonths.indexOf(m);
                    if (idx <= 0) return 0;
                    const prev = sMonths[idx - 1];
                    return realFood(m) - realFood(prev);
                },
            },
            {
                label: '실질 식비 3개월 평균',
                calc: (m) => {
                    const idx = sMonths.indexOf(m);
                    const begin = Math.max(0, idx - 2);
                    const keys = sMonths.slice(begin, idx + 1);
                    const sum = keys.reduce((acc, key) => acc + realFood(key), 0);
                    return keys.length ? Math.round(sum / keys.length) : 0;
                },
            },
            {
                label: '식비 예산 경고',
                calc: (m) => {
                    const budget = foodBudget(m);
                    if (budget <= 0) return 0;
                    return realFood(m) > budget ? 1 : 0;
                },
            },
            { sep: true },
            { label: '교통', calc: (m) => val(m, '교통') },
            { label: '생활', calc: (m) => val(m, '생활') },
            { label: '미용', calc: (m) => val(m, '미용') },
            { label: '취미', calc: (m) => val(m, '취미') },
            { sep: true },
            { label: 'ATM 출금', calc: (m) => val(m, 'ATM 출금') },
            { label: '계좌이체(보냄)', calc: (m) => val(m, '계좌이체(보냄)') },
            { label: '투자', calc: (m) => val(m, '투자') },
            { label: '아마존 카드값', calc: (m) => val(m, '아마존 카드값') },
            { label: '올리브 카드값', calc: (m) => val(m, '올리브 카드값') },
            { sep: true },
            { label: '월말 스미토모', val: 'balSum' },
            { label: '월말 라쿠텐', val: 'balRak' },
            { label: '월말 현금', val: 'balCas' },
        ];

        const headers = ['구분', ...sMonths];
        const fData = [];
        layout.forEach(def => {
            if (def.sep) {
                fData.push({});
                return;
            }
            const row = { '구분': def.label };
            sMonths.forEach(m => {
                let v = 0;
                if (def.calc) v = def.calc(m);
                if (def.val) v = this.toNumber(summary[m]?.[def.val] || 0);
                const resolved = overrideValue(def.label, m, v);
                row[m] = resolved === 0 ? '' : resolved;
            });
            fData.push(row);
        });

        await this.createFormattedSheet('가계부요약_파이널', headers, fData, { freezeRow: 1, freezeCol: 1 });
    }

    async createFormattedSheet(title, headers, data, opt = {}) {
        const exist = this.doc.sheetsByTitle[title];
        if (exist) await exist.delete();

        const sheet = await this.doc.addSheet({
            title, headerValues: headers.map(h => h || ' '),
            gridProperties: { frozenRowCount: opt.freezeRow || 0, frozenColumnCount: opt.freezeCol || 0 }
        });

        const CHUNK = 500;
        for (let i = 0; i < data.length; i += CHUNK) await sheet.addRows(data.slice(i, i + CHUNK));

        await sheet.loadCells();
        // 스타일링
        const cols = headers.length;
        for (let r = 0; r <= data.length; r++) {
            for (let c = 0; c < cols; c++) {
                const cell = sheet.getCell(r, c);
                if (r === 0) {
                    if (title === '체크리스트_파이널') {
                        cell.backgroundColor = { red: 0.14, green: 0.28, blue: 0.46 };
                        cell.textFormat = { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } };
                    } else {
                        cell.backgroundColor = { red: 0.9, green: 0.9, blue: 0.9 };
                        cell.textFormat = { bold: true };
                    }
                    cell.horizontalAlignment = 'CENTER';
                } else {
                    const header = headers[c] || '';
                    if (header.includes('날짜')) {
                        // Keep date columns readable instead of showing serial numbers.
                        cell.numberFormat = { type: 'DATE', pattern: 'yyyy-mm-dd' };
                    } else if (typeof cell.value === 'number') {
                        cell.numberFormat = { type: 'NUMBER', pattern: '#,##0' };
                    }
                    if (title === '체크리스트_파이널') {
                        cell.backgroundColor = (r % 2 === 0)
                            ? { red: 0.97, green: 0.98, blue: 1.0 }
                            : { red: 1, green: 1, blue: 1 };
                        if (String(cell.value || '').includes('✅')) {
                            cell.backgroundColor = { red: 0.87, green: 0.96, blue: 0.88 };
                        }
                    }
                }
                if (headers[c] && (headers[c].includes('잔고') || headers[c].includes('월말'))) {
                    cell.backgroundColor = { red: 1, green: 0.95, blue: 0.8 };
                }
                if (title === '가계부요약_파이널' && c === 0 && String(cell.value || '').includes('실질 식비')) {
                    cell.backgroundColor = { red: 0.85, green: 0.94, blue: 0.85 };
                    cell.textFormat = { bold: true };
                }
                if (title === '가계부요약_파이널' && String(headers[c] || '').includes('년') && String(headers[c] || '').includes('월')) {
                    if (String(sheet.getCell(r, 0).value || '').includes('실질 식비')) {
                        cell.backgroundColor = { red: 0.92, green: 0.98, blue: 0.92 };
                        cell.textFormat = { bold: true };
                    }
                }
            }
        }
        await sheet.saveUpdatedCells();
    }

    async run() {
        await this.init();
        await this.createFinalFinance();
        await this.createFinalChecklist();
        await this.createFinalSummary();
        console.log('\n🎉 Final Fixed!');
    }
}

if (require.main === module) new SheetFinalizer().run().catch(console.error);
