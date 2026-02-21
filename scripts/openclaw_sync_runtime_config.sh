#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY=0
RESTART_ON_APPLY=1

while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --apply)
      APPLY=1
      ;;
    --no-restart)
      RESTART_ON_APPLY=0
      ;;
    *)
      echo "Usage: $0 [--apply] [--no-restart]"
      exit 1
      ;;
  esac
  shift
done

canon_json_ignoring_runtime_fields() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
const value = JSON.parse(raw || '{}');

const IGNORED_PATHS = [
  ['channels', 'telegram'],
  ['gateway', 'auth', 'token'],
  ['plugins', 'entries', 'telegram', 'enabled'],
  ['skills', 'entries', 'github', 'env', 'GITHUB_TOKEN'],
];

function removePath(obj, path) {
  if (!obj || typeof obj !== 'object' || !path.length) return;
  const [head, ...rest] = path;
  if (!(head in obj)) return;
  if (rest.length === 0) {
    delete obj[head];
    return;
  }
  removePath(obj[head], rest);
  if (obj[head] && typeof obj[head] === 'object' && !Array.isArray(obj[head]) && Object.keys(obj[head]).length === 0) {
    delete obj[head];
  }
}

const normalized = JSON.parse(JSON.stringify(value));
for (const p of IGNORED_PATHS) {
  removePath(normalized, p);
}

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}
process.stdout.write(stable(normalized));
NODE
}

build_merged_payload() {
  local repo_file="$1"
  local runtime_file="$2"
  local out_file="$3"
  node - "$repo_file" "$runtime_file" "$out_file" <<'NODE'
const fs = require('fs');
const repoPath = process.argv[2];
const runtimePath = process.argv[3];
const outPath = process.argv[4];

const repo = JSON.parse(fs.readFileSync(repoPath, 'utf8') || '{}');
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8') || '{}');
const merged = JSON.parse(JSON.stringify(repo));

const PRESERVE_RUNTIME_PATHS = [
  ['channels', 'telegram'],
  ['gateway', 'auth', 'token'],
  ['plugins', 'entries', 'telegram', 'enabled'],
  ['skills', 'entries', 'github', 'env', 'GITHUB_TOKEN'],
];

function getPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

function deletePath(obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!cur || typeof cur !== 'object' || !(key in cur)) return;
    cur = cur[key];
  }
  if (cur && typeof cur === 'object') {
    delete cur[path[path.length - 1]];
  }
}

for (const p of PRESERVE_RUNTIME_PATHS) {
  const runtimeValue = getPath(runtime, p);
  if (runtimeValue === undefined) continue;
  setPath(merged, p, runtimeValue);
}

