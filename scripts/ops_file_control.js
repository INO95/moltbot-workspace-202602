const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME_DIR = os.homedir();
const ICLOUD_PATH = path.join(HOME_DIR, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');

const DEFAULT_POLICY = Object.freeze({
    enabled: true,
    allowedRoots: [
        HOME_DIR,
        '/Volumes',
    ],
    mediumRoots: [
        path.join(HOME_DIR, 'Downloads'),
        path.join(HOME_DIR, 'Desktop'),
    ],
    highRoots: [
        path.join(HOME_DIR, 'Documents'),
        ICLOUD_PATH,
    ],
    externalRoot: '/Volumes',
    gitAllowedRoots: [
        path.join(HOME_DIR, 'Projects'),
    ],
    trashRoot: path.join(HOME_DIR, '.assistant_trash'),
    hashMaxBytes: 32 * 1024 * 1024,
    minFreeBytes: 1 * 1024 * 1024 * 1024,
    ttlPolicy: {
        defaultTtlSeconds: 180,
        minTtlSeconds: 120,
        maxTtlSeconds: 300,
    },
    approvalGrantPolicy: {
        enabled: false,
        grant_on_approval: true,
        scope: 'all',
        defaultTtlSeconds: 1800,
        minTtlSeconds: 300,
        maxTtlSeconds: 7200,
    },
    telegramGuard: {
        enabled: true,
        requireContext: true,
        allowedUserIds: ['7704103236'],
        allowedGroupIds: [],
    },
    actionRiskPolicy: {
        file: {
            git_push: {
                risk_tier: 'GIT_AWARE',
                requires_approval: true,
                required_flags: ['force', 'push'],
            },
            trash: {
                risk_tier: 'HIGH',
                requires_approval: true,
                required_flags: ['force'],
            },
            rename: {
                risk_tier: 'HIGH',
                requires_approval: true,
                required_flags: ['force'],
            },
        },
        capability: {
            'mail:send': {
                risk_tier: 'HIGH',
                requires_approval: true,
                required_flags: ['force'],
            },
            'photo:cleanup': {
                risk_tier: 'HIGH',
                requires_approval: true,
                required_flags: ['force'],
            },
            'schedule:delete': {
                risk_tier: 'HIGH',
                requires_approval: true,
                required_flags: ['force'],
            },
            'browser:checkout': {
                risk_tier: 'HIGH',
                requires_approval: true,
                required_flags: ['force'],
            },
            'browser:post': {
                risk_tier: 'HIGH',
                requires_approval: true,
                required_flags: ['force'],
            },
            'browser:send': {
                risk_tier: 'HIGH',
                requires_approval: true,
                required_flags: ['force'],
            },
        },
    },
});

const MUTATING_ACTIONS = new Set([
    'move',
    'rename',
    'archive',
    'trash',
    'restore',
    'git_mv',
    'git_add',
    'git_commit',
    'git_push',
]);

const GIT_ACTIONS = new Set([
    'git_status',
    'git_diff',
    'git_mv',
    'git_add',
    'git_commit',
    'git_push',
]);

function nowIso() {
    return new Date().toISOString();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mergeDeep(base, patch) {
    if (!patch || typeof patch !== 'object') return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (
            value
            && typeof value === 'object'
            && !Array.isArray(value)
            && out[key]
            && typeof out[key] === 'object'
            && !Array.isArray(out[key])
        ) {
            out[key] = mergeDeep(out[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function expandHome(value) {
    const raw = String(value || '').trim();
    if (!raw) return raw;
    if (raw === '~') return HOME_DIR;
    if (raw.startsWith('~/')) return path.join(HOME_DIR, raw.slice(2));
    return raw;
}

function normalizePathList(values) {
    const src = Array.isArray(values) ? values : [values];
    const out = [];
    const seen = new Set();
    for (const value of src) {
        const raw = expandHome(String(value || '').trim());
        if (!raw) continue;
        const resolved = path.resolve(raw);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        out.push(resolved);
    }
    return out;
}

function normalizeIdList(values) {
    const src = Array.isArray(values) ? values : [values];
    const out = [];
    const seen = new Set();
    for (const value of src) {
        const key = String(value || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

function normalizeRiskTier(value, fallback = 'MEDIUM') {
    const key = String(value || '').trim().toUpperCase();
    if (key === 'MEDIUM' || key === 'HIGH' || key === 'HIGH_PRECHECK' || key === 'GIT_AWARE') {
        return key;
    }
    return fallback;
}

function normalizeActionRiskRule(rule = {}) {
    const src = (rule && typeof rule === 'object') ? rule : {};
    const requiresApproval = typeof src.requires_approval === 'boolean'
        ? src.requires_approval
        : Boolean(src.requiresApproval);
    return {
        risk_tier: normalizeRiskTier(src.risk_tier || src.riskTier || 'MEDIUM'),
        requires_approval: requiresApproval,
        required_flags: normalizeIdList(src.required_flags || src.requiredFlags || []),
    };
}

function normalizeActionRiskPolicyTree(rawTree = {}) {
    const src = (rawTree && typeof rawTree === 'object') ? rawTree : {};
    const out = {};
    for (const [domainKey, rules] of Object.entries(src)) {
        const domain = String(domainKey || '').trim().toLowerCase();
        if (!domain || !rules || typeof rules !== 'object' || Array.isArray(rules)) continue;
        out[domain] = {};
        for (const [actionKey, rule] of Object.entries(rules)) {
            const action = String(actionKey || '').trim().toLowerCase();
            if (!action) continue;
            out[domain][action] = normalizeActionRiskRule(rule);
        }
    }
    return out;
}

function normalizeApprovalGrantPolicy(rawPolicy = {}) {
    const src = (rawPolicy && typeof rawPolicy === 'object') ? rawPolicy : {};
    const enabled = typeof src.enabled === 'boolean'
        ? src.enabled
        : Boolean(DEFAULT_POLICY.approvalGrantPolicy.enabled);
    const grantOnApproval = typeof src.grant_on_approval === 'boolean'
        ? src.grant_on_approval
        : (typeof src.grantOnApproval === 'boolean'
            ? src.grantOnApproval
            : Boolean(DEFAULT_POLICY.approvalGrantPolicy.grant_on_approval));
    const scopeRaw = String(src.scope || DEFAULT_POLICY.approvalGrantPolicy.scope || 'all').trim().toLowerCase();
    const scope = scopeRaw || 'all';

    const toBoundedNumber = (value, fallback) => {
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0) return fallback;
        return num;
    };

    const minTtlSeconds = Math.max(60, toBoundedNumber(
        src.minTtlSeconds,
        DEFAULT_POLICY.approvalGrantPolicy.minTtlSeconds,
    ));
    const maxTtlSeconds = Math.max(minTtlSeconds, toBoundedNumber(
        src.maxTtlSeconds,
        DEFAULT_POLICY.approvalGrantPolicy.maxTtlSeconds,
    ));
    const defaultCandidate = toBoundedNumber(
        src.defaultTtlSeconds,
        DEFAULT_POLICY.approvalGrantPolicy.defaultTtlSeconds,
    );
    const defaultTtlSeconds = Math.max(minTtlSeconds, Math.min(defaultCandidate, maxTtlSeconds));

    return {
        enabled,
        grant_on_approval: grantOnApproval,
        scope,
        defaultTtlSeconds,
        minTtlSeconds,
        maxTtlSeconds,
    };
}

function resolveActionRiskPolicy(policy, domain, action, fallback = {}) {
    const policyTree = normalizeActionRiskPolicyTree(policy && policy.actionRiskPolicy ? policy.actionRiskPolicy : {});
    const domainKey = String(domain || '').trim().toLowerCase();
    const actionKey = String(action || '').trim().toLowerCase();
    const exact = policyTree[domainKey] && policyTree[domainKey][actionKey]
        ? policyTree[domainKey][actionKey]
        : null;
    const defaultRule = (policyTree[domainKey] && policyTree[domainKey].default)
        ? policyTree[domainKey].default
        : null;
    const base = exact || defaultRule || {};
    const merged = normalizeActionRiskRule({
        risk_tier: fallback.risk_tier || fallback.riskTier || 'MEDIUM',
        requires_approval: Boolean(fallback.requires_approval || fallback.requiresApproval),
        required_flags: fallback.required_flags || fallback.requiredFlags || [],
        ...base,
    });
    return merged;
}

function loadPolicy(config = {}) {
    const merged = mergeDeep(clone(DEFAULT_POLICY), (config && config.opsFileControlPolicy) || {});
    merged.allowedRoots = normalizePathList(merged.allowedRoots);
    merged.mediumRoots = normalizePathList(merged.mediumRoots);
    merged.highRoots = normalizePathList(merged.highRoots);
    merged.gitAllowedRoots = normalizePathList(merged.gitAllowedRoots);
    merged.trashRoot = path.resolve(expandHome(String(merged.trashRoot || DEFAULT_POLICY.trashRoot)));
    merged.hashMaxBytes = Math.max(1024, Number(merged.hashMaxBytes || DEFAULT_POLICY.hashMaxBytes));
    merged.minFreeBytes = Math.max(64 * 1024 * 1024, Number(merged.minFreeBytes || DEFAULT_POLICY.minFreeBytes));
    merged.telegramGuard = {
        ...clone(DEFAULT_POLICY.telegramGuard),
        ...((merged.telegramGuard && typeof merged.telegramGuard === 'object') ? merged.telegramGuard : {}),
    };
    merged.telegramGuard.allowedUserIds = normalizeIdList(merged.telegramGuard.allowedUserIds);
    merged.telegramGuard.allowedGroupIds = normalizeIdList(merged.telegramGuard.allowedGroupIds);
    merged.actionRiskPolicy = normalizeActionRiskPolicyTree(merged.actionRiskPolicy || DEFAULT_POLICY.actionRiskPolicy);
    merged.approvalGrantPolicy = normalizeApprovalGrantPolicy(merged.approvalGrantPolicy || DEFAULT_POLICY.approvalGrantPolicy);
    return merged;
}

function isWithinRoot(targetPath, rootPath) {
    const rel = path.relative(rootPath, targetPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isPathAllowed(targetPath, roots) {
    for (const root of normalizePathList(roots || [])) {
        if (isWithinRoot(targetPath, root)) return true;
    }
    return false;
}

function containsGitMetaPath(targetPath) {
    const normalized = path.normalize(targetPath);
    const pieces = normalized.split(path.sep).filter(Boolean);
    return pieces.includes('.git');
}

function resolveWithExistingRealpath(inputPath) {
    const abs = path.resolve(String(inputPath || ''));
    if (!abs) return abs;
    let cursor = abs;
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (!parent || parent === cursor) return abs;
        cursor = parent;
    }
    try {
        const realCursor = fs.realpathSync(cursor);
        if (cursor === abs) return realCursor;
        const tail = path.relative(cursor, abs);
        return path.resolve(realCursor, tail);
    } catch (_) {
        return abs;
    }
}

function wildcardToRegExp(pattern) {
    const escaped = String(pattern || '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}

function containsGlob(value) {
    return /[\*\?]/.test(String(value || ''));
}

function expandPathSpec(pathSpec, pattern = '') {
    const baseInput = String(pathSpec || '').trim();
    const patternInput = String(pattern || '').trim();
    if (!baseInput && !patternInput) return [];

    if (patternInput) {
        const baseDir = path.resolve(expandHome(baseInput || '.'));
        if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return [];
        const re = wildcardToRegExp(patternInput);
        return fs.readdirSync(baseDir)
            .filter((name) => re.test(name))
            .map((name) => path.join(baseDir, name));
    }

    const expanded = path.resolve(expandHome(baseInput));
    if (!containsGlob(expanded)) return [expanded];

    const parentDir = path.dirname(expanded);
    const basePattern = path.basename(expanded);
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) return [];
    const re = wildcardToRegExp(basePattern);
    return fs.readdirSync(parentDir)
        .filter((name) => re.test(name))
        .map((name) => path.join(parentDir, name));
}

function dedupePaths(paths) {
    const out = [];
    const seen = new Set();
    for (const value of (Array.isArray(paths) ? paths : [])) {
        const abs = path.resolve(String(value || ''));
        if (!abs || seen.has(abs)) continue;
        seen.add(abs);
        out.push(abs);
    }
    return out;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        cwd: options.cwd || process.cwd(),
    });
    return {
        ok: !result.error && result.status === 0,
        code: result.status == null ? 1 : result.status,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
        error: result.error ? String(result.error.message || result.error) : '',
    };
}

function getDriveRoot(inputPath) {
    const abs = path.resolve(String(inputPath || ''));
    const m = abs.match(/^\/Volumes\/([^/]+)/);
    if (!m) return '';
    return `/Volumes/${m[1]}`;
}

function getFreeBytes(targetPath) {
    const result = run('df', ['-k', targetPath]);
    if (!result.ok) return { ok: false, bytes: 0, reason: result.stderr || result.error || 'df_failed' };
    const lines = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) return { ok: false, bytes: 0, reason: 'df_output_invalid' };
    const parts = lines[1].split(/\s+/).filter(Boolean);
    if (parts.length < 4) return { ok: false, bytes: 0, reason: 'df_columns_invalid' };
    const availableKb = Number(parts[3]);
    if (!Number.isFinite(availableKb)) return { ok: false, bytes: 0, reason: 'df_available_invalid' };
    return { ok: true, bytes: availableKb * 1024, reason: '' };
}

function runDrivePreflight(targetPath, policy) {
    const driveRoot = getDriveRoot(targetPath);
    const checks = {
        driveRoot,
        writableProbePath: '',
        mounted: false,
        writable: false,
        freeBytes: 0,
        freeOk: false,
        errors: [],
    };
    if (!driveRoot) {
        checks.errors.push('NOT_EXTERNAL_DRIVE_PATH');
        return checks;
    }

    checks.mounted = fs.existsSync(driveRoot);
    if (!checks.mounted) {
        checks.errors.push('DRIVE_NOT_MOUNTED');
        return checks;
    }

    let writableProbe = path.resolve(String(targetPath || driveRoot));
    if (!isWithinRoot(writableProbe, driveRoot)) {
        writableProbe = driveRoot;
    }
    while (!fs.existsSync(writableProbe)) {
        const parent = path.dirname(writableProbe);
        if (!parent || parent === writableProbe || !isWithinRoot(parent, driveRoot)) {
            writableProbe = driveRoot;
            break;
        }
        writableProbe = parent;
    }
    checks.writableProbePath = writableProbe;

    try {
        fs.accessSync(writableProbe, fs.constants.W_OK);
        checks.writable = true;
    } catch (_) {
        checks.errors.push('DRIVE_NOT_WRITABLE');
    }

    const free = getFreeBytes(driveRoot);
    if (free.ok) {
        checks.freeBytes = free.bytes;
        checks.freeOk = free.bytes >= Number(policy.minFreeBytes || DEFAULT_POLICY.minFreeBytes);
        if (!checks.freeOk) checks.errors.push('DRIVE_FREE_SPACE_LOW');
    } else {
        checks.errors.push('DRIVE_FREE_SPACE_CHECK_FAILED');
    }

    return checks;
}

function sha256File(filePath, maxBytes) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            return { hashed: false, reason: 'not_file', size: stat.size || 0, sha256: null };
        }
        if (stat.size > maxBytes) {
            return { hashed: false, reason: 'too_large', size: stat.size, sha256: null };
        }
        const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
        return { hashed: true, reason: '', size: stat.size, sha256: digest };
    } catch (error) {
        return { hashed: false, reason: String(error && error.message ? error.message : error), size: 0, sha256: null };
    }
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function copyRecursive(src, dst) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        ensureDir(dst);
        for (const name of fs.readdirSync(src)) {
            copyRecursive(path.join(src, name), path.join(dst, name));
        }
        return;
    }
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
}

function removeRecursive(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: false });
}

function safeMove(src, dst) {
    ensureDir(path.dirname(dst));
    try {
        fs.renameSync(src, dst);
        return { ok: true, mode: 'rename' };
    } catch (error) {
        if (!error || error.code !== 'EXDEV') {
            return { ok: false, mode: 'rename', error: String(error && error.message ? error.message : error) };
        }
    }

    try {
        copyRecursive(src, dst);
        removeRecursive(src);
        return { ok: true, mode: 'copy_remove' };
    } catch (error) {
        return { ok: false, mode: 'copy_remove', error: String(error && error.message ? error.message : error) };
    }
}

function toRepoRelative(repoRoot, absPath) {
    const rel = path.relative(repoRoot, absPath);
    if (!rel || rel === '') return '.';
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`path outside repo: ${absPath}`);
    }
    return rel;
}

