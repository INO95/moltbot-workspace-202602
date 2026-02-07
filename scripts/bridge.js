const engine = require('./molt_engine');
const anki = require('./anki_connect');
const config = require('../data/config.json');
const financeManager = require('./finance_manager');

function splitWords(text) {
    return String(text || '')
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(Boolean);
}

function buildToeicAnswer(word, hint) {
    const meaning = hint || '(의미 보강 필요)';
    return [
        `뜻: <b>${meaning}</b>`,
        '<hr>',
        `예문: <i>${word} is frequently used in TOEIC contexts.</i>`,
        `해석: ${word}는 토익 문맥에서 자주 쓰입니다.`,
        '<hr>',
        '💡 <b>TOEIC TIP:</b> 품사/문맥(비즈니스, 이메일, 공지문)까지 함께 암기하세요.',
    ].join('<br>');
}

function routeByPrefix(text) {
    const input = String(text || '').trim();
    const prefixes = config.commandPrefixes || {};
    const logPrefix = prefixes.log || '기록:';
    const wordPrefix = prefixes.word || '단어:';
    const healthPrefix = prefixes.health || '운동:';
    const reportPrefix = prefixes.report || '리포트:';
    const workPrefix = prefixes.work || '작업:';

    if (input.startsWith(logPrefix)) {
        return { route: 'ingest', payload: input.slice(logPrefix.length).trim() };
    }
    if (input.startsWith(wordPrefix)) {
        return { route: 'word', payload: input.slice(wordPrefix.length).trim() };
    }
    if (input.startsWith(healthPrefix)) {
        return { route: 'health', payload: input.slice(healthPrefix.length).trim() };
    }
    if (input.startsWith(reportPrefix)) {
        return { route: 'report', payload: input.slice(reportPrefix.length).trim() };
    }
    if (input.startsWith(workPrefix)) {
        return { route: 'work', payload: input.slice(workPrefix.length).trim() };
    }
    return { route: 'ingest', payload: input };
}

