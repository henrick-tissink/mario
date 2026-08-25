#!/usr/bin/env bash
# The fold runs in-process with no external scheduler, so nothing outside the
# process knows whether it ran. This is that thing. Cron every 15 minutes.
set -uo pipefail
URL="${MARIO_STATUS_URL:-http://127.0.0.1:8787/statusz}"

S="$(curl -sf --max-time 5 "$URL")" || { echo "mario: /statusz unreachable"; exit 1; }
echo "$S" | node -e '
let b=""; process.stdin.on("data",d=>b+=d).on("end",()=>{
  const s=JSON.parse(b);
  if (s.ok) process.exit(0);
  console.log("mario UNWELL: " + (s.warnings.join("; ") || s.db.error || "unknown"));
  process.exit(1);
});'
