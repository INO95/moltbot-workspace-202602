#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS="$(date +%Y%m%d_%H%M%S)"
PRIVATE_ROOT="${MOLTBOT_PRIVATE_DIR:-$(cd "$ROOT/.." && pwd)/Moltbot_Private}"
BK_DIR="$PRIVATE_ROOT/backups/openclaw/main_$TS"

mkdir -p "$BK_DIR/configs" "$BK_DIR/data" "$BK_DIR/meta"

# Safety: backup path must not be inside public workspace
case "$BK_DIR" in
  "$ROOT"/*)
    echo "ERROR: backup path must be private (outside workspace): $BK_DIR" >&2
    exit 1
    ;;
esac

rsync -a "$ROOT/configs/main/" "$BK_DIR/configs/main/"
rsync -a "$ROOT/data/" "$BK_DIR/data/"
cp "$ROOT/docker-compose.yml" "$BK_DIR/meta/docker-compose.yml"
cp "$ROOT/package.json" "$BK_DIR/meta/package.json"

docker inspect moltbot-main > "$BK_DIR/meta/moltbot-main.inspect.json"
docker image inspect openclaw:local > "$BK_DIR/meta/openclaw-local.image.inspect.json"

# Seed sub profile as warm standby backup runtime
mkdir -p "$ROOT/configs/sub1"
rsync -a --delete "$ROOT/configs/main/" "$ROOT/configs/sub1/"
node "$ROOT/scripts/openclaw_config_secrets.js" inject sub1 >/dev/null

cat > "$BK_DIR/meta/backup.json" <<JSON
{
  "timestamp": "$TS",
  "snapshotDir": "$BK_DIR",
  "privateRoot": "$PRIVATE_ROOT",
  "seededSubConfig": "$ROOT/configs/sub1/openclaw.json",
  "notes": "sub1 seeded from main and telegram disabled for standby backup"
}
JSON

cd "$ROOT"
docker compose --profile sub up -d openclaw-sub1 >/dev/null

echo "Backup created: $BK_DIR"
echo "Standby container: moltbot-sub1 (port 18889)"
