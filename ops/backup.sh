#!/usr/bin/env bash
# Snapshot a LIVE WAL database, correctly.
#
# `cp mario.db` is wrong: it copies the main file without the WAL, producing a
# file that opens cleanly, looks fine, and is missing every transaction since the
# last checkpoint. VACUUM INTO reads through the WAL and writes one consistent,
# compacted file with no sidecars — no quiescing, no downtime.
set -euo pipefail

DB="${MARIO_DB:-/data/mario.db}"
DEST="${1:-/data/backups}"
KEEP="${KEEP:-24}"
OUT="$DEST/mario-$(date -u +%Y%m%dT%H%M%SZ).db"

mkdir -p "$DEST"

# busy_timeout because VACUUM INTO takes a read lock and the service writes on
# every check (touchToken). This takes well under a second.
sqlite3 "$DB" "PRAGMA busy_timeout = 30000; VACUUM INTO '$OUT';"

# Verify before it counts as a backup. An unverified snapshot is a hope.
if ! sqlite3 "$OUT" 'PRAGMA integrity_check;' | grep -qx 'ok'; then
  echo "backup: integrity_check FAILED, discarding $OUT" >&2
  rm -f "$OUT"; exit 1
fi

# A structurally valid but empty database also passes integrity_check.
TOKENS="$(sqlite3 "$OUT" 'SELECT COUNT(*) FROM tokens WHERE revoked_at IS NULL;')"
echo "backup: $OUT ($TOKENS live endpoints)"

gzip -9 "$OUT"
ls -1t "$DEST"/mario-*.db.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
