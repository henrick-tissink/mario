#!/usr/bin/env bash
# Installs the mario CLI and wires it into Claude Code and Codex.
#
# Idempotent, and safe to re-run. Three things the previous generation of this
# script got wrong, fixed here:
#
#   1. Backups were unconditional, so a second run overwrote the pristine backup
#      with the already-hooked file. Backups are now timestamped and never
#      clobbered.
#   2. The Codex block was rewritten by truncating everything from a marker to
#      end-of-file, silently deleting any user config that happened to sit below
#      it. It is now replaced between a BEGIN/END marker pair.
#   3. Hooks invoked a bare `node`, which is not on PATH when a version manager
#      is in play — hooks simply never fired. The runtime is now resolved to an
#      absolute path at install time.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENDPOINT="${1:-}"
BIN="$HOME/.local/bin"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ -z "$ENDPOINT" ]; then
  echo "usage: ./install.sh <your-endpoint-url>"
  echo "  Get yours from the /setup page. It is personal to you and identifies you"
  echo "  to the system, so do not share it or paste it into a channel."
  exit 1
fi

# Resolve a runtime once, absolutely. The CLI is dependency-free ESM and runs
# under either; node is preferred because it is what the server runs on.
RUNTIME=""
for candidate in node bun; do
  if command -v "$candidate" >/dev/null 2>&1; then
    RUNTIME="$(command -v "$candidate")"
    break
  fi
done
[ -n "$RUNTIME" ] || { echo "mario needs node (or bun) on PATH"; exit 1; }
echo "✓ runtime: $RUNTIME"

CLI="$REPO/cli/mario.mjs"
chmod +x "$CLI"
mkdir -p "$BIN"
printf '#!/bin/sh\nexec %s %s "$@"\n' "$(printf %q "$RUNTIME")" "$(printf %q "$CLI")" > "$BIN/mario"
chmod +x "$BIN/mario"
echo "✓ CLI at $BIN/mario"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "  ! $BIN is not on your PATH — add it to your shell profile" ;;
esac

HOOK_CMD="$BIN/mario hook"
"$BIN/mario" setup "$ENDPOINT"

backup() {
  [ -f "$1" ] || return 0
  cp "$1" "$1.mario-$STAMP"
  echo "  backup: $1.mario-$STAMP"
}

# --- Claude Code -------------------------------------------------------------
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ]; then
  backup "$CLAUDE_SETTINGS"
  "$RUNTIME" - "$CLAUDE_SETTINGS" "$HOOK_CMD" <<'JS'
const fs = require('node:fs');
const [path, cmd] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(path, 'utf8'));
d.hooks ??= {};
// Strip every prior mario entry ACROSS ALL EVENTS, not only the ones we are
// about to write — otherwise an entry left under an event an older installer
// used survives every re-run.
for (const event of Object.keys(d.hooks)) {
  if (!Array.isArray(d.hooks[event])) continue;
  for (const group of d.hooks[event]) {
    if (Array.isArray(group.hooks)) {
      group.hooks = group.hooks.filter((x) => !String(x.command ?? '').includes('mario hook'));
    }
  }
  d.hooks[event] = d.hooks[event].filter((g) => g.hooks?.length);
  if (!d.hooks[event].length) delete d.hooks[event];
}
const put = (event, entry) => ((d.hooks[event] ??= []).push(entry));
// SessionStart is synchronous on purpose — its stdout is the injected context.
put('SessionStart', { hooks: [{ type: 'command', command: cmd }] });
put('PostToolUse', {
  matcher: 'Edit|Write|NotebookEdit',
  hooks: [{ type: 'command', command: cmd, async: true }],
});
put('Stop', { hooks: [{ type: 'command', command: cmd, async: true }] });
fs.writeFileSync(path, JSON.stringify(d, null, 2) + '\n');
JS
  echo "✓ Claude Code hooks installed"
else
  echo "  - no $CLAUDE_SETTINGS, skipping Claude Code"
fi

# --- Codex -------------------------------------------------------------------
CODEX_CONFIG="$HOME/.codex/config.toml"
if [ -f "$CODEX_CONFIG" ]; then
  backup "$CODEX_CONFIG"
  "$RUNTIME" - "$CODEX_CONFIG" "$HOOK_CMD" <<'JS'
const fs = require('node:fs');
const [path, cmd] = process.argv.slice(2);
const BEGIN = '# --- mario:begin ---';
const END = '# --- mario:end ---';
const src = fs.readFileSync(path, 'utf8');

// Replace only what is BETWEEN the markers. Anything a user put after our block
// is preserved, which is the whole point.
const block = [
  BEGIN,
  '# Codex sends the same stdin fields as Claude Code and honours',
  '# hookSpecificOutput.additionalContext, so one CLI serves both harnesses.',
  '# Codex gates hooks behind persisted trust: run `codex` interactively once and',
  '# accept the prompt, or none of this fires (silently).',
  '',
  '[[hooks.SessionStart]]',
  '',
  '[[hooks.SessionStart.hooks]]',
  'type = "command"',
  `command = ${JSON.stringify(cmd)}`,
  'timeout = 6',
  '',
  '# Codex\'s edit tool is `apply_patch`; it carries the patch envelope in',
  '# tool_input.command rather than a file_path field.',
  '[[hooks.PostToolUse]]',
  'matcher = "apply_patch"',
  '',
  '[[hooks.PostToolUse.hooks]]',
  'type = "command"',
  `command = ${JSON.stringify(cmd)}`,
  'timeout = 6',
  '',
  '[[hooks.Stop]]',
  '',
  '[[hooks.Stop.hooks]]',
  'type = "command"',
  `command = ${JSON.stringify(cmd)}`,
  'timeout = 6',
  END,
].join('\n');

const i = src.indexOf(BEGIN);
const j = src.indexOf(END);
let out;
if (i !== -1 && j > i) out = src.slice(0, i) + block + src.slice(j + END.length);
else out = src.replace(/\s*$/, '') + '\n\n' + block + '\n';
fs.writeFileSync(path, out);
JS
  echo "✓ Codex hooks installed"
  echo "  ! Run 'codex' interactively once and accept the hook-trust prompt."
  echo "    Until you do, Codex hooks fire nothing and report nothing."
else
  echo "  - no $CODEX_CONFIG, skipping Codex"
fi

echo
"$BIN/mario" scope
echo
echo "Done. Try 'mario check' in a work repo."
