#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function dirSizeBytes(dirPath) {
  let stat = null;
  try {
    stat = fs.lstatSync(dirPath);
  } catch (_) {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath)) {
    total += dirSizeBytes(path.join(dirPath, entry));
  }
  return total;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function topLevelNodeModules(root) {
  const nodeModules = path.join(root, 'node_modules');
  if (!fs.existsSync(nodeModules)) return [];
  const out = [];
  for (const name of fs.readdirSync(nodeModules)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const scopedName of fs.readdirSync(path.join(nodeModules, name))) {
        out.push(`${name}/${scopedName}`);
      }
    } else {
      out.push(name);
    }
  }
  return out;
}

function buildDependencyAuditLight(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const pkg = readJson(path.join(root, 'package.json'), {});
  const lock = readJson(path.join(root, 'package-lock.json'), {});
  const directDeps = Object.keys(pkg.dependencies || {}).sort();
  const devDeps = Object.keys(pkg.devDependencies || {}).sort();
  const lockPackages = lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
  const versionByName = new Map();
  for (const [pkgPath, meta] of Object.entries(lockPackages)) {
    if (!pkgPath.startsWith('node_modules/')) continue;
    const name = pkgPath.replace(/^node_modules\//, '');
    if (!name || name.includes('/node_modules/')) continue;
    const version = String(meta && meta.version ? meta.version : '').trim();
    if (!version) continue;
    if (!versionByName.has(name)) versionByName.set(name, new Set());
    versionByName.get(name).add(version);
  }
  const duplicateVersions = [...versionByName.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({ name, versions: [...versions].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sizes = topLevelNodeModules(root)
    .map((name) => ({
      name,
      sizeBytes: dirSizeBytes(path.join(root, 'node_modules', name)),
    }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 20);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    directDependencyCount: directDeps.length,
    devDependencyCount: devDeps.length,
    lockPackageCount: Object.keys(lockPackages).length,
    directDependencies: directDeps,
    devDependencies: devDeps,
    duplicateVersions,
    largestInstalledPackages: sizes,
  };
}

function main() {
  const json = process.argv.includes('--json');
  const result = buildDependencyAuditLight();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('dependency audit light');
    console.log(`direct deps: ${result.directDependencyCount}`);
    console.log(`dev deps: ${result.devDependencyCount}`);
    console.log(`lock packages: ${result.lockPackageCount}`);
    console.log(`duplicate versions: ${result.duplicateVersions.length}`);
    console.log('largest installed packages:');
    for (const row of result.largestInstalledPackages.slice(0, 10)) {
      console.log(`- ${row.name}: ${row.sizeBytes} bytes`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildDependencyAuditLight,
};
