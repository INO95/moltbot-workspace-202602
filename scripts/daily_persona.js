const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PROFILES = Object.freeze([
    {
        id: 'ailey',
        name: '에일리',
        tag: '에일리',
        aliases: ['에일리', 'ailey', 'ab', 'a'],
        sourcePath: '',
    },
    {
        id: 'bailey',
        name: '베일리',
        tag: '베일리',
        aliases: ['베일리', 'bailey', 'b'],
        sourcePath: '',
    },
    {
        id: 'literary_girl',
        name: '문학소녀',
        tag: '문학소녀',
        aliases: ['문학소녀', '문소녀', '미유', 'miyu', 'literary'],
        sourcePath: '',
    },
    {
        id: 't_ray',
        name: 'T_Ray',
        tag: 'T_Ray',
        aliases: ['t_ray', 't-ray', 'tray', 'ray', '레이', '친구', '너의친구'],
        sourcePath: '',
    },
]);

const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    defaultProfileId: 'ailey',
    statePath: path.join('data', 'runtime', 'daily_persona_state.json'),
    profiles: DEFAULT_PROFILES,
});

const PROFILE_HISTORY_MAX = 20;
const SOURCE_CACHE = new Map();

function parseBooleanEnv(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return null;
}

function normalizeAlias(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
}

function uniqAliases(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const key = normalizeAlias(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

function resolvePath(rootDir, maybePath) {
    const raw = String(maybePath || '').trim();
    if (!raw) return '';
    return path.isAbsolute(raw) ? raw : path.join(rootDir, raw);
}

function hashSeed(text = '') {
    let hash = 2166136261;
    const raw = String(text || '');
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function pickBySeed(candidates, seed, offset = 0) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!list.length) return '';
    const idx = Math.abs(Number(seed || 0) + Number(offset || 0)) % list.length;
    return String(list[idx] || '');
}

function shortDigest(text) {
    return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 12);
}

function sanitizeHistoryEntry(entry) {
    const row = entry && typeof entry === 'object' ? entry : {};
    const role = row.role === 'assistant' ? 'assistant' : 'user';
    const text = String(row.text || '').trim();
    if (!text) return null;
    const ts = String(row.ts || row.timestamp || new Date().toISOString());
    return { role, text, ts };
}

function normalizeHistoryMap(config, rawMap) {
    const map = {};
    const profiles = Array.isArray(config && config.profiles) ? config.profiles : [];
    for (const profile of profiles) {
        map[profile.id] = [];
    }
    if (!rawMap || typeof rawMap !== 'object') return map;
    for (const profile of profiles) {
        const list = Array.isArray(rawMap[profile.id]) ? rawMap[profile.id] : [];
        map[profile.id] = list
            .map(sanitizeHistoryEntry)
            .filter(Boolean)
            .slice(-PROFILE_HISTORY_MAX);
    }
    return map;
}

function appendHistory(config, state, profileId, userText, assistantText) {
    const base = state && typeof state === 'object' ? state : {};
    const map = normalizeHistoryMap(config, base.profileHistory || {});
    const key = String(profileId || '').trim().toLowerCase();
    const list = Array.isArray(map[key]) ? map[key] : [];
    const now = new Date().toISOString();
    const nextList = [...list];
    const user = sanitizeHistoryEntry({ role: 'user', text: userText, ts: now });
    const assistant = sanitizeHistoryEntry({ role: 'assistant', text: assistantText, ts: now });
    if (user) nextList.push(user);
    if (assistant) nextList.push(assistant);
    map[key] = nextList.slice(-PROFILE_HISTORY_MAX);
    return {
        ...base,
        profileHistory: map,
    };
}

