const engine = require('./molt_engine');
const anki = require('./anki_connect');
const config = require('../data/config.json');
const promptBuilder = require('./prompt_builder');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ENV_PATH = path.join(__dirname, '..', '.env');

function loadDotEnv() {
    try {
        if (!fs.existsSync(ENV_PATH)) return;
        const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = String(line || '').trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf('=');
            if (idx <= 0) continue;
            const key = trimmed.slice(0, idx).trim();
            const value = trimmed.slice(idx + 1).trim();
            if (!process.env[key]) process.env[key] = value;
        }
    } catch (_) { }
}

loadDotEnv();

function splitWords(text) {
    const raw = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Telegram/bridge에서 literal "\\n"으로 들어온 경우도 실제 개행으로 취급
        .replace(/\\n/g, '\n');

    const byLines = raw
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

    if (byLines.length > 1) return byLines;

    // 개행이 없는 단일 메시지일 때만 comma fallback 사용
    return raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function stripListPrefix(token) {
    return String(token || '')
        .replace(/^\s*[\-\*\u2022]+\s*/, '')
        .replace(/^\s*\d+\s*[\.\)]\s*/, '')
        .trim();
}

function parseWordToken(token) {
    const clean = stripListPrefix(token);
    if (!clean) return null;

    // 명시 구분자 우선 (:, |, " - ")
    const explicit = clean.match(/^([A-Za-z][A-Za-z\-'\s]{0,80}?)\s*(?:[:：|]| - )\s*(.+)$/);
    if (explicit) {
        return { word: explicit[1].trim(), hint: explicit[2].trim() };
    }

    // "activate 활성화하다" 같은 형태: 영어 구간 + 한글 뜻
    const mixed = clean.match(/^([A-Za-z][A-Za-z\-'\s]{0,80}?)\s+([가-힣].+)$/);
    if (mixed) {
        return { word: mixed[1].trim(), hint: mixed[2].trim() };
    }

    // 영어만 있으면 전체를 단어/구로 간주
    if (/^[A-Za-z][A-Za-z\-'\s]{0,120}$/.test(clean)) {
        return { word: clean.trim(), hint: '' };
    }

    return null;
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

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                if (!(res.statusCode >= 200 && res.statusCode < 300)) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(raw));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.setTimeout(7000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

function normalizeWordToken(rawWord) {
    return String(rawWord || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function fallbackMeaning(word) {
    const key = normalizeWordToken(word);
    const map = {
        'be willing to': '기꺼이 ~하다, ~할 의향이 있다',
    };
    return map[key] || null;
}

function chooseBestDefinition(entry) {
    const preferred = ['verb', 'noun', 'adjective', 'adverb'];
    const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
    const sorted = [...meanings].sort((a, b) => {
        const ia = preferred.indexOf(String(a.partOfSpeech || '').toLowerCase());
        const ib = preferred.indexOf(String(b.partOfSpeech || '').toLowerCase());
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    for (const m of sorted) {
        const defs = Array.isArray(m.definitions) ? m.definitions : [];
        if (defs.length) {
            const d = defs[0];
            return {
                partOfSpeech: m.partOfSpeech || '',
                meaning: d.definition || '',
                example: d.example || '',
            };
        }
    }
    return null;
}

function simplifyMeaningForToeic(defText, word) {
    const fallback = fallbackMeaning(word);
    if (fallback) return fallback;
    const raw = String(defText || '').trim();
    if (!raw) return '(의미 보강 필요)';
    return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function fallbackExample(word) {
    const w = String(word || '').trim();
    return `Our team is willing to use ${w} in business communication when appropriate.`;
}

function buildWordCandidates(word) {
    const raw = String(word || '').trim().toLowerCase();
    if (!raw) return [];
    const out = [raw];
    if (!/^[a-z][a-z-']{1,60}$/.test(raw)) {
        return [...new Set(out)];
    }
    if (raw.endsWith('ies') && raw.length > 4) out.push(`${raw.slice(0, -3)}y`);
    if (raw.endsWith('ied') && raw.length > 4) out.push(`${raw.slice(0, -3)}y`);
    if (raw.endsWith('es') && raw.length > 3) out.push(raw.slice(0, -2));
    if (raw.endsWith('s') && raw.length > 3) out.push(raw.slice(0, -1));
    if (raw.endsWith('ing') && raw.length > 5) {
        const stem = raw.slice(0, -3);
        out.push(stem);
        out.push(`${stem}e`);
    }
    if (raw.endsWith('ed') && raw.length > 4) {
        const stem = raw.slice(0, -2);
        out.push(stem);
        out.push(`${stem}e`);
        if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
            out.push(stem.slice(0, -1));
        }
    }
    return [...new Set(out)];
}

async function enrichToeicWord(word, hint) {
    const fallback = {
        meaning: fallbackMeaning(word) || hint || '(의미 보강 필요)',
        example: fallbackExample(word),
    };
    if (hint && String(hint).trim()) {
        return { ...fallback, meaning: String(hint).trim() };
    }
    const candidates = buildWordCandidates(word);
    for (const candidate of candidates) {
        try {
            const query = encodeURIComponent(candidate);
            const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${query}`;
            const data = await httpGetJson(url);
            const first = Array.isArray(data) ? data[0] : null;
            const chosen = first ? chooseBestDefinition(first) : null;
            if (!chosen) continue;
            return {
                meaning: simplifyMeaningForToeic(chosen.meaning, candidate),
                example: String(chosen.example || '').trim() || fallbackExample(candidate),
                partOfSpeech: chosen.partOfSpeech || '',
                lemma: candidate,
            };
        } catch (_) {
            // try next candidate
        }
    }
    return fallback;
}

function buildToeicAnswerRich(word, meaningText, exampleText, partOfSpeech = '') {
    const meaning = String(meaningText || '(의미 보강 필요)').trim();
    const ex = String(exampleText || fallbackExample(word)).trim();
    const pos = partOfSpeech ? `품사: ${partOfSpeech}<br>` : '';
    return [
        `뜻: <b>${meaning}</b>`,
        '<hr>',
        `${pos}예문: <i>${ex}</i>`,
        `해석: ${word}의 의미를 문맥에 맞게 사용하세요.`,
        '<hr>',
        '💡 <b>TOEIC TIP:</b> 비즈니스 문맥 예문과 함께 암기하세요.',
    ].join('<br>');
}

const COMMAND_TEMPLATE_SCHEMA = {
    work: {
        displayName: '작업',
        required: ['요청', '대상', '완료기준'],
        optional: ['제약', '우선순위', '기한'],
        aliases: {
            요청: ['요청', '목표', '작업', 'task', 'goal'],
            대상: ['대상', '범위', 'target', 'scope', 'repo', '파일'],
            완료기준: ['완료기준', '성공기준', 'done', 'acceptance'],
            제약: ['제약', '조건', 'constraint'],
            우선순위: ['우선순위', 'priority'],
            기한: ['기한', 'due', 'deadline'],
        },
    },
    inspect: {
        displayName: '점검',
        required: ['대상', '체크항목'],
        optional: ['출력형식', '심각도기준'],
        aliases: {
            대상: ['대상', '범위', 'target', 'scope'],
            체크항목: ['체크항목', '점검항목', 'check', 'checklist'],
            출력형식: ['출력형식', '형식', 'format'],
            심각도기준: ['심각도기준', 'severity'],
        },
    },
    deploy: {
        displayName: '배포',
        required: ['대상', '환경', '검증'],
        optional: ['롤백', '승인자'],
        aliases: {
            대상: ['대상', '서비스', 'target', 'service'],
            환경: ['환경', 'env', 'environment'],
            검증: ['검증', '검증방법', 'verify'],
            롤백: ['롤백', 'rollback'],
            승인자: ['승인자', 'approver'],
        },
    },
    ops: {
        displayName: '운영',
        required: ['액션', '대상'],
        optional: ['사유'],
        aliases: {
            액션: ['액션', 'action', '명령'],
            대상: ['대상', 'target', '서비스'],
            사유: ['사유', 'reason', '메모'],
        },
    },
};

const OPS_ALLOWED_TARGETS = {
    main: 'moltbot-main',
    sub1: 'moltbot-sub1',
    proxy: 'moltbot-proxy',
    webproxy: 'moltbot-web-proxy',
    tunnel: 'moltbot-dev-tunnel',
    prompt: 'moltbot-prompt-web',
    web: ['moltbot-prompt-web', 'moltbot-web-proxy'],
    all: ['moltbot-main', 'moltbot-sub1', 'moltbot-prompt-web', 'moltbot-proxy', 'moltbot-web-proxy', 'moltbot-dev-tunnel'],
};

function normalizeOpsAction(value) {
    const v = String(value || '').trim().toLowerCase();
    if (/(재시작|restart|reboot)/.test(v)) return 'restart';
    if (/(상태|status|health|check)/.test(v)) return 'status';
    return null;
}

function normalizeOpsTarget(value) {
    const raw = String(value || '').trim().toLowerCase();
    const map = {
        'main': 'main',
        '메인': 'main',
        'sub': 'sub1',
        'sub1': 'sub1',
        '서브': 'sub1',
        'proxy': 'proxy',
        '프록시': 'proxy',
        'webproxy': 'webproxy',
        '웹프록시': 'webproxy',
        'tunnel': 'tunnel',
        '터널': 'tunnel',
        'prompt': 'prompt',
        '프롬프트': 'prompt',
        'web': 'web',
        '웹': 'web',
        'all': 'all',
        '전체': 'all',
    };
    return map[raw] || null;
}

function execDocker(args) {
    const res = spawnSync('docker', args, { encoding: 'utf8' });
    return {
        ok: !res.error && res.status === 0,
        code: res.status == null ? 1 : res.status,
        stdout: String(res.stdout || '').trim(),
        stderr: String(res.stderr || '').trim(),
        error: res.error ? String(res.error.message || res.error) : '',
    };
}

const OPS_QUEUE_PATH = path.join(__dirname, '..', 'data', 'runtime', 'ops_requests.jsonl');
const OPS_SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'runtime', 'ops_snapshot.json');

function isDockerPermissionError(errText) {
    return /(EACCES|permission denied|Cannot connect to the Docker daemon|is the docker daemon running)/i.test(String(errText || ''));
}

function queueOpsRequest(action, targetKey, targets, reason = '') {
    const id = `ops-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const row = {
        id,
        createdAt: new Date().toISOString(),
        action,
        target: targetKey,
        targets,
        reason: String(reason || '').trim(),
        status: 'pending',
    };
    const dir = path.dirname(OPS_QUEUE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(OPS_QUEUE_PATH, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
}

function readOpsSnapshot() {
    try {
        const raw = fs.readFileSync(OPS_SNAPSHOT_PATH, 'utf8');
        const json = JSON.parse(raw);
        if (!json || !Array.isArray(json.containers)) return null;
        return json;
    } catch (_) {
        return null;
    }
}

function runOpsCommand(payloadText) {
    const parsed = parseStructuredCommand('ops', payloadText);
    if (!parsed.ok) {
        return { route: 'ops', templateValid: false, ...parsed };
    }
    const action = normalizeOpsAction(parsed.fields.액션);
    const targetKey = normalizeOpsTarget(parsed.fields.대상);
    if (!action) {
        return {
            route: 'ops',
            templateValid: false,
            error: '지원하지 않는 액션입니다. (지원: 재시작, 상태)',
            telegramReply: '운영 템플릿 액션은 `재시작` 또는 `상태`만 지원합니다.',
        };
    }
    if (!targetKey || !OPS_ALLOWED_TARGETS[targetKey]) {
        return {
            route: 'ops',
            templateValid: false,
            error: '지원하지 않는 대상입니다.',
            telegramReply: '운영 대상은 main/sub1/proxy/webproxy/tunnel/prompt/web/all 만 지원합니다.',
        };
    }

    const targets = Array.isArray(OPS_ALLOWED_TARGETS[targetKey])
        ? OPS_ALLOWED_TARGETS[targetKey]
        : [OPS_ALLOWED_TARGETS[targetKey]];

    if (action === 'status') {
        const ps = execDocker(['ps', '--format', '{{.Names}}\t{{.Status}}']);
        if (!ps.ok) {
            if (isDockerPermissionError(ps.stderr || ps.error)) {
                const snap = readOpsSnapshot();
                const tunnelUrl = getTunnelPublicBaseUrl();
                const tunnelLine = tunnelUrl ? `\n- tunnel-url: ${tunnelUrl}` : '';
                if (snap && Array.isArray(snap.containers)) {
                    const filteredSnap = snap.containers
                        .filter((c) => targets.some((t) => String(c.name || '').trim() === t))
                        .map((c) => `${c.name}\t${c.status}`);
                    return {
                        route: 'ops',
                        templateValid: true,
                        success: true,
                        action,
                        target: targetKey,
                        source: 'snapshot',
                        snapshotUpdatedAt: snap.updatedAt || null,
                        results: filteredSnap,
                        telegramReply: filteredSnap.length
                            ? `운영 상태(스냅샷 ${snap.updatedAt || ''}):\n- ${filteredSnap.join('\n- ')}${tunnelLine}`
                            : `운영 상태(스냅샷): 대상 정보가 없습니다.${tunnelLine}`,
                    };
                }
            }
            return {
                route: 'ops',
                templateValid: true,
                success: false,
                action,
                target: targetKey,
                telegramReply: `운영 상태 조회 실패: ${ps.stderr || ps.error || 'unknown error'}`,
            };
        }
        const lines = ps.stdout.split('\n').filter(Boolean);
        const filtered = lines.filter((line) => targets.some((t) => line.startsWith(`${t}\t`)));
        const tunnelUrl = targetKey === 'tunnel' || targetKey === 'all' ? getTunnelPublicBaseUrl() : null;
        const tunnelLine = tunnelUrl ? `\n- tunnel-url: ${tunnelUrl}` : '';
        return {
            route: 'ops',
            templateValid: true,
            success: true,
            action,
            target: targetKey,
            results: filtered,
            telegramReply: filtered.length
                ? `운영 상태:\n- ${filtered.join('\n- ')}${tunnelLine}`
                : '운영 상태: 대상 컨테이너를 찾지 못했습니다.',
        };
    }

    const results = [];
    for (const container of targets) {
        const r = execDocker(['restart', container]);
        results.push({ container, ...r });
    }
    const permissionBlocked = results.some((r) => !r.ok && isDockerPermissionError(r.stderr || r.error));
    if (permissionBlocked) {
        const queued = queueOpsRequest(action, targetKey, targets, parsed.fields.사유 || '');
        return {
            route: 'ops',
            templateValid: true,
            success: true,
            queued: true,
            action,
            target: targetKey,
            requestId: queued.id,
            telegramReply: `운영 재시작 요청 접수: ${queued.id}\n호스트 작업 큐에서 순차 실행됩니다.`,
        };
    }
    const failed = results.filter((r) => !r.ok);
    return {
        route: 'ops',
        templateValid: true,
        success: failed.length === 0,
        action,
        target: targetKey,
        results,
        telegramReply: failed.length === 0
            ? `운영 재시작 완료: ${targets.join(', ')}`
            : `운영 재시작 일부 실패: ${failed.map((f) => f.container).join(', ')}`,
    };
}

function normalizeHttpsBase(v) {
    const out = String(v || '').trim().replace(/\/+$/, '');
    return /^https:\/\/[a-z0-9.-]+$/i.test(out) ? out : null;
}

function getTunnelPublicBaseUrl() {
    // Backward-compat helper for legacy callers.
    const bases = getPublicBases();
    return bases.promptBase || bases.genericBase || null;
}

function getPublicBases() {
    const promptEnv = normalizeHttpsBase(process.env.PROMPT_PUBLIC_BASE_URL || '');
    const genericEnv = normalizeHttpsBase(process.env.DEV_TUNNEL_PUBLIC_BASE_URL || '');

    if (promptEnv || genericEnv) {
        return {
            promptBase: promptEnv || genericEnv || null,
            genericBase: genericEnv || null,
        };
    }

    // Host-side tunnel manager writes latest URL to a shared state file.
    try {
        const statePath = path.join(__dirname, '..', 'data', 'runtime', 'tunnel_state.json');
        const raw = fs.readFileSync(statePath, 'utf8');
        const json = JSON.parse(raw);
        const candidate = normalizeHttpsBase(json && json.publicUrl ? json.publicUrl : '');
        if (candidate) {
            return {
                promptBase: candidate,
                genericBase: candidate,
            };
        }
    } catch (_) {
        // no-op: fall through to docker logs probing
    }

    // Fallback: probe tunnel container logs (works on host bridge execution path).
    const logs = execDocker(['logs', '--tail', '200', 'moltbot-dev-tunnel']);
    if (!logs.ok) return { promptBase: null, genericBase: null };
    const m = String(`${logs.stdout}\n${logs.stderr}`).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    if (!m || !m.length) return { promptBase: null, genericBase: null };
    const base = m[m.length - 1];
    return {
        promptBase: base,
        genericBase: base,
    };
}

function buildExternalLinksText() {
    const { promptBase } = getPublicBases();
    if (!promptBase) return null;
    const lines = ['외부 확인 링크'];
    if (promptBase) lines.push(`- 프롬프트: ${promptBase}/prompt/`);
    return lines.join('\n');
}

function rewriteLocalLinks(text, bases) {
    const raw = String(text || '');
    const promptBase = String((bases && bases.promptBase) || '').trim().replace(/\/+$/, '');
    if (!promptBase) return raw;

    let out = raw;
    if (promptBase) {
        out = out
            .replace(/https?:\/\/127\.0\.0\.1:18788\/prompt\/?/gi, `${promptBase}/prompt/`)
            .replace(/https?:\/\/localhost:18788\/prompt\/?/gi, `${promptBase}/prompt/`)
            .replace(/https?:\/\/127\.0\.0\.1:18787\/prompt\/?/gi, `${promptBase}/prompt/`)
            .replace(/https?:\/\/localhost:18787\/prompt\/?/gi, `${promptBase}/prompt/`);
    }
    return out;
}

function appendExternalLinks(reply) {
    const bases = getPublicBases();
    const rewritten = rewriteLocalLinks(reply, bases);
    const links = buildExternalLinksText();
    if (!links) return rewritten;
    return `${String(rewritten || '').trim()}\n\n${links}`.trim();
}

function isExternalLinkRequest(text) {
    const t = String(text || '').toLowerCase();
    const hasLink = /(링크|url|주소|접속)/i.test(t);
    const hasTarget = /(프롬프트|prompt|웹앱|webapp|web)/i.test(t);
    return hasLink && hasTarget;
}

function buildLinkOnlyReply(text) {
    const t = String(text || '').toLowerCase();
    const { promptBase } = getPublicBases();
    if (!promptBase) {
        return '외부 링크를 찾을 수 없습니다. 터널 상태를 먼저 점검해주세요.';
    }
    if (/(프롬프트|prompt)/i.test(t)) {
        const baseReply = promptBase
            ? `외부 확인 링크\n- 프롬프트: ${promptBase}/prompt/`
            : '프롬프트 외부 링크를 찾을 수 없습니다.';
        const diag = /(점검|체크|status|확인)/i.test(t) ? buildLinkDiagnosticsText() : '';
        return diag ? `${baseReply}\n\n${diag}` : baseReply;
    }
    const lines = ['외부 확인 링크'];
    if (promptBase) lines.push(`- 프롬프트: ${promptBase}/prompt/`);
    const out = lines.join('\n');
    const diag = /(점검|체크|status|확인)/i.test(t) ? buildLinkDiagnosticsText() : '';
    return diag ? `${out}\n\n${diag}` : out;
}

function probeUrlStatus(url) {
    const target = String(url || '').trim();
    if (!target) return { ok: false, code: 'N/A', reason: 'empty' };
    const r = spawnSync('curl', ['-sS', '-L', '--max-time', '6', '-o', '/dev/null', '-w', '%{http_code}', target], { encoding: 'utf8' });
    if (r.error) return { ok: false, code: 'N/A', reason: 'curl-missing' };
    const code = String(r.stdout || '').trim() || '000';
    if (r.status !== 0 || code === '000') {
        return { ok: false, code, reason: (r.stderr || '').trim() || `exit:${r.status}` };
    }
    return { ok: true, code, reason: '' };
}

function buildLinkDiagnosticsText() {
    const scriptPath = path.join(__dirname, 'tunnel_dns_check.js');
    const scriptRun = spawnSync('node', [scriptPath, '--json'], { encoding: 'utf8' });
    if (!scriptRun.error && scriptRun.status === 0) {
        try {
            const parsed = JSON.parse(String(scriptRun.stdout || '{}'));
            if (parsed && Array.isArray(parsed.targets) && parsed.targets.length > 0) {
                const lines = ['외부 링크 점검'];
                for (const row of parsed.targets) {
                    const dnsPart = row?.dns?.ok
                        ? `DNS OK(${row.dns.address || '-'})`
                        : `DNS FAIL(${row?.dns?.error || 'unknown'})`;
                    const httpsPart = row?.https?.ok
                        ? `HTTPS ${row.https.statusCode || 0}`
                        : `HTTPS FAIL(${row?.https?.error || 'unknown'})`;
                    lines.push(`- ${row.label || row.key || 'link'}: ${dnsPart}, ${httpsPart}`);
                }
                return lines.join('\n');
            }
        } catch (_) {
            // fall through to curl-based fallback.
        }
    }

    const { promptBase } = getPublicBases();
    const checks = [];
    if (promptBase) checks.push({ label: '프롬프트', url: `${promptBase}/prompt/` });
    if (!checks.length) return '';
    const lines = ['외부 링크 점검'];
    for (const c of checks) {
        const p = probeUrlStatus(c.url);
        const msg = p.ok ? `${p.code} OK` : `${p.code} FAIL${p.reason ? ` (${p.reason})` : ''}`;
        lines.push(`- ${c.label}: ${msg}`);
    }
    return lines.join('\n');
}

function buildQuickStatusReply(payload) {
    const raw = String(payload || '').trim();
    const target = raw ? raw : 'all';
    const out = runOpsCommand(`액션: 상태; 대상: ${target}`);
    const base = out && out.telegramReply ? out.telegramReply : '상태 조회 실패';
    const diag = buildLinkDiagnosticsText();
    const merged = diag ? `${base}\n\n${diag}` : base;
    return appendExternalLinks(merged);
}

function normalizeTemplateKey(route, rawKey) {
    const schema = COMMAND_TEMPLATE_SCHEMA[route];
    if (!schema) return null;
    const key = String(rawKey || '').replace(/\s+/g, '').toLowerCase();
    for (const [canonical, aliases] of Object.entries(schema.aliases || {})) {
        if (aliases.some(alias => key === String(alias).replace(/\s+/g, '').toLowerCase())) {
            return canonical;
        }
    }
    return null;
}

function parseTemplateFields(route, payloadText) {
    const fields = {};
    const tokens = String(payloadText || '')
        .split(/\n|;/)
        .map(s => s.trim())
        .filter(Boolean);
    for (const token of tokens) {
        const m = token.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
        if (!m) continue;
        const canonical = normalizeTemplateKey(route, m[1]);
        if (!canonical) continue;
        const value = String(m[2] || '').trim();
        if (!value) continue;
        fields[canonical] = value;
    }
    return fields;
}

function buildTemplateGuide(route) {
    const schema = COMMAND_TEMPLATE_SCHEMA[route];
    if (!schema) return '지원하지 않는 템플릿입니다.';
    const prefix = route === 'work'
        ? '작업'
        : route === 'inspect'
            ? '점검'
            : route === 'deploy'
                ? '배포'
                : route === 'ops'
                    ? '운영'
                    : route;
    const required = schema.required.map(k => `${k}: ...`).join('\n');
    const optional = schema.optional.map(k => `${k}: ...`).join('\n');
    return [
        `[${schema.displayName} 템플릿]`,
        required,
        optional ? '\n(선택)\n' + optional : '',
        '\n예시:',
        `${prefix}: ${schema.required.map((k) => `${k}: ...`).join('; ')}`,
    ].join('\n');
}

function buildNoPrefixGuide() {
    return [
        '명령 프리픽스를 붙여주세요.',
        '',
        '자주 쓰는 형식:',
        '- 링크: 프롬프트',
        '- 상태: [옵션]',
        '- 단어: 단어1',
        '- 작업: 요청: ...; 대상: ...; 완료기준: ...',
        '- 점검: 대상: ...; 체크항목: ...',
        '- 배포: 대상: ...; 환경: ...; 검증: ...',
    ].join('\n');
}

function parseStructuredCommand(route, payloadText) {
    const schema = COMMAND_TEMPLATE_SCHEMA[route];
    if (!schema) return { ok: false, error: 'unknown template route' };

    const payload = String(payloadText || '').trim();
    if (!payload || /^(도움말|help|템플릿)$/i.test(payload)) {
        return {
            ok: false,
            missing: schema.required,
            telegramReply: buildTemplateGuide(route),
        };
    }

    const fields = parseTemplateFields(route, payload);
    const missing = schema.required.filter(key => !fields[key]);
    if (missing.length > 0) {
        return {
            ok: false,
            missing,
            telegramReply: [
                `${schema.displayName} 템플릿 누락: ${missing.join(', ')}`,
                buildTemplateGuide(route),
            ].join('\n\n'),
        };
    }

    const ordered = [...schema.required, ...schema.optional]
        .filter(key => fields[key])
        .map(key => `${key}: ${fields[key]}`)
        .join('\n');
    const needsApproval = route === 'deploy';
    return {
        ok: true,
        fields,
        normalizedInstruction: ordered,
        telegramReply: `${schema.displayName} 템플릿 확인 완료`,
        needsApproval,
    };
}

function routeByPrefix(text) {
    const input = String(text || '').trim();
    const prefixes = config.commandPrefixes || {};
    const list = (v) => Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
    const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchPrefix = (rawInput, rawPrefix) => {
        const p = String(rawPrefix || '').trim();
        if (!p) return null;
        // Support variants like "링크: ...", "링크 : ...", "링크：...", and optionally no-colon form.
        const colonMatch = p.match(/^(.*?)[：:]$/);
        if (colonMatch) {
            const stem = colonMatch[1].trim();
            if (!stem) return null;
            const re = new RegExp(`^\\s*${escapeRegExp(stem)}\\s*(?:[:：])?\\s*`, 'i');
            const m = rawInput.match(re);
            return m ? m[0].length : null;
        }
        const re = new RegExp(`^\\s*${escapeRegExp(p)}\\s+`, 'i');
        const m = rawInput.match(re);
        return m ? m[0].length : null;
    };

    const routingRules = [
        { route: 'word', prefixes: list(prefixes.word || '단어:').concat(list(prefixes.learn || '학습:')) },
        { route: 'news', prefixes: list(prefixes.news || '소식:') },
        { route: 'report', prefixes: list(prefixes.report || '리포트:').concat(list(prefixes.summary || '요약:')) },
        { route: 'work', prefixes: list(prefixes.work || '작업:').concat(list(prefixes.do || '실행:')) },
        { route: 'inspect', prefixes: list(prefixes.inspect || '점검:').concat(list(prefixes.check || '검토:')) },
        { route: 'deploy', prefixes: list(prefixes.deploy || '배포:').concat(list(prefixes.ship || '출시:')) },
        { route: 'prompt', prefixes: list(prefixes.prompt || '프롬프트:').concat(list(prefixes.ask || '질문:')) },
        { route: 'link', prefixes: list(prefixes.link || '링크:') },
        { route: 'status', prefixes: list(prefixes.status || '상태:') },
        { route: 'ops', prefixes: list(prefixes.ops || '운영:') },
    ];

    for (const rule of routingRules) {
        for (const prefix of rule.prefixes) {
            const offset = matchPrefix(input, prefix);
            if (offset != null) {
                return { route: rule.route, payload: input.slice(offset).trim() };
            }
        }
    }
    return { route: 'none', payload: input }; // no prefix fallback
}

function handlePromptPayload(payloadText) {
    const payload = String(payloadText || '').trim();
    // mode 1) "답변 sessionId | field:value ..."
    if (payload.startsWith('답변')) {
        const body = payload.replace(/^답변\s*/, '');
        const [sessionIdRaw, patchRaw = ''] = body.split('|');
        const sessionId = String(sessionIdRaw || '').trim();
        if (!sessionId) {
            return { error: 'sessionId가 필요합니다. 예: 프롬프트: 답변 pf_xxx | 출력형식: 표' };
        }
        const patch = {};
        for (const token of patchRaw.split(/[;\n]/).map(x => x.trim()).filter(Boolean)) {
            const parts = token.split(/[:：]/);
            if (parts.length < 2) continue;
            const keyRaw = parts[0].toLowerCase();
            const value = parts.slice(1).join(':').trim();
            if (!value) continue;
            if (/(목적|goal|요청)/.test(keyRaw)) patch.goal = value;
            else if (/(제약|constraint|조건)/.test(keyRaw)) patch.constraints = value;
            else if (/(출력|format|형식)/.test(keyRaw)) patch.outputFormat = value;
            else if (/(금지|forbidden)/.test(keyRaw)) patch.forbidden = value;
            else if (/(성공|criteria|완료)/.test(keyRaw)) patch.successCriteria = value;
        }
        const updated = promptBuilder.updateSession(sessionId, patch);
        return {
            mode: 'update',
            sessionId,
            domain: updated.domain || 'general',
            completeness: updated.completeness,
            missingQuestions: updated.missingQuestions,
        };
    }

    // mode 2) "완성 sessionId"
    if (payload.startsWith('완성') || payload.startsWith('최종')) {
        const sessionId = payload.replace(/^(완성|최종)\s*/, '').trim();
        if (!sessionId) {
            return { error: 'sessionId가 필요합니다. 예: 프롬프트: 완성 pf_xxx' };
        }
        const result = promptBuilder.finalizeSession(sessionId);
        return { mode: 'finalize', ...result };
    }

    // mode 3) start with free text
    const fields = promptBuilder.parseFreeTextToFields(payload);
    const session = promptBuilder.createSession(fields);
    return {
        mode: 'start',
        sessionId: session.id,
        domain: session.domain || 'general',
        completeness: session.completeness,
        missingQuestions: session.missingQuestions,
        usage: [
            `프롬프트: 답변 ${session.id} | 제약: ...; 출력형식: ...`,
            `프롬프트: 완성 ${session.id}`,
        ],
    };
}

function isWeakEnrichment(word, hint, enriched) {
    const hasHint = Boolean(String(hint || '').trim());
    if (hasHint) return false;
    const meaning = String((enriched && enriched.meaning) || '').trim();
    const example = String((enriched && enriched.example) || '').trim();
    return meaning === '(의미 보강 필요)' && example === fallbackExample(word);
}

async function processWordTokens(text, toeicDeck, toeicTags, options = {}) {
    const enrichFn = options.enrichFn || enrichToeicWord;
    const addCardFn = options.addCardFn || ((deck, front, back, tags, addOpts) => anki.addCard(deck, front, back, tags, addOpts));
    const syncFn = options.syncFn || (() => anki.syncWithDelay());
    const tokens = splitWords(text);
    const results = [];
    const failures = [];

    for (const token of tokens) {
        try {
            const parsed = parseWordToken(token);
            if (!parsed) {
                failures.push({ token, reason: 'parse_failed' });
                continue;
            }
            const word = parsed.word;
            const hint = parsed.hint;
            const enriched = await enrichFn(word, hint);
            if (isWeakEnrichment(word, hint, enriched)) {
                failures.push({ token, reason: 'no_definition_found' });
                continue;
            }
            const answer = buildToeicAnswerRich(
                word,
                enriched.meaning,
                enriched.example,
                enriched.partOfSpeech || '',
            );
            const noteId = await addCardFn(toeicDeck, word, answer, toeicTags, { sync: false });
            results.push({ word, noteId, deck: toeicDeck });
        } catch (e) {
            failures.push({ token, reason: e.message });
        }
    }
    if (results.length > 0) {
        try {
            await syncFn();
        } catch (e) {
            console.log('Anki batch sync failed (non-critical):', e.message);
            failures.push({ token: '__sync__', reason: `sync_failed: ${e.message}` });
        }
    }
    const summary = `Anki 저장 결과: 성공 ${results.length}건 / 실패 ${failures.length}건`;
    const telegramReply = failures.length > 0
        ? `${summary}\n실패 목록:\n- ${failures.map(f => `${f.token}: ${f.reason}`).join('\n- ')}`
        : `${summary}\n실패 목록: 없음`;
    return {
        success: failures.length === 0,
        saved: results.length,
        failed: failures.length,
        summary,
        telegramReply,
        failedTokens: failures.map(f => `${f.token}: ${f.reason}`),
        results,
        failures,
    };
}

async function main() {
    const [, , command, ...args] = process.argv;
    const fullText = args.join(' ');
    const toeicDeck = config.ankiPolicy?.toeicDeck || 'TOEIC_AI';
    const toeicTags = Array.isArray(config.ankiPolicy?.autoTags) ? config.ankiPolicy.autoTags : ['moltbot', 'toeic_ai'];

    try {
        switch (command) {
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

            case 'work': {
                // usage: node bridge.js work "요청: ...; 대상: ...; 완료기준: ..."
                const parsed = parseStructuredCommand('work', fullText);
                const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                console.log(JSON.stringify({
                    route: 'work',
                    templateValid: parsed.ok,
                    ...parsed,
                    telegramReply,
                    preferredModelAlias: 'codex',
                    preferredReasoning: 'high',
                    routeHint: 'complex-workload',
                }));
                break;
            }

            case 'inspect': {
                // usage: node bridge.js inspect "대상: ...; 체크항목: ..."
                const parsed = parseStructuredCommand('inspect', fullText);
                const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                console.log(JSON.stringify({
                    route: 'inspect',
                    templateValid: parsed.ok,
                    ...parsed,
                    telegramReply,
                    preferredModelAlias: 'codex',
                    preferredReasoning: 'medium',
                    routeHint: 'inspection',
                }));
                break;
            }

            case 'deploy': {
                // usage: node bridge.js deploy "대상: ...; 환경: ...; 검증: ..."
                const parsed = parseStructuredCommand('deploy', fullText);
                const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                console.log(JSON.stringify({
                    route: 'deploy',
                    templateValid: parsed.ok,
                    ...parsed,
                    telegramReply,
                    preferredModelAlias: 'codex',
                    preferredReasoning: 'high',
                    routeHint: 'deployment',
                }));
                break;
            }

            case 'ops': {
                const out = runOpsCommand(fullText);
                if (out && out.telegramReply) {
                    out.telegramReply = appendExternalLinks(out.telegramReply);
                }
                console.log(JSON.stringify(out));
                break;
            }

            case 'word': {
                // usage: node bridge.js word "Activated 활성화된, Formulate"
                const wordResult = await processWordTokens(fullText, toeicDeck, toeicTags);
                console.log(JSON.stringify({
                    ...wordResult,
                    preferredModelAlias: 'fast',
                    preferredReasoning: 'low',
                }));
                break;
            }

            case 'news': {
                // usage: node bridge.js news "상태|지금요약|키워드 추가 ..."
                const newsDigest = require('./news_digest');
                const payload = [args[0], ...args.slice(1)].join(' ').trim() || fullText;
                const result = await newsDigest.handleNewsCommand(payload);
                console.log(JSON.stringify({
                    route: 'news',
                    preferredModelAlias: 'fast',
                    preferredReasoning: 'low',
                    ...result,
                }));
                break;
            }

            case 'prompt': {
                // usage:
                // node bridge.js prompt "목적: ..."
                // node bridge.js prompt "답변 pf_xxx | 출력형식: 표"
                // node bridge.js prompt "완성 pf_xxx"
                const out = handlePromptPayload(fullText);
                if (out && out.telegramReply) {
                    out.telegramReply = appendExternalLinks(out.telegramReply);
                }
                console.log(JSON.stringify(out));
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
                // usage: node bridge.js auto "단어: activate 활성화하다"
                const routed = routeByPrefix(fullText);
                if (routed.route === 'word') {
                    const wordResult = await processWordTokens(routed.payload, toeicDeck, toeicTags);
                    console.log(JSON.stringify({
                        route: routed.route,
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                        ...wordResult,
                    }));
                    break;
                }
                if (routed.route === 'news') {
                    const newsDigest = require('./news_digest');
                    const result = await newsDigest.handleNewsCommand(routed.payload);
                    console.log(JSON.stringify({
                        route: routed.route,
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                        ...result,
                    }));
                    break;
                }
                if (routed.route === 'report') {
                    const payload = routed.payload.toLowerCase();
                    if (payload.includes('블로그')) {
                        const blog = require('./blog_publish_from_reports');
                        const res = await blog.publishFromReports();
                        console.log(JSON.stringify({
                            route: 'report',
                            action: 'blog-publish',
                            ...res,
                            telegramReply: appendExternalLinks('리포트 완료'),
                            preferredModelAlias: 'fast',
                            preferredReasoning: 'low',
                        }));
                        break;
                    }
                    if (payload.includes('주간')) {
                        const weekly = require('./weekly_report');
                        const res = await weekly.buildWeeklyReport();
                        console.log(JSON.stringify({
                            route: 'report',
                            action: 'weekly',
                            ...res,
                            telegramReply: appendExternalLinks('리포트 완료'),
                            preferredModelAlias: 'fast',
                            preferredReasoning: 'low',
                        }));
                        break;
                    }
                    const daily = require('./daily_summary');
                    const res = await daily.buildDailySummary();
                    console.log(JSON.stringify({
                        route: 'report',
                        action: 'daily',
                        ...res,
                        telegramReply: appendExternalLinks('리포트 완료'),
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                    }));
                    break;
                }
                if (routed.route === 'work') {
                    const parsed = parseStructuredCommand('work', routed.payload);
                    const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                    console.log(JSON.stringify({
                        route: routed.route,
                        templateValid: parsed.ok,
                        ...parsed,
                        telegramReply,
                        preferredModelAlias: 'codex',
                        preferredReasoning: 'high',
                        routeHint: 'complex-workload',
                    }));
                    break;
                }
                if (routed.route === 'inspect') {
                    const parsed = parseStructuredCommand('inspect', routed.payload);
                    const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                    console.log(JSON.stringify({
                        route: routed.route,
                        templateValid: parsed.ok,
                        ...parsed,
                        telegramReply,
                        preferredModelAlias: 'codex',
                        preferredReasoning: 'medium',
                        routeHint: 'inspection',
                    }));
                    break;
                }
                if (routed.route === 'deploy') {
                    const parsed = parseStructuredCommand('deploy', routed.payload);
                    const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                    console.log(JSON.stringify({
                        route: routed.route,
                        templateValid: parsed.ok,
                        ...parsed,
                        telegramReply,
                        preferredModelAlias: 'codex',
                        preferredReasoning: 'high',
                        routeHint: 'deployment',
                    }));
                    break;
                }
                if (routed.route === 'prompt') {
                    const out = handlePromptPayload(routed.payload);
                    if (out && out.telegramReply) {
                        out.telegramReply = appendExternalLinks(out.telegramReply);
                    }
                    console.log(JSON.stringify({ route: 'prompt', ...out }));
                    break;
                }
                if (routed.route === 'link') {
                    const reply = buildLinkOnlyReply(routed.payload || '링크');
                    console.log(JSON.stringify({
                        route: 'link',
                        success: true,
                        telegramReply: reply,
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                    }));
                    break;
                }
                if (routed.route === 'status') {
                    console.log(JSON.stringify({
                        route: 'status',
                        success: true,
                        telegramReply: buildQuickStatusReply(routed.payload),
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                    }));
                    break;
                }
                if (routed.route === 'ops') {
                    const out = runOpsCommand(routed.payload);
                    if (out && out.telegramReply) {
                        out.telegramReply = appendExternalLinks(out.telegramReply);
                    }
                    console.log(JSON.stringify(out));
                    break;
                }
                if (routed.route === 'none') {
                    console.log(JSON.stringify({
                        route: 'none',
                        skipped: fullText,
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                        telegramReply: appendExternalLinks(buildNoPrefixGuide()),
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

if (require.main === module) {
    main();
}

module.exports = {
    parseWordToken,
    enrichToeicWord,
    processWordTokens,
    buildToeicAnswerRich,
    fallbackExample,
    buildWordCandidates,
    isWeakEnrichment,
};
