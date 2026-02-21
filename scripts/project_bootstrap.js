const path = require('path');

const DEFAULT_PROJECTS_ROOT = String(process.env.OPENCLAW_PROJECTS_ROOT || '/Users/moltbot/Projects').trim();
const DEFAULT_ALLOWED_ROOTS = [DEFAULT_PROJECTS_ROOT];

function sanitizeProjectName(raw) {
  const base = String(raw || '').trim().toLowerCase();
  const slug = base
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return slug || 'new-project';
}

function normalizeAllowedRoots(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const resolved = path.resolve(String(value || '').trim());
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out.length > 0 ? out : [...DEFAULT_ALLOWED_ROOTS];
}

function normalizeTargetPath(basePath, projectName, options = {}) {
  const defaultRoot = path.resolve(String(options.defaultRoot || DEFAULT_PROJECTS_ROOT).trim());
  const rawBase = String(basePath || '').trim();
  if (!rawBase) {
    const targetPath = path.join(defaultRoot, projectName);
    return {
      basePathSource: 'default',
      basePath: defaultRoot,
      targetPath,
      warnings: [],
    };
  }

  const warnings = [];
  let normalizedBase = rawBase;
  let basePathSource = 'absolute';
  if (!path.isAbsolute(rawBase)) {
    basePathSource = 'relative';
    normalizedBase = path.join(defaultRoot, rawBase);
    warnings.push(`상대 경로 "${rawBase}"를 기본 루트(${defaultRoot}) 기준으로 해석했습니다.`);
  }

  normalizedBase = path.resolve(normalizedBase).replace(/\/+$/, '');
  const tail = normalizedBase.split('/').pop();
  const targetPath = tail === projectName
    ? normalizedBase
    : `${normalizedBase}/${projectName}`;
  return {
    basePathSource,
    basePath: normalizedBase,
    targetPath,
    warnings,
  };
}

function detectTemplate(stackText) {
  const stack = String(stackText || '').trim().toLowerCase();
  if (/(next|next\.js|nextjs)/.test(stack)) {
    return { id: 'next-ts', label: 'Next.js + TypeScript' };
  }
  if (/(vite|react|frontend|프론트)/.test(stack)) {
    return { id: 'vite-react-ts', label: 'Vite React + TypeScript' };
  }
  if (/(fastapi|python|백엔드파이썬|파이썬)/.test(stack)) {
    return { id: 'fastapi', label: 'FastAPI (Python)' };
  }
  if (/(node|express|backend|백엔드)/.test(stack)) {
    return { id: 'node-express', label: 'Node.js Express' };
  }
  return { id: 'generic', label: 'Generic' };
}

function detectPackageManager(stackText) {
  const stack = String(stackText || '').trim().toLowerCase();
  if (/\bpnpm\b/.test(stack)) return 'pnpm';
  if (/\byarn\b/.test(stack)) return 'yarn';
  if (/\bbun\b/.test(stack)) return 'bun';
  return 'npm';
}

function normalizeInitMode(rawMode) {
  const mode = String(rawMode || '').trim().toLowerCase();
  if (!mode) return 'plan';
  if (['run', 'execute', '실행', 'yes', 'true', '1', 'on'].includes(mode)) return 'execute';
  return 'plan';
}

function devCommand(packageManager) {
  if (packageManager === 'pnpm') return 'pnpm dev';
  if (packageManager === 'yarn') return 'yarn dev';
  if (packageManager === 'bun') return 'bun run dev';
  return 'npm run dev';
}

function addDependencyCommand(packageManager, name, { dev = false } = {}) {
  if (packageManager === 'pnpm') return dev ? `pnpm add -D ${name}` : `pnpm add ${name}`;
  if (packageManager === 'yarn') return dev ? `yarn add -D ${name}` : `yarn add ${name}`;
  if (packageManager === 'bun') return dev ? `bun add -d ${name}` : `bun add ${name}`;
  return dev ? `npm install -D ${name}` : `npm install ${name}`;
}

function buildBootstrapCommands({ template, projectName, targetPath, packageManager }) {
  const parentPath = path.dirname(targetPath);
  switch (template.id) {
    case 'next-ts':
      return [
        `mkdir -p "${parentPath}"`,
        `cd "${parentPath}"`,
        packageManager === 'pnpm'
          ? `pnpm create next-app "${projectName}" --ts --eslint --app --src-dir --import-alias "@/*"`
          : packageManager === 'yarn'
            ? `yarn create next-app "${projectName}" --ts --eslint --app --src-dir --import-alias "@/*"`
            : packageManager === 'bun'
              ? `bunx create-next-app@latest "${projectName}" --ts --eslint --app --src-dir --import-alias "@/*"`
              : `npx create-next-app@latest "${projectName}" --ts --eslint --app --src-dir --import-alias "@/*"`,
        `cd "${targetPath}"`,
        devCommand(packageManager),
      ];
    case 'vite-react-ts':
      return [
        `mkdir -p "${parentPath}"`,
        `cd "${parentPath}"`,
        packageManager === 'pnpm'
          ? `pnpm create vite "${projectName}" --template react-ts`
          : packageManager === 'yarn'
            ? `yarn create vite "${projectName}" --template react-ts`
            : packageManager === 'bun'
              ? `bun create vite "${projectName}" --template react-ts`
              : `npm create vite@latest "${projectName}" -- --template react-ts`,
        `cd "${targetPath}"`,
        packageManager === 'pnpm'
          ? 'pnpm install'
          : packageManager === 'yarn'
            ? 'yarn install'
            : packageManager === 'bun'
              ? 'bun install'
              : 'npm install',
        devCommand(packageManager),
      ];
    case 'node-express':
      return [
        `mkdir -p "${targetPath}"`,
        `cd "${targetPath}"`,
        packageManager === 'yarn'
          ? 'yarn init -y'
          : packageManager === 'bun'
            ? 'bun init -y'
            : 'npm init -y',
        addDependencyCommand(packageManager, 'express'),
        addDependencyCommand(packageManager, 'nodemon', { dev: true }),
      ];
    case 'fastapi':
      return [
        `mkdir -p "${targetPath}"`,
        `cd "${targetPath}"`,
        'python3 -m venv .venv',
        'source .venv/bin/activate',
        'pip install fastapi uvicorn[standard]',
      ];
    default:
      return [
        `mkdir -p "${targetPath}"`,
        `cd "${targetPath}"`,
        '# choose stack-specific bootstrap command',
      ];
  }
}

