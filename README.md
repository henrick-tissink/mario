# Mario

[![CI](https://github.com/henrick-tissink/mario/actions/workflows/ci.yml/badge.svg)](https://github.com/henrick-tissink/mario/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a)](https://nodejs.org)

Your agent tells the team what it's doing, so other agents don't collide with you — and so the
defects it notices in passing don't get lost.

Three things it does:

1. **Warns you before you collide.** When your agent starts work, it already knows Henry has been in
   `src/pricing/` for the last 40 minutes, on `fix/rounding`.
2. **Catches drive-by findings.** Your agent notices something broken that's out of scope, records it
   in one line, and moves on. It's on the findings list for whoever's next in that code.
3. **Summarises what happened.** Every 4h **Luigi** folds the raw event stream into a short state
   document per project, so joining a project doesn't mean reading 200 events.

No tickets. Nothing to fill in. Emission is done by hooks, so the mechanical half happens whether or
not you remember; the judgment half — findings, and a `done` worth reading — comes from the prompt
block in `docs/agent-rules.md`.

## Install

```sh
./install.sh <your-endpoint-url>
```

Get your endpoint from the `/setup` page. It's personal to you and it's how the system knows who you
are, so don't share it or paste it in a channel. A shared endpoint doesn't fail loudly — it silently
attributes your work to whoever it was minted for.

`install.sh` needs **Node 22+** (or Bun — the CLI is dependency-free ESM and runs on either) and
resolves whichever it finds to an absolute path, so hooks fire even when a version manager isn't on
the hook's `PATH`. It installs the `mario` CLI into
`~/.local/bin`, writes `~/.config/mario/config.json` (mode 0600 — it holds a bearer credential), and
merges hooks into `~/.claude/settings.json` and `~/.codex/config.toml`. Both are backed up with a
timestamp before being touched, and re-running never overwrites an earlier backup.

**If you use Codex, there's one manual step.** Codex gates hooks behind a trust prompt and fails
*silently* if it hasn't been granted — no error, no log, nothing fires. Run `codex` interactively
once after installing and accept the prompt. Claude Code needs nothing extra.

## What gets sent

| When | What |
|---|---|
| Your agent edits a file | repo, branch, file path, your name |
| Your agent finishes a turn | the first line of its closing message |
| Your agent finds something broken | the one-line summary it wrote |

**Only for repos in scope.** Scope is an allow-list of repo prefixes. Anything else — personal repos,
third-party clones — never leaves your machine: the CLI refuses before making a network call, and the
server rejects it independently. Both fail closed, so an unconfigured install emits nothing rather
than everything.

Run `mario scope` in any repo to see whether it's in or out.

There are deliberately **no per-person statistics** anywhere in this system: no leaderboards, no
time-on-task, no counts per developer. Every view is organised by project and code area. Your name
appears only as "who is currently in this file", which is the collision signal and nothing else.

## Using it

```sh
mario check src/pricing/refunds.ts   # who else is here, and what's known broken
mario finding "retry loop has no backoff" src/settlement/worker.ts
mario findings src/pricing/          # open findings, most-reported first
mario close a1b2c3d4 "added backoff"
mario who                            # who's active where, and are folds running
mario scope                          # is this repo in scope?
```

Your agent can do all of this itself over MCP — `mario_check`, `mario_emit`, `mario_state`,
`mario_findings`, `mario_close`. See `docs/agent-rules.md` for the prompt block that tells it when to
use them.

## Turning it off

Delete the `mario` entries from `~/.claude/settings.json` / `~/.codex/config.toml`, or just
`rm ~/.config/mario/config.json`. There is exactly one config file and no fallback, so removing it
really does stop emission. The CLI then exits 0 silently and nothing else breaks — it never fails a
turn, by design.

## Running the server

```sh
npm install
npm test           # 140 tests
npm start          # tsx src/index.ts
npm run dev        # watch mode
```

Node 22+, `better-sqlite3`, Hono. `npm run typecheck` runs `tsc --noEmit`. `docker build .` produces the deployable image; see `docs/deploy.md`.

| Variable | Default | Meaning |
|---|---|---|
| `MARIO_DB` | `mario.db` | SQLite file |
| `MARIO_ALLOWED_REPOS` | *(empty)* | Comma-separated repo prefixes permitted to emit. Empty means nothing emits. |
| `MARIO_DECAY_MINUTES` | `120` | How long presence counts as an active claim. The one tuning knob. |
| `MARIO_STATE_MAX_LINES` | `15` | Hard cap on a state document. |
| `MARIO_MAX_SUMMARY` | `280` | Hard cap on any caller-supplied summary. |
| `MARIO_ADMINS` | *(empty)* | Comma-separated admin emails. |
| `MARIO_ACCESS_TEAM_DOMAIN` / `MARIO_ACCESS_AUD` | — | Cloudflare Access verification. |
| `ANTHROPIC_API_KEY` | — | Absent ⇒ folds are skipped and events accumulate. |
| `MARIO_FOLD_MODEL` | `claude-opus-5` | Luigi's model. |
| `MARIO_DEV_ACTOR` | — | **Local dev only.** Bypasses browser auth entirely. |
| `MARIO_HOOK_TIMEOUT_MS` | `250` | Client-side budget for the synchronous SessionStart hook. |

Deployment is a single process behind a Cloudflare Tunnel with Access in front, as two Access
applications: the hostname with an empty path (SSO), plus a second scoped to path `a` carrying a
Bypass policy — an agent cannot complete an interactive login. Use path `a` with **no wildcard**;
`/a/*` is not documented to match the multi-segment URLs agents use. The origin verifies the Access
JWT itself rather than trusting that Access ran in front of it.

See `docs/design.md` for why it is shaped this way.