function normalizeIntentAction(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return null;
    const map = {
        list_files: ['list_files', 'list', '목록', 'ls'],
        compute_plan: ['compute_plan', 'plan', '계획', 'preview'],
        move: ['move', '이동'],
        rename: ['rename', '이름변경', 'ren'],
        archive: ['archive', '보관'],
        trash: ['trash', 'delete', '삭제', '휴지통'],
        restore: ['restore', '복원'],
        drive_preflight_check: ['drive_preflight_check', 'preflight', 'drive_check', '드라이브점검'],
        git_status: ['git_status', 'git status', 'git-status'],
        git_diff: ['git_diff', 'git diff', 'git-diff'],
        git_mv: ['git_mv', 'git mv', 'git-mv'],
        git_add: ['git_add', 'git add', 'git-add'],
        git_commit: ['git_commit', 'git commit', 'git-commit'],
        git_push: ['git_push', 'git push', 'git-push'],
    };
    for (const [canonical, aliases] of Object.entries(map)) {
        if (aliases.includes(key)) return canonical;
    }
    return null;
}

function normalizeApprovalFlags(input) {
    const values = Array.isArray(input)
        ? input
        : String(input || '')
            .split(/[\s,]+/)
            .map((v) => v.trim())
            .filter(Boolean);
    const out = [];
    const seen = new Set();
    for (const value of values) {
        let key = String(value || '').trim().toLowerCase();
        if (!key) continue;
        if (key.startsWith('--')) key = key.slice(2);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

function isMutatingAction(action) {
    return MUTATING_ACTIONS.has(String(action || '').trim());
}

function isGitAction(action) {
    return GIT_ACTIONS.has(String(action || '').trim());
}

function normalizeRequester(telegramContext = {}, fallback = 'unknown') {
    const direct = String((telegramContext && telegramContext.userId) || '').trim();
    if (direct) return direct;
    return String(fallback || 'unknown').trim() || 'unknown';
}

function classifyRiskTier(paths, action, policy) {
    if (isGitAction(action)) return 'GIT_AWARE';
    const rank = { MEDIUM: 1, HIGH: 2, HIGH_PRECHECK: 3 };
    let tier = 'MEDIUM';
    for (const absPath of (Array.isArray(paths) ? paths : [])) {
        const pathValue = path.resolve(String(absPath || ''));
        let current = 'HIGH';
        if (pathValue.startsWith(`${policy.externalRoot}/`) || pathValue === policy.externalRoot) {
            current = 'HIGH_PRECHECK';
        } else if (isPathAllowed(pathValue, policy.mediumRoots)) {
            current = 'MEDIUM';
        } else if (isPathAllowed(pathValue, policy.highRoots)) {
            current = 'HIGH';
        }
        if ((rank[current] || 0) > (rank[tier] || 0)) {
            tier = current;
        }
    }
    return tier;
}

function requiredFlagsForPlan(action, riskTier, mutating) {
    if (!mutating) return [];
    if (action === 'git_push') return ['force', 'push'];
    if (riskTier === 'MEDIUM') return [];
    return ['force'];
}

function validatePathSafety(paths, policy, blockers, warnings) {
    for (const rawPath of (Array.isArray(paths) ? paths : [])) {
        const absPath = path.resolve(String(rawPath || ''));
        const realPath = resolveWithExistingRealpath(absPath);
        if (containsGitMetaPath(absPath) || containsGitMetaPath(realPath)) {
            blockers.push({ code: 'PATH_IN_GIT_META', path: absPath, message: '.git/** paths are blocked.' });
            continue;
        }
        if (!isPathAllowed(realPath, policy.allowedRoots)) {
            blockers.push({ code: 'PATH_OUTSIDE_ALLOWED_ROOT', path: absPath, message: 'Path is outside allowed roots.' });
        }
        if (isPathAllowed(absPath, policy.allowedRoots) && !isPathAllowed(realPath, policy.allowedRoots)) {
            blockers.push({ code: 'PATH_SYMLINK_ESCAPE', path: absPath, message: 'Path resolves outside allowed roots.' });
        }
        if (absPath.startsWith(ICLOUD_PATH) && !fs.existsSync(ICLOUD_PATH)) {
            warnings.push({ code: 'ICLOUD_PATH_MISSING', path: ICLOUD_PATH, message: 'iCloud Drive path is not present on this host.' });
        }
    }
}

function resolveRepository(payload, policy, fallbackPath = '') {
    const candidate = String(payload.repository || payload.repo || '').trim();
    let base = candidate
        ? path.resolve(expandHome(candidate))
        : (fallbackPath ? path.resolve(fallbackPath) : process.cwd());
    try {
        if (fs.existsSync(base) && fs.statSync(base).isFile()) {
            base = path.dirname(base);
        }
    } catch (_) {
        // Keep original base when stat probing fails.
    }
    const probe = run('git', ['-C', base, 'rev-parse', '--show-toplevel']);
    if (!probe.ok) {
        return {
            ok: false,
            repoRoot: '',
            error: probe.stderr || probe.error || 'not_git_repo',
        };
    }
    const repoRoot = path.resolve(String(probe.stdout || '').trim());
    if (!repoRoot) {
        return {
            ok: false,
            repoRoot: '',
            error: 'not_git_repo',
        };
    }
    if (!isPathAllowed(repoRoot, policy.gitAllowedRoots)) {
        return {
            ok: false,
            repoRoot,
            error: 'repo_outside_git_allowed_roots',
        };
    }
    return {
        ok: true,
        repoRoot,
        error: '',
    };
}

function buildBasePlan(input, action, policy) {
    const payload = { ...(input.payload || {}) };
    const sourceCandidates = dedupePaths(expandPathSpec(payload.path || payload.source || '', payload.pattern || ''));
    const normalizedTargetPath = payload.target_path || payload.targetPath || payload.destination || payload.대상경로 || '';
    const targetPath = normalizedTargetPath
        ? path.resolve(expandHome(normalizedTargetPath))
        : '';

    const pathsForRisk = [...sourceCandidates];
    if (targetPath) pathsForRisk.push(targetPath);

    const plan = {
        schema_version: '1.0',
        created_at: nowIso(),
        intent_action: action,
        requested_by: normalizeRequester(input.telegramContext, input.requestedBy),
        payload,
        source_candidates: sourceCandidates,
        target_path: targetPath || null,
        risk_tier: 'HIGH',
        mutating: isMutatingAction(action),
        required_flags: [],
        exact_paths: [],
        operations: [],
        warnings: [],
        blockers: [],
        plan_summary: '',
        rollback_instructions: [],
        preflight: null,
        git: null,
    };

    const listForSafety = [...sourceCandidates];
    if (targetPath) listForSafety.push(targetPath);
    validatePathSafety(listForSafety, policy, plan.blockers, plan.warnings);

    plan.risk_tier = classifyRiskTier(pathsForRisk, action, policy);
    plan.required_flags = requiredFlagsForPlan(action, plan.risk_tier, plan.mutating);
    const actionPolicy = resolveActionRiskPolicy(policy, 'file', action, {
        risk_tier: plan.risk_tier,
        requires_approval: plan.required_flags.length > 0,
        required_flags: plan.required_flags,
    });
    plan.risk_tier = actionPolicy.risk_tier;
    if (plan.mutating) {
        if (actionPolicy.requires_approval) {
            plan.required_flags = actionPolicy.required_flags.length > 0
                ? actionPolicy.required_flags
                : ['force'];
        } else {
            plan.required_flags = [];
        }
    } else {
        plan.required_flags = [];
    }

    return plan;
}

function computePlan(input = {}) {
    const policy = input.policy || loadPolicy({});
    const action = normalizeIntentAction(input.intentAction || input.intent_action || '');
    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: 'Unsupported file-control action.',
            plan: null,
        };
    }

    const plan = buildBasePlan(input, action, policy);
    const sourcePaths = plan.source_candidates;
    const targetPath = plan.target_path;
    const payload = plan.payload || {};

    const appendSummary = (text) => {
        const line = String(text || '').trim();
        if (!line) return;
        if (!plan.plan_summary) {
            plan.plan_summary = line;
            return;
        }
        plan.plan_summary += `\n${line}`;
    };

    if (action === 'list_files' || action === 'compute_plan') {
        plan.exact_paths = sourcePaths;
        if (!sourcePaths.length) {
            plan.warnings.push({ code: 'NO_MATCH', message: 'No files matched the given path/pattern.' });
        }
        appendSummary(`planned files: ${sourcePaths.length}`);
        return { ok: true, plan };
    }

    if (action === 'drive_preflight_check') {
        const candidate = sourcePaths[0] || targetPath || path.resolve(String(payload.path || '/Volumes'));
        plan.preflight = runDrivePreflight(candidate, policy);
        plan.exact_paths = [candidate];
        if (plan.preflight.errors.length > 0) {
            for (const code of plan.preflight.errors) {
                plan.blockers.push({ code, path: candidate, message: code });
            }
        }
        appendSummary(`drive preflight: ${candidate}`);
        return { ok: true, plan };
    }

    if (isGitAction(action)) {
        const fallbackPath = sourcePaths[0] || targetPath || process.cwd();
        const repo = resolveRepository(payload, policy, fallbackPath);
        if (!repo.ok) {
            plan.blockers.push({ code: 'GIT_REPO_INVALID', message: repo.error });
            appendSummary(`git repo invalid: ${repo.error}`);
            return { ok: true, plan };
        }
        plan.git = {
            repo_root: repo.repoRoot,
            status: run('git', ['-C', repo.repoRoot, 'status', '--short']),
        };

        if (action === 'git_status') {
            appendSummary(`git status @ ${repo.repoRoot}`);
            return { ok: true, plan };
        }

        if (action === 'git_diff') {
            const diffArgs = ['-C', repo.repoRoot, 'diff'];
            if (sourcePaths[0]) {
                try {
                    diffArgs.push('--', toRepoRelative(repo.repoRoot, sourcePaths[0]));
                } catch (error) {
                    plan.blockers.push({ code: 'GIT_PATH_INVALID', message: String(error.message || error) });
                }
            }
            plan.git.diff = run('git', diffArgs);
            appendSummary(`git diff @ ${repo.repoRoot}`);
            return { ok: true, plan };
        }

        if (action === 'git_mv') {
            if (!sourcePaths[0] || !targetPath) {
                plan.blockers.push({ code: 'GIT_MV_INPUT_REQUIRED', message: 'git_mv requires path and target_path.' });
            } else {
                try {
                    const srcRel = toRepoRelative(repo.repoRoot, sourcePaths[0]);
                    const dstRel = toRepoRelative(repo.repoRoot, targetPath);
                    plan.operations.push({ kind: 'git_mv', src: sourcePaths[0], dst: targetPath });
                    plan.exact_paths.push(sourcePaths[0], targetPath);
                    plan.rollback_instructions.push(`git -C "${repo.repoRoot}" mv "${dstRel}" "${srcRel}"`);
                    plan.git.diff = run('git', ['-C', repo.repoRoot, 'diff', '--', srcRel, dstRel]);
                } catch (error) {
                    plan.blockers.push({ code: 'GIT_PATH_INVALID', message: String(error.message || error) });
                }
            }
            appendSummary(`git mv plan @ ${repo.repoRoot}`);
            return { ok: true, plan };
        }

        if (action === 'git_add') {
            if (!sourcePaths.length) {
                plan.blockers.push({ code: 'GIT_ADD_PATH_REQUIRED', message: 'git_add requires path or pattern.' });
            } else {
                try {
                    const relPaths = sourcePaths.map((p) => toRepoRelative(repo.repoRoot, p));
                    plan.operations.push({ kind: 'git_add', paths: sourcePaths });
                    plan.exact_paths.push(...sourcePaths);
                    plan.git.diff = run('git', ['-C', repo.repoRoot, 'diff', '--', ...relPaths]);
                } catch (error) {
                    plan.blockers.push({ code: 'GIT_PATH_INVALID', message: String(error.message || error) });
                }
            }
            appendSummary(`git add plan @ ${repo.repoRoot}`);
            return { ok: true, plan };
        }

        if (action === 'git_commit') {
            const commitMessage = String(payload.commit_message || payload.commitMessage || '').trim();
            if (!commitMessage) {
                plan.blockers.push({ code: 'GIT_COMMIT_MESSAGE_REQUIRED', message: 'commit message is required.' });
            } else {
                plan.operations.push({ kind: 'git_commit', message: commitMessage });
                plan.rollback_instructions.push(`If not pushed: git -C "${repo.repoRoot}" reset --soft HEAD~1`);
                plan.git.diff = run('git', ['-C', repo.repoRoot, 'diff', '--cached']);
            }
            appendSummary(`git commit plan @ ${repo.repoRoot}`);
            return { ok: true, plan };
        }

        if (action === 'git_push') {
            plan.operations.push({ kind: 'git_push' });
            plan.rollback_instructions.push('If already pushed/shared: git revert <commit_hash> (preferred).');
            plan.git.diff = run('git', ['-C', repo.repoRoot, 'log', '--oneline', '-n', '3']);
            appendSummary(`git push plan @ ${repo.repoRoot}`);
            return { ok: true, plan };
        }

        return { ok: true, plan };
    }

    if (!sourcePaths.length) {
        plan.blockers.push({ code: 'SOURCE_NOT_FOUND', message: 'No source files matched the request.' });
    }

    if (action === 'move' || action === 'archive') {
        if (!targetPath) {
            plan.blockers.push({ code: 'TARGET_REQUIRED', message: `${action} requires target_path.` });
        } else {
            for (const src of sourcePaths) {
                const dst = path.join(targetPath, path.basename(src));
                plan.operations.push({ kind: 'move', src, dst, mode: action });
                plan.exact_paths.push(src, dst);
                plan.rollback_instructions.push(`mv "${dst}" "${src}"`);
            }
        }
        appendSummary(`${action} plan: ${sourcePaths.length} item(s)`);
    } else if (action === 'rename') {
        if (!sourcePaths[0] || !targetPath) {
            plan.blockers.push({ code: 'RENAME_INPUT_REQUIRED', message: 'rename requires one source path and target_path.' });
        } else {
            plan.operations.push({ kind: 'move', src: sourcePaths[0], dst: targetPath, mode: action });
            plan.exact_paths.push(sourcePaths[0], targetPath);
            plan.rollback_instructions.push(`mv "${targetPath}" "${sourcePaths[0]}"`);
        }
        appendSummary('rename plan created');
    } else if (action === 'trash') {
        const sessionDir = path.join(policy.trashRoot, new Date().toISOString().replace(/[:]/g, '-'));
        for (const src of sourcePaths) {
            const dst = path.join(sessionDir, path.basename(src));
            plan.operations.push({ kind: 'trash', src, dst, trash_session: sessionDir });
            plan.exact_paths.push(src, dst);
            plan.rollback_instructions.push(`restore_from_trash "${dst}" -> "${src}"`);
        }
        appendSummary(`trash plan: ${sourcePaths.length} item(s)`);
    } else if (action === 'restore') {
        const restoreRoot = targetPath || path.join(HOME_DIR, 'Restored_From_Assistant_Trash');
        for (const src of sourcePaths) {
            if (!isWithinRoot(src, policy.trashRoot)) {
                plan.blockers.push({ code: 'RESTORE_SOURCE_INVALID', path: src, message: 'restore source must be inside assistant trash.' });
                continue;
            }
            const dst = path.join(restoreRoot, path.basename(src));
            plan.operations.push({ kind: 'restore', src, dst });
            plan.exact_paths.push(src, dst);
            plan.rollback_instructions.push(`mv "${dst}" "${src}"`);
        }
        appendSummary(`restore plan: ${sourcePaths.length} item(s)`);
    }

    const drivePaths = dedupePaths(plan.exact_paths).filter((item) => item.startsWith('/Volumes/'));
    if (drivePaths.length > 0 || plan.risk_tier === 'HIGH_PRECHECK') {
        const driveTarget = drivePaths[0] || '/Volumes';
        plan.preflight = runDrivePreflight(driveTarget, policy);
        if (plan.preflight.errors.length > 0) {
            for (const code of plan.preflight.errors) {
                plan.blockers.push({ code, path: driveTarget, message: code });
            }
        }
    }

    plan.exact_paths = dedupePaths(plan.exact_paths);
    return { ok: true, plan };
}

