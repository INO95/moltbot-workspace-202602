#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS="$(date +%Y%m%d_%H%M%S)"
PRIVATE_ROOT="${MOLTBOT_PRIVATE_DIR:-$(cd "$ROOT/.." && pwd)/Moltbot_Private}"
BK_DIR="$PRIVATE_ROOT/backups/openclaw/dev_$TS"

mkdir -p "$BK_DIR/configs" "$BK_DIR/data" "$BK_DIR/meta"

# Safety: backup path must not be inside public workspace
case "$BK_DIR" in
  "$ROOT"/*)
    echo "ERROR: backup path must be private (outside workspace): $BK_DIR" >&2
    exit 1
    ;;
esac

for profile in dev anki research daily; do
  if [[ -d "$ROOT/configs/$profile" ]]; then
    rsync -a "$ROOT/configs/$profile/" "$BK_DIR/configs/$profile/"
  fi
done

rsync -a "$ROOT/data/" "$BK_DIR/data/"
cp "$ROOT/docker-compose.yml" "$BK_DIR/meta/docker-compose.yml"
cp "$ROOT/package.json" "$BK_DIR/meta/package.json"

for container in moltbot-dev moltbot-anki moltbot-research moltbot-daily; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$container"; then
    docker inspect "$container" > "$BK_DIR/meta/${container}.inspect.json"
  fi
done

if docker image inspect openclaw:local-dockercli >/dev/null 2>&1; then
  docker image inspect openclaw:local-dockercli > "$BK_DIR/meta/openclaw-local-dockercli.image.inspect.json"
fi

cat > "$BK_DIR/meta/backup.json" <<JSON
{
  "timestamp": "$TS",
  "snapshotDir": "$BK_DIR",
  "privateRoot": "$PRIVATE_ROOT",
  "mode": "cold-standby",
  "backupProfiles": ["dev_bak", "anki_bak", "research_bak", "daily_bak"],
  "notes": "Backup containers remain stopped by default. Enable and start only during failover."
}
JSON

echo "Backup created: $BK_DIR"
echo "Cold standby profiles: dev_bak, anki_bak, research_bak, daily_bak (not started)"
