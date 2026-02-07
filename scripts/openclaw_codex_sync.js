const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG_PATH = path.join(__dirname, '../configs/main/openclaw.json');

const PREFERRED = [
    'openai-codex/gpt-5.3-codex',
    'openai-codex/gpt-5.2-codex',
    'openai-codex/gpt-5.2',
    'openai-codex/gpt-5.1-codex-max',
    'openai-codex/gpt-5.1',
];

function listAvailableCodexModels() {
    const out = execSync(
        'docker exec moltbot-main /bin/sh -lc "node dist/index.js models list --all --provider openai-codex --plain"',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return out
        .split('\n')
        .map(v => v.trim())
        .filter(Boolean);
}

function selectBest(available) {
    for (const model of PREFERRED) {
        if (available.includes(model)) return model;
    }
    return null;
}

function syncConfig(bestModel) {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error(`Config not found: ${CONFIG_PATH}`);
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);

    const defaults = (((cfg || {}).agents || {}).defaults || {});
    const model = defaults.model || {};
    const models = defaults.models || {};

    const prevFallbacks = Array.isArray(model.fallbacks) ? model.fallbacks : [];
    const cleanedFallbacks = prevFallbacks.filter(v => !String(v).startsWith('openai-codex/'));
    const nextFallbacks = [...cleanedFallbacks, bestModel];
    model.fallbacks = [...new Set(nextFallbacks)];

    for (const key of Object.keys(models)) {
        if (models[key] && models[key].alias === 'codex' && key !== bestModel) {
            delete models[key].alias;
        }
    }
    models[bestModel] = { ...(models[bestModel] || {}), alias: 'codex' };

    defaults.model = model;
    defaults.models = models;
    cfg.agents.defaults = defaults;

    const nextRaw = JSON.stringify(cfg, null, 2);
    const changed = nextRaw !== raw;
    if (changed) fs.writeFileSync(CONFIG_PATH, nextRaw, 'utf8');

    return { changed, fallbacks: model.fallbacks, codexAlias: bestModel };
}

function maybeRestart(changed, args) {
    if (!changed) return false;
    if (!args.includes('--restart')) return false;
    execSync('docker compose up -d --force-recreate openclaw-main', {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit',
    });
    return true;
}

function main() {
    const args = process.argv.slice(2);
    const available = listAvailableCodexModels();
    const bestModel = selectBest(available);
    if (!bestModel) {
        console.log(
            JSON.stringify(
                {
                    ok: false,
                    reason: 'no_openai_codex_model_found',
                    available,
                },
                null,
                2,
            ),
        );
        process.exit(1);
    }

    const sync = syncConfig(bestModel);
    const restarted = maybeRestart(sync.changed, args);

    console.log(
        JSON.stringify(
            {
                ok: true,
                bestModel,
                available,
                changed: sync.changed,
                restarted,
                fallbacks: sync.fallbacks,
            },
            null,
            2,
        ),
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

module.exports = { listAvailableCodexModels, selectBest, syncConfig };