const telegramEnabled = Boolean(getPath(merged, ['channels', 'telegram', 'enabled']));
const botToken = String(getPath(merged, ['channels', 'telegram', 'botToken']) || '').trim();
if (telegramEnabled && (!botToken || /^\[REDACTED/i.test(botToken))) {
  console.error('[WARN] telegram enabled but token looks empty/redacted after merge; runtime checks recommended');
}

const gatewayToken = String(getPath(merged, ['gateway', 'auth', 'token']) || '').trim();
if (!gatewayToken || /^\[REDACTED/i.test(gatewayToken)) {
  console.error('[WARN] gateway auth token missing/redacted after merge');
}

fs.writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
NODE
}

validate_exec_policy() {
  local profile="$1"
  local file="$2"
  node - "$profile" "$file" <<'NODE'
const fs = require('fs');
const profile = String(process.argv[2] || '').trim().toLowerCase();
const file = process.argv[3];
if (!['daily', 'daily_bak'].includes(profile)) {
  process.exit(0);
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
const execCfg = cfg && cfg.tools && cfg.tools.exec && typeof cfg.tools.exec === 'object'
  ? cfg.tools.exec
  : null;
if (!execCfg) {
  console.error(`[ERROR] ${profile}: tools.exec block missing in ${file}`);
  process.exit(1);
}
const host = String(execCfg.host || '').trim().toLowerCase();
const security = String(execCfg.security || '').trim().toLowerCase();
const ask = String(execCfg.ask || '').trim().toLowerCase();
const allowsLegacy = host === 'node' && ask === 'on-miss';
const allowsStrict = host === 'gateway' && ask === 'always';
if (security !== 'allowlist' || (!allowsLegacy && !allowsStrict)) {
  console.error(
    `[ERROR] ${profile}: tools.exec must be security=allowlist and ` +
    `host=node+ask=on-miss (legacy) or host=gateway+ask=always (strict)`
  );
  process.exit(1);
}
NODE
}

declare -a PROFILES=(
  "dev:moltbot-dev:configs/dev/openclaw.json"
  "anki:moltbot-anki:configs/anki/openclaw.json"
  "research:moltbot-research:configs/research/openclaw.json"
  "daily:moltbot-daily:configs/daily/openclaw.json"
  "dev_bak:moltbot-dev-bak:configs/dev/openclaw.json"
  "anki_bak:moltbot-anki-bak:configs/anki/openclaw.json"
  "research_bak:moltbot-research-bak:configs/research/openclaw.json"
  "daily_bak:moltbot-daily-bak:configs/daily/openclaw.json"
)

echo "[openclaw-sync] mode: $([[ "$APPLY" -eq 1 ]] && echo apply || echo check)"
echo "[openclaw-sync] root: $ROOT"
echo "[openclaw-sync] restart_on_apply: $([[ "$RESTART_ON_APPLY" -eq 1 ]] && echo yes || echo no)"

drift_count=0
sync_count=0
restart_count=0
error_count=0
skip_count=0

for row in "${PROFILES[@]}"; do
  IFS=':' read -r profile container repo_rel <<<"$row"
  repo_file="$ROOT/$repo_rel"

  if [[ ! -f "$repo_file" ]]; then
    echo "[ERROR] $profile repo config missing: $repo_file"
    error_count=$((error_count + 1))
    continue
  fi
  if ! validate_exec_policy "$profile" "$repo_file"; then
    error_count=$((error_count + 1))
    continue
  fi

  if ! docker ps -a --format '{{.Names}}' | grep -qx "$container"; then
    echo "[SKIP] $profile container not found: $container"
    skip_count=$((skip_count + 1))
    continue
  fi

  runtime_tmp="$(mktemp)"
  repo_tmp="$(mktemp)"
  merged_tmp="$(mktemp)"

  if ! docker exec "$container" sh -lc 'cat /home/node/.openclaw/openclaw.json' > "$runtime_tmp" 2>/dev/null; then
    echo "[ERROR] $profile cannot read runtime config from $container:/home/node/.openclaw/openclaw.json"
    rm -f "$runtime_tmp" "$repo_tmp" "$merged_tmp"
    error_count=$((error_count + 1))
    continue
  fi

  cp "$repo_file" "$repo_tmp"

  repo_canon="$(canon_json_ignoring_runtime_fields "$repo_tmp" || true)"
  runtime_canon="$(canon_json_ignoring_runtime_fields "$runtime_tmp" || true)"

  if [[ -z "$repo_canon" || -z "$runtime_canon" ]]; then
    echo "[ERROR] $profile failed to parse JSON for comparison"
    rm -f "$runtime_tmp" "$repo_tmp" "$merged_tmp"
    error_count=$((error_count + 1))
    continue
  fi

  if [[ "$repo_canon" == "$runtime_canon" ]]; then
    echo "[OK] $profile runtime matches repo"
    rm -f "$runtime_tmp" "$repo_tmp" "$merged_tmp"
    continue
  fi

  echo "[DRIFT] $profile runtime differs from repo"
  drift_count=$((drift_count + 1))

  if [[ "$APPLY" -eq 1 ]]; then
    if ! build_merged_payload "$repo_tmp" "$runtime_tmp" "$merged_tmp"; then
      echo "[ERROR] $profile failed to build merged runtime config"
      rm -f "$runtime_tmp" "$repo_tmp" "$merged_tmp"
      error_count=$((error_count + 1))
      continue
    fi
    if docker exec -i "$container" sh -lc 'tmp="/home/node/.openclaw/openclaw.json.sync.$$"; cat > "$tmp" && mv "$tmp" /home/node/.openclaw/openclaw.json' < "$merged_tmp" \
      && docker exec "$container" sh -lc 'chmod 600 /home/node/.openclaw/openclaw.json || true; chown node:node /home/node/.openclaw/openclaw.json || true' >/dev/null 2>&1; then
      echo "[SYNCED] $profile updated runtime config on $container (runtime-managed fields preserved)"
      sync_count=$((sync_count + 1))
      if [[ "$RESTART_ON_APPLY" -eq 1 ]]; then
        if docker restart "$container" >/dev/null 2>&1; then
          echo "[RESTARTED] $profile restarted $container"
          restart_count=$((restart_count + 1))
        else
          echo "[ERROR] $profile failed to restart $container after sync"
          error_count=$((error_count + 1))
        fi
      fi
    else
      echo "[ERROR] $profile failed to sync runtime config to $container"
      error_count=$((error_count + 1))
    fi
  fi

  rm -f "$runtime_tmp" "$repo_tmp" "$merged_tmp"
done

echo "[openclaw-sync] summary: drift=$drift_count synced=$sync_count restarted=$restart_count errors=$error_count skipped=$skip_count"

if [[ "$error_count" -gt 0 ]]; then
  exit 1
fi

if [[ "$drift_count" -gt 0 && "$APPLY" -eq 0 ]]; then
  exit 2
fi

exit 0