function revalidatePlan(plan, policy) {
    const blockers = [];
    for (const op of (Array.isArray(plan.operations) ? plan.operations : [])) {
        if (!op || !op.src) continue;
        if (!fs.existsSync(op.src)) {
            blockers.push({ code: 'PLAN_MISMATCH', path: op.src, message: 'source path no longer exists.' });
        }
    }

    if (plan.risk_tier === 'HIGH_PRECHECK' || (plan.preflight && plan.preflight.driveRoot)) {
        const target = (plan.exact_paths || []).find((x) => x.startsWith('/Volumes/'))
            || (plan.preflight && plan.preflight.writableProbePath)
            || (plan.preflight && plan.preflight.driveRoot)
            || '';
        const preflight = runDrivePreflight(target, policy);
        if (preflight.errors.length > 0) {
            blockers.push({ code: 'DRIVE_PREFLIGHT_FAILED', path: target, message: preflight.errors.join(',') });
        }
    }

    return blockers;
}

function runGitWithRepo(repoRoot, args) {
    return run('git', ['-C', repoRoot, ...args]);
}

function executePlan(input = {}) {
    const policy = input.policy || loadPolicy({});
    const plan = input.plan || {};
    const action = normalizeIntentAction(plan.intent_action || input.intentAction || '');
    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: 'Unsupported action for execute.',
            executed_steps: [],
        };
    }

    const steps = [];
    const hashes = [];
    const fileCounts = {
        moved: 0,
        trashed: 0,
        restored: 0,
        hashed: 0,
    };

    const preBlockers = revalidatePlan(plan, policy);
    if (preBlockers.length > 0) {
        return {
            ok: false,
            error_code: 'PLAN_MISMATCH',
            error: 'Plan revalidation failed.',
            blockers: preBlockers,
            executed_steps: steps,
            file_counts: fileCounts,
            hashes,
            rollback_instructions: plan.rollback_instructions || [],
        };
    }

    if (!isMutatingAction(action)) {
        return {
            ok: true,
            action,
            executed_steps: [{ step: action, ok: true, detail: 'non-mutating action' }],
            file_counts: fileCounts,
            hashes,
            rollback_instructions: [],
            plan_summary: plan.plan_summary || '',
        };
    }

    if (isGitAction(action)) {
        const repoRoot = plan && plan.git && plan.git.repo_root ? String(plan.git.repo_root) : '';
        if (!repoRoot) {
            return {
                ok: false,
                error_code: 'GIT_REPO_INVALID',
                error: 'Missing git repo root in plan.',
                executed_steps: steps,
                file_counts: fileCounts,
                hashes,
                rollback_instructions: plan.rollback_instructions || [],
            };
        }

        if (action === 'git_mv') {
            const op = (plan.operations || [])[0];
            if (!op || !op.src || !op.dst) {
                return {
                    ok: false,
                    error_code: 'GIT_MV_INPUT_REQUIRED',
                    error: 'git_mv operation is missing src/dst.',
                    executed_steps: steps,
                    file_counts: fileCounts,
                    hashes,
                    rollback_instructions: plan.rollback_instructions || [],
                };
            }
            const srcRel = toRepoRelative(repoRoot, op.src);
            const dstRel = toRepoRelative(repoRoot, op.dst);
            const res = runGitWithRepo(repoRoot, ['mv', srcRel, dstRel]);
            steps.push({ step: 'git_mv', ok: res.ok, stdout: res.stdout, stderr: res.stderr || res.error || '' });
            if (!res.ok) {
                return {
                    ok: false,
                    error_code: 'GIT_MV_FAILED',
                    error: res.stderr || res.error || 'git mv failed',
                    executed_steps: steps,
                    file_counts: fileCounts,
                    hashes,
                    rollback_instructions: plan.rollback_instructions || [],
                };
            }
        } else if (action === 'git_add') {
            const op = (plan.operations || [])[0] || { paths: [] };
            if (!Array.isArray(op.paths) || op.paths.length === 0) {
                return {
                    ok: false,
                    error_code: 'GIT_ADD_PATH_REQUIRED',
                    error: 'git_add operation has no paths.',
                    executed_steps: steps,
                    file_counts: fileCounts,
                    hashes,
                    rollback_instructions: plan.rollback_instructions || [],
                };
            }
            const relPaths = (op.paths || []).map((p) => toRepoRelative(repoRoot, p));
            const res = runGitWithRepo(repoRoot, ['add', ...relPaths]);
            steps.push({ step: 'git_add', ok: res.ok, stdout: res.stdout, stderr: res.stderr || res.error || '' });
            if (!res.ok) {
                return {
                    ok: false,
                    error_code: 'GIT_ADD_FAILED',
                    error: res.stderr || res.error || 'git add failed',
                    executed_steps: steps,
                    file_counts: fileCounts,
                    hashes,
                    rollback_instructions: plan.rollback_instructions || [],
                };
            }
        } else if (action === 'git_commit') {
            const op = (plan.operations || [])[0] || {};
            const message = String(op.message || '').trim();
            if (!message) {
                return {
                    ok: false,
                    error_code: 'GIT_COMMIT_MESSAGE_REQUIRED',
                    error: 'git commit message is missing.',
                    executed_steps: steps,
                    file_counts: fileCounts,
                    hashes,
                    rollback_instructions: plan.rollback_instructions || [],
                };
            }
            const res = runGitWithRepo(repoRoot, ['commit', '-m', message]);
            steps.push({ step: 'git_commit', ok: res.ok, stdout: res.stdout, stderr: res.stderr || res.error || '' });
            if (!res.ok) {
                return {
                    ok: false,
                    error_code: 'GIT_COMMIT_FAILED',
                    error: res.stderr || res.error || 'git commit failed',
                    executed_steps: steps,
                    file_counts: fileCounts,
                    hashes,
                    rollback_instructions: plan.rollback_instructions || [],
                };
            }
            const rev = runGitWithRepo(repoRoot, ['rev-parse', 'HEAD']);
            if (rev.ok && rev.stdout) {
                steps.push({ step: 'git_commit_hash', ok: true, commit_hash: rev.stdout });
            }
        } else if (action === 'git_push') {
            const res = runGitWithRepo(repoRoot, ['push']);
            steps.push({ step: 'git_push', ok: res.ok, stdout: res.stdout, stderr: res.stderr || res.error || '' });
            if (!res.ok) {
                return {
                    ok: false,
                    error_code: 'GIT_PUSH_FAILED',
                    error: res.stderr || res.error || 'git push failed',
                    executed_steps: steps,
                    file_counts: fileCounts,
                    hashes,
                    rollback_instructions: plan.rollback_instructions || [],
                };
            }
            const rev = runGitWithRepo(repoRoot, ['rev-parse', 'HEAD']);
            if (rev.ok && rev.stdout) {
                steps.push({ step: 'git_head_after_push', ok: true, commit_hash: rev.stdout });
            }
        }

        return {
            ok: true,
            action,
            executed_steps: steps,
            file_counts: fileCounts,
            hashes,
            rollback_instructions: plan.rollback_instructions || [],
            plan_summary: plan.plan_summary || '',
        };
    }

    const trashManifests = new Map();
    for (const op of (plan.operations || [])) {
        if (!op || !op.src || !op.dst) continue;
        const hashInfo = sha256File(op.src, Number(policy.hashMaxBytes || DEFAULT_POLICY.hashMaxBytes));
        if (hashInfo.hashed) {
            hashes.push({ path: op.src, sha256: hashInfo.sha256, size: hashInfo.size });
            fileCounts.hashed += 1;
        }

        const moved = safeMove(op.src, op.dst);
        steps.push({
            step: op.kind || 'move',
            src: op.src,
            dst: op.dst,
            ok: moved.ok,
            mode: moved.mode,
            error: moved.error || '',
        });

        if (!moved.ok) {
            return {
                ok: false,
                error_code: 'FILE_OPERATION_FAILED',
                error: moved.error || 'file move failed',
                executed_steps: steps,
                file_counts: fileCounts,
                hashes,
                rollback_instructions: plan.rollback_instructions || [],
            };
        }

        if (op.kind === 'trash') {
            fileCounts.trashed += 1;
            const session = String(op.trash_session || path.dirname(op.dst));
            if (!trashManifests.has(session)) {
                trashManifests.set(session, []);
            }
            trashManifests.get(session).push({
                original_path: op.src,
                trash_path: op.dst,
                moved_at: nowIso(),
                hash: hashInfo.hashed ? hashInfo.sha256 : null,
            });
        } else if (op.kind === 'restore') {
            fileCounts.restored += 1;
        } else {
            fileCounts.moved += 1;
        }
    }

    for (const [sessionPath, items] of trashManifests.entries()) {
        ensureDir(sessionPath);
        const manifestPath = path.join(sessionPath, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({
            schema_version: '1.0',
            created_at: nowIso(),
            items,
        }, null, 2), 'utf8');
        steps.push({ step: 'trash_manifest', ok: true, path: manifestPath, item_count: items.length });
    }

    return {
        ok: true,
        action,
        executed_steps: steps,
        file_counts: fileCounts,
        hashes,
        rollback_instructions: plan.rollback_instructions || [],
        plan_summary: plan.plan_summary || '',
    };
}

