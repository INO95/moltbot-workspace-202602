const fs = require('fs');
const path = require('path');
const https = require('https');

const anki = require('./anki_connect');
const { createWordQuality, normalizeQualityPolicy } = require('./anki_word_quality');

const DEFAULT_DECK = '단어::영단어::Eng_Voca';
const STYLE_TAG = 'layout:eng-voca-std-v1';
const TIP_DETAIL_RE = /(함정|콜로케이션|유사|혼동|vs|전치사|어순|수동태|빈출|자주)/i;

const WORD_BACK_OVERRIDES = {
    'hold a meeting': {
        exampleEn: 'The HR director will hold a meeting with new employees on Monday morning.',
        exampleKo: '인사부장은 월요일 아침 신입 직원들과 회의를 열 예정입니다.',
        toeicTip: 'Part 5 함정: hold a meeting는 고정 collocation입니다. make/do a meeting 같은 비문 오답과 schedule/attend와의 의미 차이를 구분하세요.',
    },
    deliberate: {
        exampleEn: 'The delay was deliberate so the legal team could review every clause carefully.',
        exampleKo: '법무팀이 모든 조항을 면밀히 검토할 수 있도록 그 지연은 의도된 것이었습니다.',
        toeicTip: 'Part 5 함정: deliberate(형용사: 의도적인)와 deliberately(부사) 품사 구분이 자주 출제됩니다. deliberate delay/action collocation을 함께 암기하세요.',
    },
    plumbing: {
        exampleEn: 'The office renovation budget includes replacing outdated plumbing in the restroom area.',
        exampleKo: '사무실 리모델링 예산에는 화장실 구역의 노후 배관 교체가 포함되어 있습니다.',
        toeicTip: 'Part 7 빈출: plumbing은 시설 유지보수 문맥에서 maintenance, repair, replacement와 함께 자주 등장합니다.',
    },
    enduring: {
        exampleEn: 'The company built an enduring reputation through consistent after-sales support.',
        exampleKo: '회사는 일관된 사후 지원을 통해 오래 지속되는 평판을 구축했습니다.',
        toeicTip: 'Part 5 함정: enduring(지속되는)과 temporary/short-lived 대비 어휘가 함께 출제됩니다. enduring reputation/value collocation을 확인하세요.',
    },
    zenith: {
        exampleEn: 'Sales reached their zenith during the year-end promotional campaign.',
        exampleKo: '매출은 연말 프로모션 기간에 정점에 도달했습니다.',
        toeicTip: 'Part 7 함정: zenith(정점)는 peak와 유사 표현 치환 문제로 출제됩니다. reach/hit one’s zenith 패턴을 기억하세요.',
    },
    'come by': {
        exampleEn: 'Skilled technicians are hard to come by during peak maintenance season.',
        exampleKo: '성수기 유지보수 기간에는 숙련 기술자를 구하기가 어렵습니다.',
        toeicTip: 'Part 5 함정: come by는 obtain/get 의미의 구동사입니다. come across(우연히 발견하다)와 혼동하는 보기가 자주 나옵니다.',
    },
    statement: {
        exampleEn: 'The CEO issued a formal statement regarding the merger timeline.',
        exampleKo: 'CEO는 합병 일정에 관한 공식 성명을 발표했습니다.',
        toeicTip: 'Part 7 함정: statement는 issue/release a statement collocation으로 자주 출제됩니다. report/notice와 문서 성격을 구분하세요.',
    },
    repetition: {
        exampleEn: 'Repetition of key safety procedures reduced on-site accidents significantly.',
        exampleKo: '핵심 안전 절차를 반복한 덕분에 현장 사고가 크게 줄었습니다.',
        toeicTip: 'Part 5 함정: repetition은 by repetition, through repetition 전치사 결합 문제와 반복 학습 문맥에서 자주 등장합니다.',
    },
    'even number': {
        exampleEn: 'The committee must include an even number of members under the new charter.',
        exampleKo: '새 운영 규정에 따라 위원회는 짝수 인원으로 구성되어야 합니다.',
        toeicTip: 'Part 5 함정: even number와 odd number 대비가 자주 출제됩니다. number of + 복수명사, 동사 수일치도 함께 확인하세요.',
    },
    overlap: {
        exampleEn: 'The two training sessions overlap, so staff must choose one schedule.',
        exampleKo: '두 교육 일정이 겹쳐서 직원들은 하나의 일정을 선택해야 합니다.',
        toeicTip: 'Part 5 함정: overlap은 자동사/타동사로 모두 쓰입니다. overlap with + 명사 패턴과 schedule conflict 문맥을 함께 정리하세요.',
    },
    tangent: {
        exampleEn: 'During the briefing, the presenter went off on a tangent unrelated to the budget issue.',
        exampleKo: '브리핑 중 발표자는 예산 이슈와 무관한 이야기로 옆길로 샜습니다.',
        toeicTip: 'Part 7 함정: go off on a tangent는 회의/프레젠테이션 문맥의 관용 표현입니다. main point에서 벗어나는 의미를 구분하세요.',
    },
    intersect: {
        exampleEn: 'Customer support data and sales metrics intersect in the monthly performance report.',
        exampleKo: '고객지원 데이터와 매출 지표는 월간 성과 보고서에서 교차됩니다.',
        toeicTip: 'Part 5 함정: intersect는 cross/overlap과 유사하지만 문맥별 의미 차이를 묻는 어휘 문제가 자주 출제됩니다.',
    },
    divisible: {
        exampleEn: 'The incentive pool is divisible by team size to ensure fair distribution.',
        exampleKo: '성과급 재원은 공정한 분배를 위해 팀 규모로 나눌 수 있도록 설계되어 있습니다.',
        toeicTip: 'Part 5 함정: divisible by 패턴이 고정형으로 출제됩니다. divide/divided/divisible 품사 전환 함정을 주의하세요.',
    },
    'prime numbers': {
        exampleEn: 'The encryption module uses prime numbers to strengthen transaction security.',
        exampleKo: '암호화 모듈은 거래 보안을 강화하기 위해 소수를 사용합니다.',
        toeicTip: 'Part 7 빈출: IT/보안 지문에서 prime number, algorithm, encryption collocation이 함께 등장합니다.',
    },
    interpretable: {
        exampleEn: 'The dashboard must remain interpretable to non-technical managers.',
        exampleKo: '대시보드는 비기술 관리자도 해석할 수 있도록 이해 가능해야 합니다.',
        toeicTip: 'Part 5 함정: interpretable은 형용사 자리에서 해석 가능성을 나타냅니다. interpreted/interpreter와 품사 혼동을 주의하세요.',
    },
    conclude: {
        exampleEn: 'The auditors will conclude the compliance review by Friday afternoon.',
        exampleKo: '감사팀은 금요일 오후까지 준법 감사 검토를 마무리할 예정입니다.',
        toeicTip: 'Part 5 함정: conclude는 conclude a meeting/report/negotiation collocation으로 출제됩니다. conclusion(명사)과 품사 구분을 확인하세요.',
    },
    multiplication: {
        exampleEn: 'A multiplication error in the spreadsheet overstated the quarterly expense forecast.',
        exampleKo: '스프레드시트의 곱셈 오류로 분기 비용 전망이 과대 계산되었습니다.',
        toeicTip: 'Part 7 함정: multiplication error, calculation error 같은 수치 오류 collocation이 재무 지문에서 자주 등장합니다.',
    },
    demographics: {
        exampleEn: 'Regional demographics suggest strong demand for premium delivery services.',
        exampleKo: '지역 인구통계는 프리미엄 배송 서비스 수요가 강하다는 점을 시사합니다.',
        toeicTip: 'Part 7 빈출: demographics는 market segment, target customer와 함께 출제됩니다. 단수/복수 취급 문맥을 확인하세요.',
    },
    rather: {
        exampleEn: 'Rather than reducing headcount, the firm cut discretionary spending.',
        exampleKo: '그 회사는 인력 감축 대신 재량 지출을 줄였습니다.',
        toeicTip: 'Part 5 함정: rather than + 동사원형/명사 구조가 빈출입니다. instead of와의 문장 구조 차이를 함께 확인하세요.',
    },
};

