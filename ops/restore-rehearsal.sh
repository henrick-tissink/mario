#!/usr/bin/env bash
# Run ONCE in week 1, then quarterly. Twenty minutes, and it is the difference
# between having backups and believing you do.
#
# NOTE: the tokens table is inside the snapshot. Restoring resurrects endpoints
# revoked since, and DESTROYS every endpoint minted since — those developers'
# hooks then 401, and because the hook fails open they see nothing at all and
# simply stop being recorded. After any real restore, announce it and have
# people re-run /setup.
set -euo pipefail
SNAP="${1:?usage: restore-rehearsal.sh <mario-*.db.gz>}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

gunzip -c "$SNAP" > "$WORK/mario.db"
# VACUUM INTO output has no -wal/-shm sidecars. If one appears, the backup was
# taken the wrong way.
[ -e "$WORK/mario.db-wal" ] && { echo "unexpected WAL sidecar — bad backup"; exit 1; }

sqlite3 "$WORK/mario.db" <<'SQL'
PRAGMA integrity_check;
SELECT 'migrations:     ' || group_concat(name) FROM migrations;
SELECT 'live endpoints: ' || COUNT(*) FROM tokens WHERE revoked_at IS NULL;
SELECT 'projects:       ' || COUNT(*) FROM projects;
SELECT 'open findings:  ' || COUNT(*) FROM findings WHERE status = 'open';
SELECT 'state docs:     ' || COUNT(*) FROM state;
SQL
echo "rehearsal complete: $WORK/mario.db opened, schema intact"
