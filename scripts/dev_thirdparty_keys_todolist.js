#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, loadRuntimeEnv } = require('./env_runtime');
const botManager = require('./capabilities/bot_manager');

const TODO_CONFIG_PATH = path.join(ROOT, 'data', 'dev_thirdparty_keys_todolist.json');
const DEV_REPO_CONFIG_PATH = path.join(ROOT, 'configs', 'dev', 'openclaw.json');
const DEV_CONTAINER = 'moltbot-dev';
const DEV_RUNTIME_CONFIG_PATH = '/home/node/.openclaw/openclaw.json';

function readJson(filePath, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function runDocker(args) {
    const res = spawnSync('docker', args, { encoding: 'utf8' });
    return {
        ok: !res.error && res.status === 0,
        code: res.status == null ? 1 : res.status,
        stdout: String(res.stdout || '').trim(),
        stderr: String(res.stderr || '').trim(),
        error: res.error ? String(res.error.message || res.error) : '',
    };
}

function isSecretConfigured(raw) {
    const text = String(raw || '').trim();
    if (!text) return false;
    const placeholderPatterns = [
        /^\[REDACTED/i,
        /^<[^>]+>$/,
        /^your[-_ ]/i,
        /^changeme$/i,
        /^replace[-_ ]?/i,
        /^example/i,
        /^\$\{[^}]+\}$/,
    ];
    return !placeholderPatterns.some((pattern) => pattern.test(text));
}

function parseFrontmatter(raw) {
    const text = String(raw || '');
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { name: null, metadata: null };
    const block = match[1];
    const nameMatch = block.match(/^name:\s*(.+)$/m);
    const metadataMatch = block.match(/^metadata:\s*(.+)$/m);

    let metadata = null;
    if (metadataMatch) {
        try {
            metadata = JSON.parse(metadataMatch[1].trim());
        } catch (_) {
            metadata = null;
        }
    }

    return {
        name: nameMatch ? String(nameMatch[1]).trim() : null,
        metadata,
    };
}

function collectSkillRequiredEnv() {
    const byEnv = new Map();
    const skillsDir = path.join(ROOT, 'skills');
    if (!fs.existsSync(skillsDir)) return byEnv;

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const raw = fs.readFileSync(skillFile, 'utf8');
        const parsed = parseFrontmatter(raw);
        const skillName = parsed.name || entry.name;
        const envList = (((parsed.metadata || {}).openclaw || {}).requires || {}).env;
        if (!Array.isArray(envList)) continue;

        for (const envName of envList) {
            const key = String(envName || '').trim();
            if (!key) continue;
            const current = byEnv.get(key) || new Set();
            current.add(`skill:${skillName}`);
            byEnv.set(key, current);
        }
    }

    return byEnv;
}

function collectDevConfigEnv() {
    const byEnv = new Map();
    const cfg = readJson(DEV_REPO_CONFIG_PATH, {});
    const entries = cfg && cfg.skills && cfg.skills.entries && typeof cfg.skills.entries === 'object'
        ? cfg.skills.entries
        : {};

    for (const [skillName, skillConfig] of Object.entries(entries)) {
        const envObj = skillConfig && skillConfig.env && typeof skillConfig.env === 'object'
            ? skillConfig.env
            : null;
        if (!envObj) continue;
        for (const envName of Object.keys(envObj)) {
            const key = String(envName || '').trim();
            if (!key) continue;
            const current = byEnv.get(key) || new Set();
            current.add(`config:${skillName}`);
            byEnv.set(key, current);
        }
    }

    return byEnv;
}

function collectDevRuntimeSkillEnvValues() {
    const values = new Map();
    const running = runDocker(['inspect', '-f', '{{.State.Running}}', DEV_CONTAINER]);
    if (!running.ok || running.stdout !== 'true') {
        return values;
    }

    const output = runDocker(['exec', DEV_CONTAINER, 'sh', '-lc', `cat ${DEV_RUNTIME_CONFIG_PATH}`]);
    if (!output.ok) return values;

    const cfg = readJsonFromText(output.stdout);
    const entries = cfg && cfg.skills && cfg.skills.entries && typeof cfg.skills.entries === 'object'
        ? cfg.skills.entries
        : {};
    for (const skillConfig of Object.values(entries)) {
        const envObj = skillConfig && skillConfig.env && typeof skillConfig.env === 'object'
            ? skillConfig.env
            : null;
        if (!envObj) continue;
        for (const [key, value] of Object.entries(envObj)) {
            const envName = String(key || '').trim();
            if (!envName) continue;
            values.set(envName, String(value || '').trim());
        }
    }
    return values;
}

function readJsonFromText(text) {
    try {
        return JSON.parse(String(text || '').trim() || '{}');
    } catch (_) {
        return {};
    }
}

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

function mergeChecklistItems(baseItems, discoveredByEnv) {
    const merged = [];
    const seen = new Set();

    for (const item of baseItems) {
        const envName = String(item && item.env || '').trim();
        if (!envName) continue;
        merged.push({
            env: envName,
            alias_envs: toArray(item.alias_envs).map((v) => String(v || '').trim()).filter(Boolean),
            service: String(item.service || '').trim() || envName,
            task: String(item.task || '').trim() || `${envName} 등록`,
            docs: String(item.docs || '').trim(),
            priority: Number(item.priority || 50),
            note: String(item.note || '').trim(),
            sourceHints: Array.from(discoveredByEnv.get(envName) || []),
        });
        seen.add(envName);
    }

    const extraEnv = Array.from(discoveredByEnv.keys())
        .filter((key) => !seen.has(key))
        .sort((a, b) => a.localeCompare(b));

    for (const envName of extraEnv) {
        merged.push({
            env: envName,
            alias_envs: [],
            service: envName,
            task: `${envName} 등록`,
            docs: '',
            priority: 90,
            note: '자동 발견된 요구 키',
            sourceHints: Array.from(discoveredByEnv.get(envName) || []),
        });
    }

    return merged.sort((a, b) => {
        const p = Number(a.priority || 50) - Number(b.priority || 50);
        if (p !== 0) return p;
        return a.env.localeCompare(b.env);
    });
}