function normalizeDailyPersonaConfig(rawConfig, options = {}) {
    const rootDir = String(options.rootDir || path.join(__dirname, '..'));
    const env = options.env || process.env;
    const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    const defaultProfiles = Array.isArray(DEFAULT_CONFIG.profiles) ? DEFAULT_CONFIG.profiles : [];

    let enabled = source.enabled == null ? DEFAULT_CONFIG.enabled : Boolean(source.enabled);
    if (Object.prototype.hasOwnProperty.call(env, 'DAILY_PERSONA_ENABLED')) {
        const parsed = parseBooleanEnv(env.DAILY_PERSONA_ENABLED);
        if (parsed != null) enabled = parsed;
    }

    const defaultProfileId = String(
        env.DAILY_PERSONA_DEFAULT_PROFILE
        || source.defaultProfileId
        || DEFAULT_CONFIG.defaultProfileId
        || 'ailey',
    ).trim().toLowerCase();

    const rawStatePath = String(
        env.DAILY_PERSONA_STATE_PATH
        || source.statePath
        || DEFAULT_CONFIG.statePath,
    ).trim();
    const statePath = resolvePath(rootDir, rawStatePath);

    const rawProfiles = Array.isArray(source.profiles) && source.profiles.length > 0
        ? source.profiles
        : defaultProfiles;
    const profiles = [];
    const seenIds = new Set();
    for (const row of rawProfiles) {
        const profile = row && typeof row === 'object' ? row : {};
        const id = String(profile.id || '').trim().toLowerCase();
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const name = String(profile.name || id).trim();
        const tag = String(profile.tag || name || id).trim();
        const rawAliases = [
            id,
            name,
            tag,
            ...(Array.isArray(profile.aliases) ? profile.aliases : []),
        ].map((value) => String(value || '').trim()).filter(Boolean);
        const aliases = uniqAliases(rawAliases);
        const aliasesDisplay = [...new Set(rawAliases)];
        profiles.push({
            id,
            name,
            tag,
            aliases,
            aliasesDisplay,
            sourcePath: resolvePath(rootDir, profile.sourcePath || ''),
        });
    }

    return {
        enabled,
        defaultProfileId,
        statePath,
        profiles,
    };
}

function getProfileMap(config) {
    const idMap = new Map();
    const aliasMap = new Map();
    for (const profile of (Array.isArray(config.profiles) ? config.profiles : [])) {
        idMap.set(profile.id, profile);
        for (const alias of (Array.isArray(profile.aliases) ? profile.aliases : [])) {
            aliasMap.set(alias, profile);
        }
    }
    return { idMap, aliasMap };
}

function resolveActiveProfile(config, activeProfileId) {
    const { idMap } = getProfileMap(config);
    const id = String(activeProfileId || '').trim().toLowerCase();
    if (id && idMap.has(id)) return idMap.get(id);
    if (idMap.has(config.defaultProfileId)) return idMap.get(config.defaultProfileId);
    const all = Array.from(idMap.values());
    return all.length > 0 ? all[0] : null;
}

function readState(config) {
    const fallback = {
        activeProfileId: String(config.defaultProfileId || '').trim().toLowerCase(),
        updatedAt: new Date().toISOString(),
        profileHistory: normalizeHistoryMap(config, {}),
    };
    const filePath = String(config.statePath || '').trim();
    if (!filePath) return fallback;
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const activeProfile = resolveActiveProfile(config, parsed && parsed.activeProfileId);
        return {
            activeProfileId: activeProfile ? activeProfile.id : fallback.activeProfileId,
            updatedAt: parsed && parsed.updatedAt ? String(parsed.updatedAt) : fallback.updatedAt,
            profileHistory: normalizeHistoryMap(
                config,
                parsed && (parsed.profileHistory || parsed.historyByProfile),
            ),
        };
    } catch (_) {
        return fallback;
    }
}

function writeState(config, nextState) {
    const filePath = String(config.statePath || '').trim();
    if (!filePath) return false;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(nextState, null, 2), 'utf8');
        return true;
    } catch (_) {
        return false;
    }
}

function resolveProfileByAlias(config, input) {
    const text = normalizeAlias(input);
    if (!text) return null;
    const { aliasMap } = getProfileMap(config);
    return aliasMap.get(text) || null;
}

