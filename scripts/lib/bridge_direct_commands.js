const { resolveOauthRouteModelPolicy } = require('./oauth_model_policy');

async function handleDirectBridgeCommand(context = {}, deps = {}) {
    const normalizedCommand = String(context.normalizedCommand || '').trim().toLowerCase();
    const fullText = String(context.fullText || '');
    const args = Array.isArray(context.args) ? context.args : [];
    const toeicDeck = String(context.toeicDeck || '');
    const toeicTags = Array.isArray(context.toeicTags) ? context.toeicTags : [];

    const {
        engine,
        anki,
        config = {},
        parseStructuredCommand,
        appendExternalLinks,
        withApiMeta,
        buildCodexDegradedMeta,
        buildDuelModeMeta,
        buildProjectRoutePayload,
        parseTransportEnvelopeContext,
        runOpsCommand,
        handlePersonalRoute,
        processWordTokens,
        normalizeNewsCommandPayload,
        pickPreferredModelMeta,
        handlePromptPayload,
        loadNewsDigest = () => require('../news_digest'),
    } = deps;

    switch (normalizedCommand) {
    case 'checklist': {
        const checkResult = await engine.recordActivity(fullText);
        return { handled: true, output: checkResult };
    }

    case 'summary': {
        const summary = await engine.getTodaySummary();
        return { handled: true, output: summary };
    }

    case 'work': {
        const parsed = parseStructuredCommand('work', fullText);
        const telegramReply = appendExternalLinks(parsed.telegramReply || '');
        const degradedMode = buildCodexDegradedMeta();
        const routeHint = 'complex-workload';
        const modelPolicy = resolveOauthRouteModelPolicy('work', {
            degraded: degradedMode,
            commandText: fullText,
        });
        return {
            handled: true,
            output: withApiMeta({
                route: 'work',
                templateValid: parsed.ok,
                ...parsed,
                telegramReply,
                duelMode: buildDuelModeMeta(),
                degradedMode,
                ...modelPolicy,
                routeHint,
            }, {
                route: 'work',
                routeHint,
                commandText: fullText,
                templateFields: parsed.fields || {},
            }),
        };
    }

    case 'inspect': {
        const parsed = parseStructuredCommand('inspect', fullText);
        const telegramReply = appendExternalLinks(parsed.telegramReply || '');
        const degradedMode = buildCodexDegradedMeta();
        const routeHint = 'inspection';
        const modelPolicy = resolveOauthRouteModelPolicy('inspect', {
            degraded: degradedMode,
            commandText: fullText,
        });
        return {
            handled: true,
            output: withApiMeta({
                route: 'inspect',
                templateValid: parsed.ok,
                ...parsed,
                telegramReply,
                degradedMode,
                ...modelPolicy,
                routeHint,
            }, {
                route: 'inspect',
                routeHint,
                commandText: fullText,
                templateFields: parsed.fields || {},
            }),
        };
    }

    case 'deploy': {
        const parsed = parseStructuredCommand('deploy', fullText);
        const telegramReply = appendExternalLinks(parsed.telegramReply || '');
        const degradedMode = buildCodexDegradedMeta();
        const routeHint = 'deployment';
        const modelPolicy = resolveOauthRouteModelPolicy('deploy', {
            degraded: degradedMode,
            commandText: fullText,
        });
        return {
            handled: true,
            output: withApiMeta({
                route: 'deploy',
                templateValid: parsed.ok,
                ...parsed,
                telegramReply,
                degradedMode,
                ...modelPolicy,
                routeHint,
            }, {
                route: 'deploy',
                routeHint,
                commandText: fullText,
                templateFields: parsed.fields || {},
            }),
        };
    }

    case 'project': {
        const parsed = parseStructuredCommand('project', fullText);
        const payload = buildProjectRoutePayload(parsed);
        const degradedMode = buildCodexDegradedMeta();
        const routeHint = 'project-bootstrap';
        const modelPolicy = resolveOauthRouteModelPolicy('project', {
            degraded: degradedMode,
            commandText: fullText,
        });
        return {
            handled: true,
            output: withApiMeta({
                ...payload,
                degradedMode,
                ...modelPolicy,
                routeHint,
            }, {
                route: 'project',
                routeHint,
                commandText: fullText,
                templateFields: parsed.fields || {},
            }),
        };
    }

    case 'ops': {
        const telegramContext = parseTransportEnvelopeContext(fullText);
        const out = runOpsCommand(fullText, {
            rawText: fullText,
            telegramContext,
        });
        if (out && out.telegramReply) {
            out.telegramReply = appendExternalLinks(out.telegramReply);
        }
        const modelMeta = pickPreferredModelMeta(out, 'fast', 'low');
        return {
            handled: true,
            output: withApiMeta({
                ...out,
                ...modelMeta,
            }, {
                route: 'ops',
                commandText: fullText,
            }),
        };
    }

    case 'word': {
        const wordResult = await processWordTokens(fullText, toeicDeck, toeicTags, {
            source: 'telegram',
            rawText: `단어: ${fullText}`,
        });
        return {
            handled: true,
            output: withApiMeta({
                route: 'word',
                ...wordResult,
                preferredModelAlias: 'fast',
                preferredReasoning: 'low',
            }, {
                route: 'word',
                commandText: fullText,
            }),
        };
    }

    case 'finance':
    case 'todo':
    case 'routine':
    case 'workout':
    case 'media':
    case 'place': {
        const out = await handlePersonalRoute(normalizedCommand, fullText, {
            source: 'telegram',
        });
        const modelMeta = pickPreferredModelMeta(out, 'fast', 'low');
        return {
            handled: true,
            output: withApiMeta({
                ...out,
                ...modelMeta,
            }, {
                route: normalizedCommand,
                commandText: fullText,
            }),
        };
    }

    case 'news': {
        try {
            const newsDigest = loadNewsDigest();
            const payload = [args[0], ...args.slice(1)].join(' ').trim() || fullText;
            const normalizedPayload = normalizeNewsCommandPayload(payload);
            const result = await newsDigest.handleNewsCommand(normalizedPayload);
            const modelMeta = pickPreferredModelMeta(result, 'fast', 'low');
            return {
                handled: true,
                output: withApiMeta({
                    route: 'news',
                    ...result,
                    ...modelMeta,
                }, {
                    route: 'news',
                    commandText: normalizedPayload,
                }),
            };
        } catch (error) {
            return {
                handled: true,
                output: withApiMeta({
                    route: 'news',
                    success: false,
                    errorCode: error && error.code ? error.code : 'NEWS_ROUTE_LOAD_FAILED',
                    error: String(error && error.message ? error.message : error),
                    telegramReply: `소식 모듈 로드 실패: ${error && error.message ? error.message : error}`,
                    preferredModelAlias: 'fast',
                    preferredReasoning: 'low',
                }, {
                    route: 'news',
                    commandText: fullText,
                }),
            };
        }
    }

    case 'prompt': {
        const out = handlePromptPayload(fullText);
        if (out && out.telegramReply) {
            out.telegramReply = appendExternalLinks(out.telegramReply);
        }
        const modelMeta = pickPreferredModelMeta(out, 'gpt', 'low');
        return {
            handled: true,
            output: withApiMeta({
                route: 'prompt',
                ...out,
                ...modelMeta,
            }, {
                route: 'prompt',
                commandText: fullText,
            }),
        };
    }

    case 'anki': {
        const subCmd = args[0];
        if (subCmd === 'add') {
            const deck = args[1];
            const front = args[2];
            let back = args[3];
            const tags = args[4]
                ? args[4].split(',').map((v) => v.trim()).filter(Boolean)
                : toeicTags;

            if (!front || !back) {
                throw new Error('Usage: anki add <deck> <front> <back> [tags]');
            }

            const finalDeck = deck || toeicDeck;
            back = back.replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
            const dedupeMode = String(config.ankiQualityPolicy?.dedupeMode || 'allow').toLowerCase();
            const result = await anki.addCard(finalDeck, front, back, tags, { dedupeMode });
            const noteMeta = typeof result === 'object' ? result : { noteId: result };
            return {
                handled: true,
                output: withApiMeta({
                    route: 'anki',
                    success: true,
                    deck: finalDeck,
                    ...noteMeta,
                }, {
                    route: 'anki',
                    commandText: fullText,
                }),
            };
        }

        if (subCmd === 'decks') {
            const decks = await anki.getDeckNames();
            return {
                handled: true,
                output: withApiMeta({
                    route: 'anki',
                    decks,
                }, {
                    route: 'anki',
                    commandText: fullText,
                }),
            };
        }

        throw new Error(`Unknown anki command: ${subCmd}`);
    }

    default:
        return { handled: false };
    }
}

module.exports = {
    handleDirectBridgeCommand,
};