function buildQualityGates({ template, packageManager }) {
  const cmd = (npmCmd) => {
    if (packageManager === 'pnpm') return `pnpm ${npmCmd}`;
    if (packageManager === 'yarn') return `yarn ${npmCmd}`;
    if (packageManager === 'bun') return `bun run ${npmCmd}`;
    return `npm run ${npmCmd}`;
  };
  if (template.id === 'fastapi') {
    return [
      'python -m pytest -q',
    ];
  }
  const gates = [
    cmd('lint'),
    cmd('typecheck'),
    cmd('test'),
  ];
  if (template.id === 'next-ts' || template.id === 'vite-react-ts') {
    gates.push('npx playwright test --project=chromium');
  }
  return gates;
}

function checkTargetPathPolicy(targetPath, allowedRoots = DEFAULT_ALLOWED_ROOTS) {
  const resolvedTarget = path.resolve(String(targetPath || '').trim());
  const normalizedAllowed = normalizeAllowedRoots(allowedRoots);
  for (const root of normalizedAllowed) {
    const rel = path.relative(root, resolvedTarget);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return { allowed: true, matchedRoot: root, allowedRoots: normalizedAllowed };
    }
  }
  return {
    allowed: false,
    matchedRoot: '',
    allowedRoots: normalizedAllowed,
  };
}

function buildProjectBootstrapPlan(fields = {}) {
  const projectName = sanitizeProjectName(fields.프로젝트명 || fields.projectName || '');
  const goal = String(fields.목표 || fields.goal || '').trim();
  const stack = String(fields.스택 || fields.stack || '').trim();
  const basePath = String(fields.경로 || fields.path || '').trim();
  const done = String(fields.완료기준 || fields.done || '').trim();
  const initMode = normalizeInitMode(fields.초기화 || fields.initMode || '');
  const requestedAllowedRoots = fields.허용경로 || fields.allowedRoots || process.env.OPENCLAW_PROJECT_ALLOWED_ROOTS || '';
  const allowedRoots = normalizeAllowedRoots(requestedAllowedRoots);

  const template = detectTemplate(stack);
  const packageManager = detectPackageManager(stack);
  const pathPlan = normalizeTargetPath(basePath, projectName, {
    defaultRoot: DEFAULT_PROJECTS_ROOT,
  });
  const targetPath = pathPlan.targetPath;
  const policy = checkTargetPathPolicy(targetPath, allowedRoots);
  const commands = buildBootstrapCommands({
    template,
    projectName,
    targetPath,
    packageManager,
  });
  const qualityGates = buildQualityGates({ template, packageManager });
  const runCommand = template.id === 'fastapi'
    ? 'source .venv/bin/activate && uvicorn main:app --reload'
    : devCommand(packageManager);
  const warnings = [...pathPlan.warnings];
  if (!policy.allowed) {
    warnings.push(`생성 경로가 허용 루트 밖입니다: ${targetPath}`);
  }
  const approvalReasons = [];
  if (initMode === 'execute') approvalReasons.push('init_mode_execute');
  if (!policy.allowed) approvalReasons.push('path_outside_allowed_root');

  return {
    projectName,
    goal,
    stack,
    targetPath,
    template: template.id,
    templateLabel: template.label,
    packageManager,
    initMode,
    defaultProjectsRoot: DEFAULT_PROJECTS_ROOT,
    allowedRoots,
    pathPolicy: {
      allowed: policy.allowed,
      matchedRoot: policy.matchedRoot,
      basePathSource: pathPlan.basePathSource,
      basePath: pathPlan.basePath,
    },
    requiresApproval: approvalReasons.length > 0,
    approvalReasons,
    warnings,
    commands,
    qualityGates,
    runCommand,
    script: commands.join('\n'),
    checklist: [
      `프로젝트명 확인: ${projectName}`,
      `생성 경로 확인: ${targetPath}`,
      `스택 확인: ${template.label}`,
      `패키지매니저 확인: ${packageManager}`,
      `허용 경로 정책: ${policy.allowed ? `OK (${policy.matchedRoot})` : '승인 필요'}`,
      `초기화 모드: ${initMode}`,
      `완료기준 확인: ${done || '미입력'}`,
      `품질 게이트: ${qualityGates.join(' | ')}`,
    ],
  };
}

module.exports = {
  buildProjectBootstrapPlan,
  buildQualityGates,
  checkTargetPathPolicy,
  detectPackageManager,
  detectTemplate,
  normalizeAllowedRoots,
  normalizeInitMode,
  normalizeTargetPath,
  sanitizeProjectName,
};