function resolveItemStatus(item, runtimeSkillEnvValues) {
    const candidates = [item.env, ...toArray(item.alias_envs)];
    for (const key of candidates) {
        const envValue = process.env[key];
        if (isSecretConfigured(envValue)) {
            return { configured: true, via: `env:${key}` };
        }
    }

    for (const key of candidates) {
        const runtimeValue = runtimeSkillEnvValues.get(key);
        if (isSecretConfigured(runtimeValue)) {
            return { configured: true, via: `runtime-config:${key}` };
        }
    }

    return { configured: false, via: null };
}

function buildReportRows(items, runtimeSkillEnvValues) {
    return items.map((item) => {
        const status = resolveItemStatus(item, runtimeSkillEnvValues);
        return {
            ...item,
            configured: status.configured,
            resolvedVia: status.via,
        };
    });
}

function nowDateInTimezone(timezone) {
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone || 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

function shortenList(values, max = 8) {
    if (values.length <= max) return values.join(', ');
    const rest = values.length - max;
    return `${values.slice(0, max).join(', ')} +${rest}`;
}

function renderMessage(meta, rows) {
    const timezone = String(meta.timezone || 'Asia/Tokyo').trim();
    const date = nowDateInTimezone(timezone);
    const title = String(meta.title || '(dev) Third-party Keys TODO').trim();
    const pending = rows.filter((row) => !row.configured);
    const done = rows.filter((row) => row.configured);

    const lines = [];
    lines.push(`🧩 ${title} (${date})`);
    lines.push(`- 미완료 ${pending.length}개 / 완료 ${done.length}개`);
    if (meta.summary_note) {
        lines.push(`- ${String(meta.summary_note).trim()}`);
    }

    if (pending.length === 0) {
        lines.push('');
        lines.push('✅ 현재 등록이 필요한 외부 키가 없습니다.');
    } else {
        lines.push('');
        lines.push('미완료 TODO');
        pending.forEach((row, idx) => {
            lines.push(`${idx + 1}. ${row.task}`);
            lines.push(`   env: ${row.env}`);
            if (row.docs) {
                lines.push(`   docs: ${row.docs}`);
            }
            if (row.note) {
                lines.push(`   note: ${row.note}`);
            }
        });
    }

    if (done.length > 0) {
        const doneEnv = done.map((row) => row.env);
        lines.push('');
        lines.push(`완료 키: ${shortenList(doneEnv)}`);
    }

    return {
        text: lines.join('\n'),
        pendingCount: pending.length,
        doneCount: done.length,
        pendingEnv: pending.map((row) => row.env),
        doneEnv: done.map((row) => row.env),
    };
}

function dispatchToDevBot(message) {
    const planned = botManager.plan({
        action: 'dispatch',
        payload: {
            target_profile: 'dev',
            route: 'none',
            original_message: `[NOTIFY] ${message}`,
        },
    });
    if (!planned.ok || !planned.plan) {
        throw new Error(planned.error || 'dispatch plan failed');
    }

    const executed = botManager.execute({
        action: 'dispatch',
        plan: planned.plan,
    });

    if (!executed.ok) {
        throw new Error(executed.error || 'dispatch execute failed');
    }

    return {
        planned: planned.plan.plan_summary || null,
        target: executed.target_profile || executed.target_container || 'dev',
        telegramReply: executed.telegramReply || null,
    };
}

async function run(options = {}) {
    loadRuntimeEnv({
        allowLegacyFallback: true,
        warnOnLegacyFallback: false,
        required: false,
        override: false,
        silent: true,
    });

    const config = readJson(TODO_CONFIG_PATH, null);
    if (!config || !Array.isArray(config.items)) {
        throw new Error(`invalid todo config: ${TODO_CONFIG_PATH}`);
    }

    const requiredByEnv = collectSkillRequiredEnv();
    const requiredByDevConfig = collectDevConfigEnv();
    for (const [key, sourceSet] of requiredByDevConfig.entries()) {
        const merged = requiredByEnv.get(key) || new Set();
        for (const source of sourceSet) {
            merged.add(source);
        }
        requiredByEnv.set(key, merged);
    }

    const mergedItems = mergeChecklistItems(config.items, requiredByEnv);
    const runtimeSkillEnvValues = collectDevRuntimeSkillEnvValues();
    const rows = buildReportRows(mergedItems, runtimeSkillEnvValues);
    const rendered = renderMessage(config, rows);

    let dispatch = null;
    if (options.dispatch !== false) {
        dispatch = dispatchToDevBot(rendered.text);
    }

    return {
        ok: true,
        dispatched: Boolean(dispatch),
        dispatch,
        configPath: TODO_CONFIG_PATH,
        pendingCount: rendered.pendingCount,
        doneCount: rendered.doneCount,
        pendingEnv: rendered.pendingEnv,
        doneEnv: rendered.doneEnv,
        message: rendered.text,
        rows,
    };
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const noDispatch = args.has('--no-dispatch');
    const result = await run({ dispatch: !noDispatch });
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = {
    run,
};