const TIP_OVERRIDES = {
    candidate: 'Part 5 함정: candidate for + 직무 패턴이 자주 출제됩니다. applicant와의 뉘앙스 차이 및 for 전치사 고정을 확인하세요.',
    furniture: 'Part 5 함정: furniture는 불가산명사입니다. furnitures 오답과 a piece of furniture 표현이 자주 출제됩니다.',
    burden: 'Part 5/7 함정: burden은 bear/reduce/ease a burden collocation으로 자주 출제됩니다. 부담의 주체/대상을 문맥으로 구분하세요.',
    measure: 'Part 5 함정: take measures to + 동사원형 패턴이 빈출입니다. measure(측정)와 measure(조치) 의미를 문맥으로 구분하세요.',
    measures: 'Part 5 함정: take measures to + 동사원형 패턴이 빈출입니다. measure(측정)와 measure(조치) 의미를 문맥으로 구분하세요.',
    figures: 'Part 7 함정: sales figures는 매출 수치 의미의 고정 collocation입니다. figure(숫자/인물) 다의어 함정을 주의하세요.',
    dispute: 'Part 7 빈출: dispute over + 쟁점 패턴이 계약/분쟁 지문에서 자주 등장합니다. complaint와의 법적 강도 차이를 구분하세요.',
    complaint: 'Part 5 함정: file a complaint against + 대상 패턴이 빈출입니다. complain 동사형과 문장 구조를 함께 정리하세요.',
    startle: 'Part 5 함정: startle(놀라게 하다)와 startled(놀란 상태) 품사 구분 문제가 자주 출제됩니다.',
    intuition: 'Part 5/7 함정: intuition은 rely on intuition 패턴으로 자주 출제됩니다. logic/data-driven 판단과 대비되는 문맥을 확인하세요.',
    likelihood: 'Part 5 함정: likelihood that + 절 구조가 빈출입니다. possibility/probability와 확률 뉘앙스 차이를 구분하세요.',
    denote: 'Part 7 함정: denote는 표·그래프 지문에서 “의미하다/나타내다”로 출제됩니다. indicate/represent와 치환형 오답을 주의하세요.',
    'odd number': 'Part 5 함정: odd number와 even number 대비 문제가 자주 출제됩니다. page, seat, chapter 같은 명사와의 collocation을 같이 암기하세요.',
    unless: 'Part 5 함정: unless는 조건절 접속사로 “if not” 의미입니다. until과 철자 유사 함정이 자주 출제됩니다.',
    attorney: 'Part 7 빈출: attorney는 legal counsel, lawsuit, settlement와 함께 출제됩니다. lawyer/attorney 용례 차이를 확인하세요.',
    profound: 'Part 5 함정: profound impact on + 명사 패턴이 고정 collocation으로 자주 출제됩니다. deep와의 어조 차이를 구분하세요.',
    decoupling: 'Part 7 빈출: decoupling은 supply chain, geopolitical risk 문맥에서 자주 등장합니다. diversification과 전략적 의미 차이를 확인하세요.',
    robust: 'Part 5 함정: robust system/infrastructure/process collocation이 자주 출제됩니다. strong과의 용례 차이를 구분하세요.',
    contagion: 'Part 7 빈출: financial contagion은 위기 확산 문맥 핵심 어휘입니다. spillover effect와 함께 출제되는 경우가 많습니다.',
    explicit: 'Part 5 함정: explicit terms/approval/instructions collocation이 빈출입니다. implicit과 반의어 구분 문제를 주의하세요.',
    implicit: 'Part 5 함정: implicit agreement/assumption collocation이 자주 출제됩니다. explicit과 의미 대비 문제로 자주 나옵니다.',
    cyclomatic: 'Part 7 빈출: cyclomatic complexity는 코드 품질 문맥에서 maintainability/testability와 함께 출제됩니다.',
    'cyclomatic complexity': 'Part 7 빈출: cyclomatic complexity는 코드 품질 문맥에서 maintainability/testability와 함께 출제됩니다.',
};