async function main() {
    const [, , command, ...args] = process.argv;
    const fullText = args.join(' ');
    const toeicDeck = config.ankiPolicy?.toeicDeck || 'TOEIC_AI';
    const toeicTags = Array.isArray(config.ankiPolicy?.autoTags) ? config.ankiPolicy.autoTags : ['moltbot', 'toeic_ai'];

    try {
        switch (command) {
            case 'spend': {
                const spendResult = await engine.parseAndRecordExpense(fullText);
                if (!spendResult.success) {
                    console.error(spendResult.error);
                    process.exit(1);
                }
                console.log(JSON.stringify(spendResult.data));
                break;
            }

            case 'preview': {
                // usage: node bridge.js preview "신용카드 대금 빠져나감 105200엔"
                const preview = engine.previewFinanceParse(fullText);
                console.log(JSON.stringify(preview));
                break;
            }

            case 'balance': {
                const balance = await engine.getBalance(args[0]);
                console.log(JSON.stringify(balance));
                break;
            }

            case 'checklist': {
                const checkResult = await engine.recordActivity(fullText);
                console.log(JSON.stringify(checkResult));
                break;
            }

            case 'summary': {
                const summary = await engine.getTodaySummary();
                console.log(JSON.stringify(summary));
                break;
            }

            case 'ingest': {
                const ingest = await engine.ingestNaturalText(fullText);
                console.log(JSON.stringify(ingest));
                break;
            }

            case 'work': {
                // usage: node bridge.js work "복잡 분석 요청"
                // Keep payload handling identical to ingest, but attach model preference metadata
                // so upstream routers can pin codex/high-reasoning policy.
                const ingest = await engine.ingestNaturalText(fullText);
                console.log(JSON.stringify({
                    ...ingest,
                    preferredModelAlias: 'codex',
                    preferredReasoning: 'high',
                    routeHint: 'complex-workload',
                }));
                break;
            }

            case 'finance-status': {
                let monthly = null;
                try {
                    monthly = await engine.getMonthlyStats();
                } catch {
                    const now = new Date();
                    const local = financeManager.getStats(now.getFullYear(), now.getMonth() + 1);
                    monthly = {
                        ...local,
                        year: now.getFullYear(),
                        month: now.getMonth() + 1,
                        effectiveExpense: Math.abs(local.expense || 0),
                        source: 'local-db',
                    };
                }
                const liabilities = engine.getCreditLiabilityStatus();
                console.log(JSON.stringify({ monthly, liabilities }));
                break;
            }

            case 'word': {
                // usage: node bridge.js word "Activated 활성화된, Formulate"
                const tokens = splitWords(fullText);
                const results = [];

                for (const token of tokens) {
                    const m = token.match(/^([A-Za-z][A-Za-z\-'\s]{0,80})(?:\s+(.+))?$/);
                    if (!m) continue;
                    const word = m[1].trim();
                    const hint = (m[2] || '').trim();
                    const answer = buildToeicAnswer(word, hint);
                    const noteId = await anki.addCard(toeicDeck, word, answer, toeicTags);
                    results.push({ word, noteId, deck: toeicDeck });
                }
                console.log(JSON.stringify({ success: true, saved: results.length, results }));
                break;
            }

            case 'health': {
                // usage: node bridge.js health ingest "<OCR text>"
                // usage: node bridge.js health summary [YYYY-MM]
                const subCmd = args[0];
                const healthCapture = require('./health_capture');
                if (subCmd === 'ingest') {
                    const payload = args.slice(1).join(' ');
                    const result = healthCapture.ingestCapture(payload, { source: 'bridge' });
                    console.log(JSON.stringify(result));
                } else if (subCmd === 'summary') {
                    const ym = args[1] || null;
                    const summary = healthCapture.getMonthlySummary(ym);
                    console.log(JSON.stringify(summary));
                } else {
                    console.error('Usage: health ingest "<text>" | health summary [YYYY-MM]');
                    process.exit(1);
                }
                break;
            }

            case 'anki': {
                // usage: node bridge.js anki add "deckName" "Front" "Back" "tag1,tag2"
                // usage: node bridge.js anki decks
                const subCmd = args[0];
                if (subCmd === 'add') {
                    const deck = args[1];
                    const front = args[2];
                    let back = args[3];
                    const tags = args[4] ? args[4].split(',') : toeicTags;

                    if (!deck || !front || !back) {
                        throw new Error('Usage: anki add <deck> <front> <back> [tags]');
                    }

                    const looksEnglishWord = /^[A-Za-z][A-Za-z\-'\s]{0,80}$/.test(front.trim());
                    const finalDeck = looksEnglishWord ? toeicDeck : deck;
                    back = back.replace(/\\n/g, '<br>').replace(/\n/g, '<br>');

                    const result = await anki.addCard(finalDeck, front, back, tags);
                    console.log(JSON.stringify({ success: true, noteId: result, deck: finalDeck }));
                } else if (subCmd === 'decks') {
                    const decks = await anki.getDeckNames();
                    console.log(JSON.stringify({ decks }));
                } else {
                    console.error('Unknown anki command:', subCmd);
                    process.exit(1);
                }
                break;
            }

            case 'auto': {
                // usage: node bridge.js auto "기록: 점심 1000엔 현금"
                const routed = routeByPrefix(fullText);
                if (routed.route === 'ingest') {
                    const ingest = await engine.ingestNaturalText(routed.payload);
                    console.log(JSON.stringify({ route: routed.route, ...ingest }));
                    break;
                }
                if (routed.route === 'word') {
                    const tokens = splitWords(routed.payload);
                    const results = [];
                    for (const token of tokens) {
                        const m = token.match(/^([A-Za-z][A-Za-z\-'\s]{0,80})(?:\s+(.+))?$/);
                        if (!m) continue;
                        const word = m[1].trim();
                        const hint = (m[2] || '').trim();
                        const answer = buildToeicAnswer(word, hint);
                        const noteId = await anki.addCard(toeicDeck, word, answer, toeicTags);
                        results.push({ word, noteId, deck: toeicDeck });
                    }
                    console.log(JSON.stringify({ route: routed.route, saved: results.length, results }));
                    break;
                }
                if (routed.route === 'health') {
                    const healthCapture = require('./health_capture');
                    const result = healthCapture.ingestCapture(routed.payload, { source: 'bridge-auto' });
                    console.log(JSON.stringify({ route: routed.route, ...result }));
                    break;
                }
                if (routed.route === 'report') {
                    const payload = routed.payload.toLowerCase();
                    if (payload.includes('블로그')) {
                        const blog = require('./blog_publish_from_reports');
                        const res = await blog.publishFromReports();
                        console.log(JSON.stringify({ route: 'report', action: 'blog-publish', ...res }));
                        break;
                    }
                    if (payload.includes('주간')) {
                        const weekly = require('./weekly_report');
                        const res = await weekly.buildWeeklyReport();
                        console.log(JSON.stringify({ route: 'report', action: 'weekly', ...res }));
                        break;
                    }
                    const daily = require('./daily_summary');
                    const res = await daily.buildDailySummary();
                    console.log(JSON.stringify({ route: 'report', action: 'daily', ...res }));
                    break;
                }
                if (routed.route === 'work') {
                    const ingest = await engine.ingestNaturalText(routed.payload);
                    console.log(JSON.stringify({
                        route: routed.route,
                        ...ingest,
                        preferredModelAlias: 'codex',
                        preferredReasoning: 'high',
                        routeHint: 'complex-workload',
                    }));
                    break;
                }
                console.log(JSON.stringify({ route: 'none', skipped: fullText }));
                break;
            }

            default:
                console.error('Unknown command:', command);
                process.exit(1);
        }
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

main();
