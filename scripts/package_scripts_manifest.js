#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { checkPackageScripts } = require('./check_package_scripts');

const ROOT = path.resolve(__dirname, '..');

function classifyScript(name, command) {
  if (name.startsWith('test')) return 'test';
  if (name.startsWith('ops')) return 'ops';
  if (name.startsWith('runtime')) return 'runtime';
  if (name.startsWith('cron')) return 'cron';
  if (name.startsWith('check') || name.startsWith('fix')) return 'check';
  if (name.startsWith('anki')) return 'anki';
  if (name.startsWith('news')) return 'news';
  if (name.startsWith('notion')) return 'notion';
  if (/archive|legacy|old/i.test(command)) return 'review';
  return 'other';
}

function splitCommandRefs(command) {
  return String(command || '')
    .split(/\s*&&\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildPackageScriptsManifest(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const packagePath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const check = checkPackageScripts({ root, packageJson: pkg });
  const entries = Object.entries(scripts).map(([name, command]) => {
    const refs = splitCommandRefs(command);
    return {
      name,
      category: classifyScript(name, command),
      command,
      stepCount: refs.length,
      reviewCandidate: refs.length >= 6 || /archive|legacy|old/i.test(command),
    };
  });
  const categories = {};
  for (const entry of entries) {
    categories[entry.category] = (categories[entry.category] || 0) + 1;
  }
  return {
    ok: check.ok,
    generatedAt: new Date().toISOString(),
    totalScripts: entries.length,
    categories,
    reviewCandidates: entries.filter((entry) => entry.reviewCandidate),
    issues: check.issues,
    scripts: entries,
  };
}

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    write: argv.includes('--write'),
  };
}

function printText(manifest) {
  console.log('package scripts manifest');
  console.log(`total: ${manifest.totalScripts}`);
  console.log(`ok: ${manifest.ok}`);
  console.log('categories:');
  for (const [name, count] of Object.entries(manifest.categories).sort()) {
    console.log(`- ${name}: ${count}`);
  }
  console.log(`review candidates: ${manifest.reviewCandidates.length}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = buildPackageScriptsManifest();
  if (args.write) {
    const outPath = path.join(ROOT, 'reports', 'package_scripts_manifest.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  if (args.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    printText(manifest);
  }
  if (!manifest.ok) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildPackageScriptsManifest,
  classifyScript,
};