const NOTE_FOCUS_OVERRIDES = {
    1756984008868: 'candidate',
    1756984019356: 'furniture',
    1756984025065: 'burden',
    1756984035366: 'measures',
    1756984040065: 'figures',
    1756984048410: 'dispute',
    1756984059066: 'complaint',
    1756984081267: 'startle',
    1757071575891: 'intuition',
    1757072558182: 'likelihood',
    1757076719808: 'denote',
    1757131509323: 'odd number',
    1757334381126: 'unless',
    1765685964533: 'attorney',
    1765685979115: 'profound',
    1765685996073: 'decoupling',
    1765686006727: 'robust',
    1765686016194: 'contagion',
    1765686023970: 'explicit',
    1765686030680: 'implicit',
    1767696735677: 'cyclomatic complexity',
};

const FORCE_TRANSLATE_NOTE_IDS = new Set([
    1765685964533,
    1765685979115,
    1765685996073,
    1765686006727,
    1765686016194,
    1765686023970,
    1765686030680,
]);

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'when', 'while', 'because', 'since', 'as', 'to', 'for', 'of', 'on', 'in', 'at',
    'by', 'with', 'from', 'into', 'that', 'this', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
    'their', 'there', 'will', 'would', 'can', 'could', 'should', 'must', 'may', 'might', 'do', 'does', 'did', 'have', 'has', 'had',
    'we', 'you', 'they', 'he', 'she', 'i', 'our', 'your', 'his', 'her', 'them', 'all', 'any', 'each', 'every', 'either',
]);