function formatPlanReply(plan, approvalRecord = null) {
    const lines = [];
    lines.push(`[PLAN] ${plan.intent_action}`);
    lines.push(`- risk: ${plan.risk_tier}`);
    lines.push(`- mutating: ${plan.mutating ? 'yes' : 'no'}`);
    lines.push(`- files: ${(plan.exact_paths || []).length}`);
    if (plan.approval_grant && typeof plan.approval_grant === 'object') {
        const scope = String(plan.approval_grant.scope || 'all');
        const expiresAt = String(plan.approval_grant.expires_at || '').trim();
        lines.push(`- approval grant: active (${scope}${expiresAt ? ` until ${expiresAt}` : ''})`);
    }
    if (plan.plan_summary) lines.push(`- summary: ${String(plan.plan_summary).replace(/\n/g, ' | ')}`);
    if (plan.required_flags && plan.required_flags.length > 0) {
        lines.push(`- required approval flags: ${plan.required_flags.map((f) => `--${f}`).join(' ')}`);
    }
    if (plan.warnings && plan.warnings.length > 0) {
        lines.push(`- warnings: ${plan.warnings.slice(0, 3).map((w) => w.code).join(', ')}`);
    }
    if (plan.blockers && plan.blockers.length > 0) {
        lines.push(`- blockers: ${plan.blockers.slice(0, 3).map((b) => b.code).join(', ')}`);
    }
    if (plan.preflight && typeof plan.preflight === 'object') {
        lines.push(`- preflight: mounted=${plan.preflight.mounted ? 'yes' : 'no'}, writable=${plan.preflight.writable ? 'yes' : 'no'}, freeOk=${plan.preflight.freeOk ? 'yes' : 'no'}`);
    }
    if (approvalRecord) {
        lines.push(`- token: ${approvalRecord.token}`);
        lines.push(`- expires: ${approvalRecord.expires_at}`);
    }
    if (Array.isArray(plan.exact_paths) && plan.exact_paths.length > 0) {
        lines.push('- paths:');
        for (const item of plan.exact_paths.slice(0, 10)) {
            lines.push(`  - ${item}`);
        }
        if (plan.exact_paths.length > 10) {
            lines.push(`  - ... +${plan.exact_paths.length - 10} more`);
        }
    }
    if (Array.isArray(plan.rollback_instructions) && plan.rollback_instructions.length > 0) {
        lines.push('- rollback:');
        for (const line of plan.rollback_instructions.slice(0, 3)) {
            lines.push(`  - ${line}`);
        }
    }
    return lines.join('\n');
}