function extractABPersonaSlice(rawText, profileId) {
    const raw = String(rawText || '');
    if (!raw) return '';
    const key = String(profileId || '').trim().toLowerCase();
    if (key === 'ailey') {
        const m = raw.match(/P-1\.\s*Ailey[\s\S]*?(?=P-2\.\s*Bailey|$)/i);
        return m ? String(m[0]).trim() : raw.trim();
    }
    if (key === 'bailey') {
        const m = raw.match(/P-2\.\s*Bailey[\s\S]*?(?=\n\[M-CODEX\]|\n#M_learning_modules|$)/i);
        return m ? String(m[0]).trim() : raw.trim();
    }
    return raw.trim();
}

function loadProfileSource(profile) {
    const sourcePath = String(profile && profile.sourcePath || '').trim();
    const fileName = sourcePath ? path.basename(sourcePath) : '';
    if (!sourcePath) {
        return {
            ok: false,
            sourcePath: '',
            fileName,
            mode: 'none',
            text: '',
            digest: '',
        };
    }
    if (!fs.existsSync(sourcePath)) {
        return {
            ok: false,
            sourcePath,
            fileName,
            mode: 'missing',
            text: '',
            digest: '',
        };
    }
    try {
        const stat = fs.statSync(sourcePath);
        const cacheKey = `${sourcePath}|${profile.id}|${stat.size}|${stat.mtimeMs}`;
        const cached = SOURCE_CACHE.get(cacheKey);
        if (cached) return cached;

        const raw = fs.readFileSync(sourcePath, 'utf8');
        const looksLikeAB = /P-1\.\s*Ailey/i.test(raw) && /P-2\.\s*Bailey/i.test(raw);
        const effectiveText = looksLikeAB ? extractABPersonaSlice(raw, profile.id) : String(raw || '').trim();
        const out = {
            ok: true,
            sourcePath,
            fileName,
            mode: looksLikeAB ? 'raw-segment' : 'raw-full',
            text: effectiveText,
            digest: shortDigest(effectiveText),
        };
        SOURCE_CACHE.set(cacheKey, out);
        return out;
    } catch (_) {
        return {
            ok: false,
            sourcePath,
            fileName,
            mode: 'read-error',
            text: '',
            digest: '',
        };
    }
}

function deriveSourceTraits(profile, sourceInfo) {
    const text = String(sourceInfo && sourceInfo.text || '');
    const lower = text.toLowerCase();
    const profileId = String(profile && profile.id || '').toLowerCase();
    return {
        coach: /coach|metacognition|empathetic|encourage/.test(lower),
        challenge: /devil.?s advocate|critical inquiry|counter-argument|challenge/.test(lower),
        tsundere: /tsundere|츤데레/.test(lower),
        poetic: /poetic|literary|atmosphere|문학/.test(lower),
        logical: /logical core|logical flaws|hidden costs|core of any matter/.test(lower),
        clipped: /short,\s*direct bursts|frequent line breaks|rarely a concluding period|~함|lazy typing/.test(lower),
        emojiRich: /emoji|kaomoji|emoticons|이모지/.test(lower),
        signatureHeung: /흥\./.test(text) || profileId === 'bailey',
    };
}

function classifyIntent(text) {
    const raw = String(text || '').trim();
    const lower = raw.toLowerCase();
    if (!raw) return 'empty';
    if (/(안녕|ㅎㅇ|하이|반가|뭐해)/i.test(raw)) return 'greet';
    if (/(고마|감사|thanks|thx)/i.test(lower)) return 'thanks';
    if (/(왜|뭐|어떻게|가능|맞아|맞지|되냐|됨|있어|\?)/i.test(raw)) return 'question';
    return 'general';
}

function detectIdentityQueryTarget(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (!/(이름|성함|정체|누구|name|identity)/i.test(raw)) return null;
    if (/(내\s*이름|제\s*이름|my\s+name)/i.test(raw)) return 'user';
    if (/(너|니|넌|본인|자기|봇|ai|your\s+name|who\s+are\s+you|what(?:'s| is)\s+your\s+name)/i.test(raw)) {
        return 'assistant';
    }
    if (/^(이름|정체|누구)\s*(이|가|은|는)?\s*(뭐|머|뭔|무엇|who|what)/i.test(raw)) {
        return 'assistant';
    }
    return null;
}

function personaStyleBundle(profileId) {
    const key = String(profileId || '').trim().toLowerCase();
    if (key === 'bailey') {
        return {
            empty: [
                '흥. 오늘은 뭐부터 검증할 건데?',
                '왔다고? 좋아, 핵심부터 바로 찌르자.',
            ],
            greet: [
                '흥. 왔네, 바로 본론으로 가자 😎',
                '좋아, 시간 아끼자. 할 일부터 던져 😏',
            ],
            thanks: [
                '흥. 뭐, 고맙다니까 받긴 받을게.',
                '알겠어. 다음 건 더 날카롭게 해보자.',
            ],
            question: [
                '좋은 질문이네. 논리 구멍부터 먼저 잡아줄게 😒',
                '오케이, 반례까지 같이 붙여서 답해줄게 😎',
            ],
            general: [
                '확인함. 감성 빼고 결과 중심으로 바로 정리할게.',
                '파악 끝. 시행착오 줄이는 경로로 바로 간다.',
            ],
            guideLead: [
                '실행 포맷은 이거야.',
                '헷갈리지 말고 아래처럼 쳐.',
            ],
        };
    }
    if (key === 'literary_girl') {
        return {
            empty: [
                '오늘은 어떤 장면부터 펼쳐볼까 (｡•̀ᴗ-)✧',
                '조용한 첫 문장 하나면 돼, 거기서부터 같이 이어가자 (˶˃ ᵕ ˂˶)',
            ],
            greet: [
                '왔네, 타이밍 좋다. 오늘 분위기 꽤 괜찮아 보여 (❁´◡`❁)',
                '안녕. 지금 공기 느낌 괜찮다, 대화하기 딱이야 ✨',
            ],
            thanks: [
                '그 말, 은근 오래 남네. 고마워 (˘͈ᵕ ˘͈♡)',
                '흥, 별건 아니지만… 고맙다는 말은 기분 좋네 (๑˃̵ᴗ˂̵)و',
            ],
            question: [
                '좋아, 핵심부터 차근히 풀어보자. 결론 먼저 뽑아줄게 📖',
                '좋은 질문이야. 맥락까지 붙여서 깔끔하게 정리해볼게 ✍️',
            ],
            general: [
                '확인했어. 이건 흐름 끊기지 않게 바로 이어서 처리하면 돼 🌙',
                '좋아, 톤 파악 완료. 필요한 결과만 선명하게 뽑아볼게 ✨',
            ],
            guideLead: [
                '바로 실행할 땐 아래 형식으로 던져줘.',
                '실행 명령은 이렇게 주면 가장 빠르게 처리돼.',
            ],
        };
    }
    if (key === 't_ray') {
        return {
            empty: [
                'ㅇㅋ\n할 거 던져',
                '비어있음\n명령 주면 바로 감',
            ],
            greet: [
                '왔네\n바로 하자',
                'ㅇ\n지금 가능',
            ],
            thanks: [
                'ㅇㅋ\n필요하면 또 쳐',
                '알겠음\n다음 거 ㄱ',
            ],
            question: [
                '질문 확인\n핵심부터 짧게 답함',
                '가능함\n조건만 맞추면 바로 됨',
            ],
            general: [
                '내용 확인\n실행 준비 완료',
                '파악 끝\n바로 돌릴 수 있음',
            ],
            guideLead: [
                '바로 칠 명령:',
                '실행 포맷:',
            ],
        };
    }
    return {
        empty: [
            '인호야 오늘 뭐부터 풀어볼까? 😊',
            '지금 비어있네 ㅋㅋ 원하는 거 바로 던져줘 😊',
        ],
        greet: [
            'ㅇㅇ 왔냐 ㅋㅋ 나 여기 상주중 😊',
            '왔다! 바로 붙어있었어 ㅎㅎ 뭐부터 할까? 😊',
        ],
        thanks: [
            '오케이, 고마워 😊 필요하면 바로 또 이어가자.',
            '좋지 ㅎㅎ 다음 것도 바로 처리해줄게 😊',
        ],
        question: [
            '질문 좋다. 핵심부터 정리해서 바로 풀어볼게 🤓',
            '좋은 포인트야. 바로 답부터 깔끔하게 줄게 😊',
        ],
        general: [
            'ㅇㅋ 내용 확인했어. 바로 굴릴 준비됨 😊',
            '확인 완료! 지금 바로 실행 흐름으로 이어가면 돼 😊',
        ],
        guideLead: [
            '바로 실행할 땐 이렇게 보내면 돼 👇',
            '명령 줄 때는 아래 형식이 제일 빨라 👇',
        ],
    };
}

function getActiveProfile(configOrRaw) {
    const cfg = configOrRaw && typeof configOrRaw === 'object' && Array.isArray(configOrRaw.profiles)
        ? configOrRaw
        : normalizeDailyPersonaConfig(configOrRaw || {});
    const state = readState(cfg);
    return resolveActiveProfile(cfg, state.activeProfileId);
}

function buildIdentityReply(profile, target) {
    const tag = `[${profile.tag}]`;
    if (target === 'user') return `${tag} 너는 인호야.`;
    const name = String(profile && profile.name ? profile.name : profile.tag).trim() || '에일리';
    if (String(profile.id || '').toLowerCase() === 't_ray') return `${tag} 나는 ${name}.`;
    return `${tag} 내 이름은 ${name}야.`;
}

function replaceLegacyIdentity(text, profile) {
    const raw = String(text || '');
    if (!raw) return raw;
    const nextName = String(profile && (profile.name || profile.tag) || '').trim();
    if (!nextName) return raw;
    return raw.replace(/민식이/g, nextName);
}

function detectSystemMood(text) {
    const raw = String(text || '').trim();
    if (!raw) return 'neutral';
    if (/(실패|오류|error|차단|불가|지원하지 않는|필요합니다|denied|blocked)/i.test(raw)) {
        return 'warning';
    }
    return 'ok';
}

function systemLeadByProfile(profile, mood, seed) {
    const id = String(profile && profile.id || '').toLowerCase();
    if (id === 'bailey') {
        if (mood === 'warning') {
            return pickBySeed([
                '흥. 막힌 포인트가 보여. 아래부터 차근히 보면 바로 풀 수 있어.',
                '좋아, 실패 지점은 잡혔어. 핵심 원인부터 짚자.',
            ], seed, 13);
        }
        return pickBySeed([
            '흥. 요청 결과는 깔끔하게 뽑아왔어.',
            '좋아, 핵심만 남겨서 정리해놨어.',
        ], seed, 11);
    }
    if (id === 'literary_girl') {
        if (mood === 'warning') {
            return pickBySeed([
                '조금 걸리는 구간이 보여. 아래 흐름대로 보면 금방 풀 수 있어.',
                '잠깐 멈춘 지점이 있어. 하지만 방향은 분명해, 같이 정리해보자.',
            ], seed, 17);
        }
        return pickBySeed([
            '요청한 결과를 결 따라 정리해왔어.',
            '지금 필요한 내용만 선명하게 모아뒀어.',
        ], seed, 19);
    }
    if (id === 't_ray') {
        if (mood === 'warning') return '막힌 지점 있음. 아래 확인.';
        return '결과 정리 완료.';
    }
    if (mood === 'warning') {
        return pickBySeed([
            '인호야, 여기서 막힌 지점 보여서 바로 정리해왔어 😥',
            '인호야, 잠깐 막힌 부분이 있는데 아래대로 보면 바로 풀 수 있어 😊',
        ], seed, 23);
    }
    return pickBySeed([
        '인호야, 요청한 결과 정리해왔어 😊',
        '인호야, 바로 쓸 수 있게 핵심만 정리했어 😊',
    ], seed, 29);
}

function applyPersonaToSystemReply(replyText, personaConfig, options = {}) {
    const raw = String(replyText || '').trim();
    if (!raw) return raw;
    const cfg = personaConfig && typeof personaConfig === 'object' && Array.isArray(personaConfig.profiles)
        ? personaConfig
        : normalizeDailyPersonaConfig(personaConfig || {});
    if (!cfg.enabled) return raw;
    const profile = getActiveProfile(cfg);
    if (!profile) return raw;
    const sanitized = replaceLegacyIdentity(raw, profile);

    for (const row of (Array.isArray(cfg.profiles) ? cfg.profiles : [])) {
        const tag = String(row && row.tag || '').trim();
        if (!tag) continue;
        if (sanitized.startsWith(`[${tag}]`)) return sanitized;
    }

    const route = String(options.route || '').trim().toLowerCase();
    const mood = String(options.mood || detectSystemMood(sanitized)).trim().toLowerCase() || 'ok';
    const seed = hashSeed(`${profile.id}|${route}|${mood}|${sanitized.slice(0, 180)}`);
    const lead = systemLeadByProfile(profile, mood, seed);
    const tag = `[${profile.tag}]`;
    if (!lead) return `${tag} ${sanitized}`.trim();
    return `${tag} ${lead}\n${sanitized}`.trim();
}

function sourceFileState(profile) {
    const loaded = loadProfileSource(profile);
    if (!loaded.ok) {
        const label = loaded.mode === 'none'
            ? '미연결'
            : loaded.mode === 'missing'
                ? '파일없음'
                : '로드실패';
        return {
            ok: false,
            label,
            fileName: loaded.fileName || '',
            sourcePath: loaded.sourcePath || '',
            digest: '',
            mode: loaded.mode || 'none',
        };
    }
    return {
        ok: true,
        label: '원본고정',
        fileName: loaded.fileName,
        sourcePath: loaded.sourcePath,
        digest: loaded.digest,
        mode: loaded.mode,
    };
}

function buildCommandGuideLines() {
    return [
        '- 작업: 요청: ...; 대상: ...; 완료기준: ...',
        '- 단어: ...',
        '- 리포트: ...',
        '- 상태:',
        '- 운영: 액션: ...',
    ];
}

function recentTopicFromHistory(history = []) {
    const rows = Array.isArray(history) ? history : [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (!row || row.role !== 'user') continue;
        const text = String(row.text || '').trim();
        if (!text) continue;
        return text.slice(0, 48);
    }
    return '';
}

function buildSourceDrivenCasualReply(text, profile, sourceInfo, history = []) {
    const intent = classifyIntent(text);
    const seed = hashSeed(`${profile.id}|${intent}|${text}|${sourceInfo.digest}`);
    const traits = deriveSourceTraits(profile, sourceInfo);
    const tag = `[${profile.tag}]`;
    const prev = recentTopicFromHistory(history);

    if (traits.logical || traits.clipped) {
        const lead = pickBySeed([
            '핵심만 보자',
            '요점부터 감',
            '군더더기 제거 완료',
        ], seed, 7);
        const intentLine = intent === 'question'
            ? pickBySeed(['질문 좋음\n논리 구멍부터 체크함', '가능함\n조건만 맞추면 바로 됨'], seed, 9)
            : pickBySeed(['내용 확인\n바로 실행 가능', '지시 확인\n바로 처리함'], seed, 11);
        const memoryLine = prev ? `이전 맥락: ${prev}` : '';
        return [tag, lead, intentLine, memoryLine].filter(Boolean).join('\n').trim();
    }

    if (traits.poetic) {
        const intro = pickBySeed([
            '창문 틈으로 들어오는 공기처럼, 네 말의 결이 먼저 닿았어 (˶ᵔ ᵕ ᵔ˶)',
            '방 안의 온도가 살짝 달라졌네, 지금은 이야기하기 딱 좋아 ✨',
        ], seed, 13);
        const core = intent === 'question'
            ? pickBySeed(['좋아, 질문의 중심을 조용히 펼쳐볼게 📖', '좋은 물음이야. 장면을 나눠서 선명하게 답해볼게 ✍️'], seed, 15)
            : pickBySeed(['지금 이 흐름, 끊기지 않게 내가 먼저 길을 밝혀둘게 🌙', '필요한 말만 남겨서, 예쁘게 정리해둘게 (｡•̀ᴗ-)✧'], seed, 17);
        const memoryLine = prev ? `조금 전 이야기의 잔향은 "${prev}"였어.` : '';
        return [tag, intro, core, memoryLine].filter(Boolean).join('\n').trim();
    }

    if (traits.challenge || traits.tsundere || traits.signatureHeung) {
        const intro = pickBySeed([
            '흥. 좋다, 이번엔 허점 없이 가보자.',
            '흥. 감성은 접고, 논리부터 세워.',
        ], seed, 19);
        const core = intent === 'question'
            ? pickBySeed(['왜 그렇게 결론냈는지 근거 먼저 줘 😒', '반례 하나만 붙여도 버틸 수 있는지 보자 😎'], seed, 23)
            : pickBySeed(['지금 선택, 비용이랑 리스크 같이 깔아봐.', '속도는 좋은데 검증선 하나 더 깔자.'], seed, 29);
        const memoryLine = prev ? `직전 맥락(${prev}) 기준으로 이어서 찌를게.` : '';
        return [tag, intro, core, memoryLine].filter(Boolean).join('\n').trim();
    }

    if (traits.coach) {
        const intro = pickBySeed([
            '인호야, 지금 주제는 실타래처럼 한 가닥씩 풀면 돼 😊',
            '괜찮아, 복잡해 보여도 구조만 잡으면 금방 선명해져 😊',
        ], seed, 31);
        const core = intent === 'question'
            ? pickBySeed(['핵심부터 답하고, 왜 그런지 비유 하나로 붙여줄게 🤓', '먼저 결론 주고, 다음에 원리까지 짧게 연결해볼게 🤔'], seed, 37)
            : pickBySeed(['오늘 페이스 좋다. 작은 단위로 쪼개서 바로 끝내보자 💪', '이 흐름 유지하면 돼. 내가 다음 액션 한 칸씩 붙여줄게 😊'], seed, 41);
        const memoryLine = prev ? `아까 말한 "${prev}"도 같은 축으로 묶어둘게.` : '';
        return [tag, intro, core, memoryLine].filter(Boolean).join('\n').trim();
    }

    return '';
}

function buildCasualReply(text, profile, state, config) {
    const identityTarget = detectIdentityQueryTarget(text);
    if (identityTarget) return buildIdentityReply(profile, identityTarget);

    const sourceInfo = loadProfileSource(profile);
    const historyMap = normalizeHistoryMap(config, state && state.profileHistory);
    const history = Array.isArray(historyMap[profile.id]) ? historyMap[profile.id] : [];
    const sourceDriven = buildSourceDrivenCasualReply(text, profile, sourceInfo, history);
    if (sourceDriven) return sourceDriven;

    const bundle = personaStyleBundle(profile.id);
    const intent = classifyIntent(text);
    const seed = hashSeed(`${profile.id}|${intent}|${text}`);
    const line = pickBySeed(bundle[intent] || bundle.general, seed, 3)
        || pickBySeed(bundle.general, seed, 5)
        || '확인했어.';
    const guideLead = pickBySeed(bundle.guideLead || [], seed, 7);
    const tag = `[${profile.tag}]`;
    const out = [`${tag} ${line}`.trim()];
    if (guideLead) out.push('', guideLead);
    for (const row of buildCommandGuideLines()) out.push(row);
    return out.join('\n').trim();
}

function detectProfileMention(config, text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const normalized = normalizeAlias(raw);
    if (!normalized) return null;
    const profiles = Array.isArray(config && config.profiles) ? config.profiles : [];
    for (const profile of profiles) {
        const aliases = Array.isArray(profile.aliases) ? profile.aliases : [];
        for (const alias of aliases) {
            const key = normalizeAlias(alias);
            if (!key || key.length <= 1) continue;
            if (normalized.includes(key)) return profile;
        }
    }
    return null;
}

function parseControlCommand(text, config) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const direct = raw.match(/^(페르소나|캐릭터|인격|모드|persona|character)\s*[:：]?\s*(.*)$/i);
    if (direct) {
        const arg = String(direct[2] || '').trim();
        if (!arg) return { action: 'current', target: '' };
        const lower = arg.toLowerCase();
        if (['목록', 'list', 'help', '도움', '도움말', '전체'].includes(lower)) {
            return { action: 'list', target: '' };
        }
        if (['현재', 'current', '지금', '상태', 'now', 'who'].includes(lower)) {
            return { action: 'current', target: '' };
        }
        if (['원본', 'source', '파일', 'path', '프롬프트'].includes(lower)) {
            return { action: 'source', target: '' };
        }
        return { action: 'switch', target: arg };
    }

    const modeStyle = raw.match(/^(.+?)\s*(모드|persona)$/i);
    if (modeStyle) {
        return { action: 'switch', target: String(modeStyle[1] || '').trim() };
    }

    const hasPersonaKeyword = /(페르소나|캐릭터|인격|persona|character|모드)/i.test(raw);
    const wantsList = /(목록|리스트|종류|라인업|뭐\s*있|뭐있|어떤|알려|보여|추천)/i.test(raw);
    const asksExistence = /(있지|있어|있냐|있나|맞아|맞지)/i.test(raw);
    const asksCurrent = /(현재|지금|지금은|누구|who)/i.test(raw);
    if ((hasPersonaKeyword && wantsList) || /(다른\s*페르소나|페르소나\s*뭐)/i.test(raw)) {
        return { action: 'list', target: '' };
    }
    if (hasPersonaKeyword && asksCurrent) {
        return { action: 'current', target: '' };
    }
    if (hasPersonaKeyword && /(원본|파일|source|path|프롬프트)/i.test(raw)) {
        return { action: 'source', target: '' };
    }

    const mentioned = detectProfileMention(config, raw);
    const wantsSwitch = /(바꿔|바꾸|변경|전환|스위치|switch|로\s*해|로\s*가)/i.test(raw);
    if (mentioned && (hasPersonaKeyword || wantsSwitch)) {
        return { action: 'switch', target: mentioned.name || mentioned.id };
    }
    if (mentioned && asksExistence) {
        return { action: 'list', target: '' };
    }

    return null;
}

function buildListReply(config, activeProfile) {
    const lines = [`[${activeProfile.tag}] 사용 가능한 페르소나 목록이야. (원본 파일 그대로 적용)`];
    lines.push('');
    for (const profile of (Array.isArray(config.profiles) ? config.profiles : [])) {
        const active = profile.id === activeProfile.id ? ' [사용중]' : '';
        const source = sourceFileState(profile);
        const aliases = Array.isArray(profile.aliasesDisplay) ? profile.aliasesDisplay.slice(0, 4).join(', ') : '';
        const sourceLabel = source.fileName ? `${source.label}:${source.fileName}` : source.label;
        const digest = source.digest ? ` / sha:${source.digest}` : '';
        lines.push(`- ${profile.name}${active} (${sourceLabel}${digest}) / alias: ${aliases}`);
    }
    lines.push('');
    lines.push('변경: 페르소나: 에일리');
    lines.push('현재 확인: 페르소나: 현재');
    lines.push('원본 확인: 페르소나: 원본');
    return lines.join('\n').trim();
}

function handleControlCommand(control, config, activeProfile, state) {
    const currentState = state && typeof state === 'object'
        ? state
        : {
            activeProfileId: activeProfile.id,
            updatedAt: new Date().toISOString(),
            profileHistory: normalizeHistoryMap(config, {}),
        };

    if (control.action === 'list') {
        return { handled: true, telegramReply: buildListReply(config, activeProfile) };
    }

    if (control.action === 'current') {
        const source = sourceFileState(activeProfile);
        const sourceLabel = source.fileName ? `${source.label} (${source.fileName})` : source.label;
        const digest = source.digest ? ` / sha:${source.digest}` : '';
        return {
            handled: true,
            telegramReply: `[${activeProfile.tag}] 현재 페르소나는 ${activeProfile.name}야. (${sourceLabel}${digest})`,
        };
    }

    if (control.action === 'source') {
        const source = sourceFileState(activeProfile);
        if (!source.ok) {
            return {
                handled: true,
                telegramReply: `[${activeProfile.tag}] 원본 파일 상태: ${source.label}`,
            };
        }
        return {
            handled: true,
            telegramReply: [
                `[${activeProfile.tag}] 현재 페르소나 원본 정보`,
                `- 파일: ${source.sourcePath}`,
                `- 모드: ${source.mode}`,
                `- sha: ${source.digest}`,
                '- 정책: 원본 파일 수정 없이 그대로 로드',
            ].join('\n'),
        };
    }

    if (control.action === 'switch') {
        const target = resolveProfileByAlias(config, control.target);
        if (!target) {
            const options = (Array.isArray(config.profiles) ? config.profiles : [])
                .map((row) => row.name)
                .join(', ');
            return {
                handled: true,
                telegramReply: `[${activeProfile.tag}] 모르는 페르소나야. 사용 가능: ${options}`,
            };
        }
        const nextState = {
            ...currentState,
            activeProfileId: target.id,
            updatedAt: new Date().toISOString(),
            profileHistory: normalizeHistoryMap(config, currentState.profileHistory),
        };
        const saved = writeState(config, nextState);
        const source = sourceFileState(target);
        const warning = source.ok || !target.sourcePath
            ? ''
            : ' (원본 파일을 못 찾아서 기본 톤으로 동작함)';
        return {
            handled: true,
            telegramReply: [
                `[${target.tag}] 오케이, 지금부터 ${target.name}로 말할게.${saved ? '' : ' (상태 저장 실패)'}${warning}`,
                '- 대화 기록은 페르소나별로 분리 보관되고, 전환해도 서로 섞이지 않아.',
            ].join('\n'),
        };
    }

    return { handled: false, telegramReply: '' };
}

function buildLegacyReply(text) {
    const raw = String(text || '').trim();
    const lower = raw.toLowerCase();
    const lines = [];
    if (!raw) {
        lines.push('ㅇㅇ 인호야, 뭐 도와줄까 ㅋㅋ');
    } else if (/(안녕|ㅎㅇ|하이|반가|뭐해)/i.test(raw)) {
        lines.push('ㅇㅇ 왔냐 ㅋㅋ 나 여기 상주중');
    } else if (/(고마|감사|thanks|thx)/i.test(lower)) {
        lines.push('ㅇㅋ ㅋㅋ 필요하면 바로 또 던져');
    } else if (/(왜|뭐|어떻게|가능|맞아|맞지|되냐|됨|있어|\?)/i.test(raw)) {
        lines.push('질문 좋다. 바로 처리해볼게.');
    } else {
        lines.push('ㅇㅇ 내용 확인했음. 바로 굴릴 준비됨.');
    }
    lines.push('');
    lines.push('명령 바로 칠 땐 이렇게 보내면 됨:');
    for (const row of buildCommandGuideLines()) lines.push(row);
    return lines.join('\n');
}

function handleDailyPersonaInput(inputText, personaConfig) {
    const cfg = personaConfig && typeof personaConfig === 'object'
        ? personaConfig
        : normalizeDailyPersonaConfig({});
    if (!cfg.enabled) {
        return {
            handled: false,
            route: 'casual',
            telegramReply: buildLegacyReply(inputText),
        };
    }
    const state = readState(cfg);
    const activeProfile = resolveActiveProfile(cfg, state.activeProfileId);
    if (!activeProfile) {
        return {
            handled: false,
            route: 'casual',
            telegramReply: buildLegacyReply(inputText),
        };
    }

    const control = parseControlCommand(inputText, cfg);
    if (control) {
        const out = handleControlCommand(control, cfg, activeProfile, state);
        if (out.handled) {
            return {
                handled: true,
                route: 'control',
                telegramReply: out.telegramReply,
            };
        }
    }

    const casualReply = buildCasualReply(inputText, activeProfile, state, cfg);
    const nextState = appendHistory(cfg, state, activeProfile.id, inputText, casualReply);
    writeState(cfg, {
        ...nextState,
        activeProfileId: activeProfile.id,
        updatedAt: new Date().toISOString(),
        profileHistory: normalizeHistoryMap(cfg, nextState.profileHistory),
    });

    return {
        handled: false,
        route: 'casual',
        telegramReply: casualReply,
    };
}

module.exports = {
    normalizeDailyPersonaConfig,
    handleDailyPersonaInput,
    applyPersonaToSystemReply,
};