function parseArgs(argv) {
    const out = {
        apply: false,
        deck: DEFAULT_DECK,
        batchSize: 100,
        writeBackup: true,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const token = String(argv[i] || '').trim();
        if (token === '--apply') out.apply = true;
        else if (token === '--dry-run') out.apply = false;
        else if (token === '--deck' && argv[i + 1]) {
            out.deck = String(argv[i + 1] || out.deck).trim();
            i += 1;
        } else if (token === '--batch-size' && argv[i + 1]) {
            out.batchSize = Math.max(20, Number(argv[i + 1] || out.batchSize));
            i += 1;
        } else if (token === '--no-backup') {
            out.writeBackup = false;
        }
    }
    return out;
}

function decodeHtmlEntities(text) {
    return String(text || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#39;/gi, '\'')
        .replace(/&quot;/gi, '"');
}

function htmlToText(html) {
    return decodeHtmlEntities(String(html || ''))
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeInline(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeWordKey(text) {
    return normalizeInline(text).toLowerCase();
}

function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function hasKorean(text) {
    return /[가-힣]/.test(String(text || ''));
}

function isSentenceLike(text) {
    const normalized = normalizeInline(text);
    if (!normalized) return false;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length >= 6) return true;
    if (/[.?!]$/.test(normalized)) return true;
    if (/,|;|:/.test(normalized)) return true;
    return false;
}

function parseWordPrefixQuestion(rawQuestion) {
    const question = htmlToText(rawQuestion);
    const match = question.match(/^Word:\s*([A-Za-z][A-Za-z0-9' -]{0,80})\s+Q:\s*([\s\S]+)$/i);
    if (!match) {
        return {
            question: normalizeInline(question),
            prefixedWord: '',
        };
    }
    return {
        question: normalizeInline(String(match[2] || '')),
        prefixedWord: normalizeInline(String(match[1] || '')),
    };
}

function parseBodyAndTip(raw) {
    const text = htmlToText(raw);
    const match = text.match(/^(.*?)(?:\n)?\s*💡?\s*TOEIC TIP[:：]?\s*([\s\S]*)$/i);
    if (!match) {
        return {
            body: text,
            tip: '',
        };
    }
    return {
        body: normalizeInline(String(match[1] || '')),
        tip: normalizeInline(String(match[2] || '')),
    };
}

function parseBasicAnswer(rawAnswer) {
    const { body, tip } = parseBodyAndTip(rawAnswer);
    const result = {
        body,
        tip,
        exampleEn: '',
        translationKo: '',
        meaningHint: '',
    };

    const exampleMatch = body.match(/(?:^|\n)\s*예문[:：]\s*([\s\S]*?)(?:\n\s*해석[:：]|$)/i);
    if (exampleMatch) {
        result.exampleEn = normalizeInline(String(exampleMatch[1] || ''));
    }

    const translationMatch = body.match(/(?:^|\n)\s*해석[:：]\s*([\s\S]*)$/i);
    if (translationMatch) {
        result.translationKo = normalizeInline(String(translationMatch[1] || '').replace(/^A:\s*/i, ''));
    }

    const meaningMatch = body.match(/(?:^|\n)\s*(?:의미|뜻)[:：]\s*([\s\S]*?)(?:\n|$)/i);
    if (meaningMatch) {
        result.meaningHint = normalizeInline(String(meaningMatch[1] || ''));
    } else if (!result.translationKo && !exampleMatch) {
        result.meaningHint = normalizeInline(body);
    }

    return result;
}

function parseEngVocaSentenceMean(rawSentenceMean) {
    const { body, tip } = parseBodyAndTip(rawSentenceMean);
    const exampleMatch = body.match(/(?:^|\n)\s*예문[:：]\s*([\s\S]*?)(?:\n\s*해석[:：]|$)/i);
    const translationMatch = body.match(/(?:^|\n)\s*해석[:：]\s*([\s\S]*)$/i);
    return {
        exampleEn: normalizeInline(exampleMatch ? String(exampleMatch[1] || '') : ''),
        translationKo: normalizeInline(translationMatch ? String(translationMatch[1] || '') : ''),
        tip: normalizeInline(tip),
    };
}

function extractBracketWord(sentence) {
    const match = String(sentence || '').match(/\[([A-Za-z][A-Za-z0-9' -]{0,80})\]/);
    return match ? normalizeInline(String(match[1] || '')) : '';
}

function extractFocusWord(sentence, prefixedWord = '') {
    if (prefixedWord) return prefixedWord;
    const bracket = extractBracketWord(sentence);
    if (bracket) return bracket;

    const tokens = String(sentence || '')
        .replace(/[^A-Za-z0-9' -]/g, ' ')
        .split(/\s+/)
        .map((v) => normalizeInline(v.toLowerCase()))
        .filter(Boolean)
        .filter((v) => v.length >= 5 && !STOPWORDS.has(v));
    if (tokens.length === 0) return '';
    tokens.sort((a, b) => b.length - a.length);
    return tokens[0];
}

function isTipDetailed(tip) {
    return TIP_DETAIL_RE.test(String(tip || ''));
}

function buildFallbackSentenceTip(focusWord, sentence) {
    const normalizedFocus = normalizeInline(focusWord);
    if (normalizedFocus) {
        return `Part 5 함정: ${normalizedFocus}는 문맥 기반 어휘 선택 문제로 자주 출제됩니다. 전치사 결합/유사어 치환 오답을 함께 확인하세요.`;
    }
    if (/\bunless\b/i.test(sentence)) {
        return TIP_OVERRIDES.unless;
    }
    return 'Part 7 함정: 문장 핵심 어휘의 collocation과 접속사 단서를 먼저 고정하면 오답 제거가 빠릅니다.';
}

function buildWordBackHtml(exampleEn, translationKo, toeicTip) {
    return [
        `예문: ${normalizeInline(exampleEn)}`,
        '',
        `해석: ${normalizeInline(translationKo)}`,
        '',
        '💡 TOEIC TIP:',
        normalizeInline(toeicTip),
    ].join('<br>');
}

function buildSentenceBackHtml(translationKo, toeicTip) {
    return [
        `해석: ${normalizeInline(translationKo)}`,
        '',
        '💡 TOEIC TIP:',
        normalizeInline(toeicTip),
    ].join('<br>');
}

function parseTranslationResponse(payload) {
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) return '';
    return payload[0]
        .map((row) => (Array.isArray(row) ? String(row[0] || '') : ''))
        .join('')
        .trim();
}

function httpGetJson(url, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    if (Number(res.statusCode || 0) < 200 || Number(res.statusCode || 0) >= 300) {
                        reject(new Error(`HTTP_${res.statusCode}`));
                        return;
                    }
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function translateEnToKo(text) {
    const normalized = normalizeInline(text);
    if (!normalized) return '';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=${encodeURIComponent(normalized)}`;
    try {
        const payload = await httpGetJson(url, 7000);
        return normalizeInline(parseTranslationResponse(payload));
    } catch {
        return '';
    }
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeBackupFile(rows) {
    const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const backupPath = path.join(__dirname, '..', 'logs', `anki_eng_voca_structure_backup_${ts}.json`);
    ensureDir(backupPath);
    fs.writeFileSync(backupPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        rows,
    }, null, 2), 'utf8');
    return backupPath;
}

function compareField(a, b) {
    return String(a || '').trim() === String(b || '').trim();
}

function buildNoteSnapshot(note) {
    const fields = note.fields || {};
    return Object.fromEntries(
        Object.keys(fields).map((key) => [key, String(fields[key]?.value || '')]),
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const policy = normalizeQualityPolicy({
        enableHybridFallback: false,
        qualityThreshold: 0.72,
        tipStyle: 'part-focused',
    });

    const qualityCache = new Map();
    const getQuality = async (word, hint = '') => {
        const cacheKey = `${normalizeInline(word).toLowerCase()}|${normalizeInline(hint)}`;
        if (qualityCache.has(cacheKey)) return qualityCache.get(cacheKey);
        const quality = await createWordQuality(word, hint, { policy });
        qualityCache.set(cacheKey, quality);
        return quality;
    };

    const noteIds = await anki.invoke('findNotes', { query: `deck:"${String(args.deck).replace(/"/g, '\\"')}"` });
    const batches = chunk(noteIds, args.batchSize);

    const report = {
        apply: args.apply,
        deck: args.deck,
        scanned: noteIds.length,
        updated: 0,
        unchanged: 0,
        failed: 0,
        byModel: {
            eng_voca: { scanned: 0, updated: 0 },
            Basic: { scanned: 0, updated: 0 },
            unknown: { scanned: 0, updated: 0 },
        },
        warnings: [],
        failures: [],
        sample: [],
        backupPath: null,
    };

    const backupRows = [];

    for (const ids of batches) {
        const notes = ids.length ? await anki.invoke('notesInfo', { notes: ids }) : [];
        for (const note of notes) {
            const fields = note.fields || {};
            const model = String(note.modelName || '');
            if (!report.byModel[model]) report.byModel.unknown.scanned += 1;
            else report.byModel[model].scanned += 1;

            const before = buildNoteSnapshot(note);
            let nextFields = null;
            let mode = 'unknown';
            const noteWarnings = [];

            try {
                if (model === 'eng_voca' && fields.Clean_Word && fields.Sentence_Mean) {
                    mode = 'word-front';
                    const word = normalizeInline(fields.Clean_Word.value || '');
                    if (!word) throw new Error('empty_clean_word');

                    const sentenceParsed = parseEngVocaSentenceMean(fields.Sentence_Mean.value || '');
                    const meaningHint = normalizeInline(fields.Cleam_Word_Mean?.value || '');
                    const override = WORD_BACK_OVERRIDES[normalizeWordKey(word)];
                    const quality = override ? null : await getQuality(word, meaningHint);

                    const exampleEn = normalizeInline(
                        (override && override.exampleEn)
                        || sentenceParsed.exampleEn
                        || (quality && quality.exampleEn)
                        || '',
                    );
                    const translationKo = normalizeInline(
                        (override && override.exampleKo)
                        || sentenceParsed.translationKo
                        || (quality && quality.exampleKo)
                        || '',
                    );
                    const tipCandidate = normalizeInline(
                        (override && override.toeicTip)
                        || sentenceParsed.tip
                        || (quality && quality.toeicTip)
                        || '',
                    );
                    const tip = tipCandidate || buildFallbackSentenceTip(word, exampleEn);
                    if (!exampleEn || !translationKo || !tip) throw new Error('eng_voca_quality_missing');

                    if (!isTipDetailed(tip)) {
                        noteWarnings.push('tip_not_detailed');
                    }
                    nextFields = {
                        Clean_Word: word,
                        Example_Sentence: '',
                        Cleam_Word_Mean: '',
                        Sentence_Mean: buildWordBackHtml(exampleEn, translationKo, tip),
                    };
                } else if (model === 'Basic' && fields.Question && fields.Answer) {
                    const parsedQuestion = parseWordPrefixQuestion(fields.Question.value || '');
                    const question = normalizeInline(parsedQuestion.question);
                    const parsedAnswer = parseBasicAnswer(fields.Answer.value || '');
                    const sentenceFront = isSentenceLike(question);
                    mode = sentenceFront ? 'sentence-front' : 'word-front';

                    if (sentenceFront) {
                        const focusWord = NOTE_FOCUS_OVERRIDES[Number(note.noteId)] || extractFocusWord(question, parsedQuestion.prefixedWord);
                        let translationKo = normalizeInline(parsedAnswer.translationKo);
                        if (
                            FORCE_TRANSLATE_NOTE_IDS.has(Number(note.noteId))
                            || !hasKorean(translationKo)
                            || translationKo.length < 5
                            || /\b(?:word|q|a)\s*:/i.test(translationKo)
                        ) {
                            translationKo = await translateEnToKo(question);
                        }
                        if (!hasKorean(translationKo)) throw new Error('sentence_translation_missing');

                        const tipByFocus = TIP_OVERRIDES[normalizeWordKey(focusWord)] || '';
                        let tip = normalizeInline(tipByFocus || parsedAnswer.tip);
                        if (!tip || !isTipDetailed(tip)) tip = buildFallbackSentenceTip(focusWord, question);

                        if (!isTipDetailed(tip)) {
                            noteWarnings.push('tip_not_detailed');
                        }

                        nextFields = {
                            Question: question,
                            Answer: buildSentenceBackHtml(translationKo, tip),
                        };
                    } else {
                        const word = question;
                        if (!word) throw new Error('word_front_empty');
                        const override = WORD_BACK_OVERRIDES[normalizeWordKey(word)];
                        const quality = override ? null : await getQuality(word, parsedAnswer.meaningHint);
                        const exampleEn = normalizeInline(
                            (override && override.exampleEn)
                            || (quality && quality.exampleEn)
                            || '',
                        );
                        const translationKo = normalizeInline(
                            (override && override.exampleKo)
                            || (quality && quality.exampleKo)
                            || '',
                        );
                        const tip = normalizeInline(
                            (override && override.toeicTip)
                            || (quality && quality.toeicTip)
                            || buildFallbackSentenceTip(word, exampleEn),
                        );
                        if (!exampleEn || !translationKo || !tip) throw new Error('word_quality_missing');

                        if (!isTipDetailed(tip)) {
                            noteWarnings.push('tip_not_detailed');
                        }

                        nextFields = {
                            Question: word,
                            Answer: buildWordBackHtml(exampleEn, translationKo, tip),
                        };
                    }
                } else {
                    report.unchanged += 1;
                    continue;
                }

                const changed = Object.keys(nextFields || {}).some((key) => !compareField(before[key], nextFields[key]));
                if (!changed) {
                    report.unchanged += 1;
                    continue;
                }

                if (report.sample.length < 15) {
                    report.sample.push({
                        noteId: Number(note.noteId),
                        model,
                        mode,
                        questionBefore: normalizeInline(htmlToText(before.Question || before.Clean_Word || '')),
                        answerBefore: normalizeInline(htmlToText(before.Answer || before.Sentence_Mean || '')).slice(0, 170),
                        questionAfter: normalizeInline(htmlToText(nextFields.Question || nextFields.Clean_Word || '')),
                        answerAfter: normalizeInline(htmlToText(nextFields.Answer || nextFields.Sentence_Mean || '')).slice(0, 170),
                        warnings: noteWarnings,
                    });
                }

                if (!args.apply) {
                    report.updated += 1;
                    if (report.byModel[model]) report.byModel[model].updated += 1;
                    continue;
                }

                await anki.invoke('updateNoteFields', {
                    note: {
                        id: Number(note.noteId),
                        fields: nextFields,
                    },
                });
                await anki.invoke('addTags', {
                    notes: [Number(note.noteId)],
                    tags: STYLE_TAG,
                });
                backupRows.push({
                    noteId: Number(note.noteId),
                    model,
                    before,
                    after: nextFields,
                });
                report.updated += 1;
                if (report.byModel[model]) report.byModel[model].updated += 1;
            } catch (error) {
                report.failed += 1;
                report.failures.push({
                    noteId: Number(note.noteId),
                    model,
                    reason: String(error.message || error),
                });
            }
        }
    }

    if (args.apply && args.writeBackup && backupRows.length > 0) {
        report.backupPath = writeBackupFile(backupRows);
    }

    if (args.apply) {
        try {
            await anki.syncWithDelay();
        } catch (error) {
            report.syncWarning = String(error.message || error);
        }
    }

    console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}
