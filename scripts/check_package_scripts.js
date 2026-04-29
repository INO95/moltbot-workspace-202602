#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function unquote(value) {
  const raw = String(value || '').trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function collectScriptFileRefs(command) {
  const refs = [];
  const re = /\b(?:node|bash|sh)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g;
  let match = null;
  while ((match = re.exec(String(command || '')))) {
    const ref = unquote(match[1]);
    if (ref.startsWith('scripts/')) refs.push(ref);
  }
  return refs;
}

function collectNpmRunRefs(command) {
  const refs = [];
  const re = /\bnpm\s+run\s+(?:(?:-[^\s]+\s+)*)("[^"]+"|'[^']+'|[^\s;&|]+)/g;
  let match = null;
  while ((match = re.exec(String(command || '')))) {
    const ref = unquote(match[1]);
    if (ref && !ref.startsWith('-')) refs.push(ref);
  }
  return refs;
}

function collectAppsRefs(command) {
  const refs = [];
  const re = /\bapps\/[^\s;&|"'`]+/g;
  let match = null;
  while ((match = re.exec(String(command || '')))) {
    refs.push(match[0]);
  }
  return refs;
}

function readPackageJson(packagePath) {
  return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
}

function checkPackageScripts(options = {}) {
  const root = path.resolve(options.root || path.resolve(__dirname, '..'));
  const packagePath = path.resolve(options.packagePath || path.join(root, 'package.json'));
  const pkg = options.packageJson || readPackageJson(packagePath);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const issues = [];

  for (const [name, command] of Object.entries(scripts)) {
    for (const ref of collectScriptFileRefs(command)) {
      if (!fs.existsSync(path.join(root, ref))) {
        issues.push({
          type: 'missing_script_file',
          script: name,
          ref,
        });
      }
    }
    for (const ref of collectAppsRefs(command)) {
      issues.push({
        type: 'apps_ref_not_allowed',
        script: name,
        ref,
      });
    }
    for (const ref of collectNpmRunRefs(command)) {
      if (!Object.prototype.hasOwnProperty.call(scripts, ref)) {
        issues.push({
          type: 'missing_npm_script',
          script: name,
          ref,
        });
      }
    }
  }

  const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : [];
  for (const workspace of workspaces) {
    const raw = String(workspace || '').trim();
    if (!raw) continue;
    if (raw === 'apps/*' || raw.startsWith('apps/')) {
      issues.push({
        type: 'apps_workspace_not_allowed',
        ref: raw,
      });
      continue;
    }
    const base = raw.endsWith('/*') ? raw.slice(0, -2) : raw;
    if (base && !fs.existsSync(path.join(root, base))) {
      issues.push({
        type: 'missing_workspace_base',
        ref: raw,
      });
    }
  }

  return {
    ok: issues.length === 0,
    root,
    checkedScripts: Object.keys(scripts).length,
    issues,
  };
}

function main() {
  const result = checkPackageScripts();
  const output = JSON.stringify(result, null, 2);
  if (result.ok) {
    console.log(output);
  } else {
    console.error(output);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  checkPackageScripts,
  collectScriptFileRefs,
  collectNpmRunRefs,
  collectAppsRefs,
};