function formatExecuteReply(result = {}) {
    const lines = [];
    lines.push(`[RESULT] ${result.action || 'execute'}`);
    lines.push(`- ok: ${result.ok ? 'yes' : 'no'}`);
    if (result.approval_grant && typeof result.approval_grant === 'object') {
        const scope = String(result.approval_grant.scope || 'all');
        const expiresAt = String(result.approval_grant.expires_at || '').trim();
        lines.push(`- approval grant: active (${scope}${expiresAt ? ` until ${expiresAt}` : ''})`);
    }
    if (result.error_code) lines.push(`- error: ${result.error_code}`);
    if (result.error) lines.push(`- detail: ${String(result.error).slice(0, 220)}`);
    const counts = result.file_counts || {};
    lines.push(`- moved: ${Number(counts.moved || 0)}, trashed: ${Number(counts.trashed || 0)}, restored: ${Number(counts.restored || 0)}`);
    const hashes = Array.isArray(result.hashes) ? result.hashes.length : 0;
    lines.push(`- hashed: ${hashes}`);
    if (Array.isArray(result.rollback_instructions) && result.rollback_instructions.length > 0) {
        lines.push('- rollback:');
        for (const line of result.rollback_instructions.slice(0, 3)) {
            lines.push(`  - ${line}`);
        }
    }
    return lines.join('\n');
}

module.exports = {
    DEFAULT_POLICY,
    loadPolicy,
    normalizeIntentAction,
    normalizeApprovalFlags,
    normalizeRequester,
    normalizeRiskTier,
    isMutatingAction,
    isGitAction,
    normalizeApprovalGrantPolicy,
    resolveActionRiskPolicy,
    computePlan,
    executePlan,
    formatPlanReply,
    formatExecuteReply,
    runDrivePreflight,
    classifyRiskTier,
};
