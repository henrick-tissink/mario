# Why Mario is shaped this way

Mario is a rewrite of an earlier coordination tool of mine. That one worked, but a close audit of it
turned up a long list of defects, and the ones that actually shaped this design are recorded below —
partly so the reasoning survives, and partly so I do not cheerfully rebuild any of them.

## Three tables, not one

The previous system kept a single `events` table holding presence, findings and narrative, and paid
for it four times: a `kind != 'finding'` filter repeated in every fold query, presence collapsed in
application code, a `status` column meaningful for exactly one kind, and an invariant — "findings are
never compacted" — that survived only as a comment.

Each table here has exactly one lifecycle:

| table | lifecycle |
|---|---|
| `presence` | live and mutable — upserted in place, expires by time, swept into history |
| `findings` | durable — deduped on write, never folded away |
| `events` | narrative — append-only, folded and stamped |

Three purpose-built tables are simpler than one general one, not more complex.

## Correct by construction, not by care

**Presence.** The old collapse was `SELECT` then `UPDATE`. The file-edit hook is installed
async, so two hook processes in one session routinely overlapped and the later write clobbered the
earlier one — losing exactly the paths collision detection exists to report. Here the primary key is
`(actor, session, project)` and a write is one upsert that unions the path arrays *in SQL*. There is
no read-then-write to race. `test/race.test.ts` interleaves 200 writes across two connections to one
WAL file and asserts nothing is lost.

**Project identity.** Identity was `slugify(last path segment)`, so `acme/api` and
`acme-labs/api` silently became one project — pooling their events and inventing collisions between
unrelated codebases. Identity now spans owner and name.

**Closing findings.** The id went straight into `id LIKE ? || '%'`, so `id: ""` became
`LIKE '%'` and closed every finding in the database, reporting success. Now: a minimum length, an
escaped LIKE, a match-count check, and a status guard.

**The fold.** The old fold read `LIMIT 500` but stamped everything older than the cutoff,
so surplus events were marked consumed without ever reaching the model. Luigi stamps bounded by
`folded_thru` — the maximum timestamp it actually read.

**Escaping.** One field was escaped; repo paths, project and actor names went into `innerHTML`
raw, all from agent-supplied payloads, on a page served from the same origin as the endpoint-minting
API. The client script now builds DOM nodes and sets `textContent`; there is no HTML string
concatenation to forget.

## What is load-bearing

- **The token is the identity.** Nothing on the wire carries an `actor`.
- **One decay number** governs both collision expiry and when presence becomes history.
- **A failed fold stamps nothing** — events stay and the next run retries. An empty document is
  logged, not silently skipped.
- **Findings are never folded away.** Luigi counts them; it never consumes them.
- **Hard caps on every output** — 3 collisions, 2 findings, 15 state lines — enforced in code, not
  only in a prompt.
- **The client never fails the caller.** Exit 0 always, silent in hook mode, 200 on any readable
  emit body, advisory warnings that never block.
- **Scope is an allow-list enforced on both ends**, failing closed when unconfigured.
- **Repo is a property of the file, not the session.**
- **No per-person aggregates.** Not a gap; a constraint that keeps the data honest.

## Deliberate non-features

No Slack broadcast. The predecessor had one and deleted it rather than leaving it dormant, precisely
so nobody could switch it back on without knowing it had been rejected: *"pushing state at humans
inverts the design — this is pulled on demand by agents."* Six folds a day across N projects is 6N
low-signal messages.

## Stack

Node 22 + Hono + SQLite (`better-sqlite3`, WAL), one process, one file. Chosen for two properties the
predecessor lacked: real interactive transactions, and a test loop fast enough that tests actually
get written — a fresh in-memory database with the full schema is effectively free, and the whole
suite runs in well under a second. Writing those tests caught four real bugs in this codebase before
it ever served a request.

`src/db.ts` exposes a small `DB` interface (`query/exec/transaction/close`) and is the only place the
driver is named. That seam was built on the first day and immediately earned itself: the project
started on `bun:sqlite` and moved to `better-sqlite3` on Node by rewriting one file, converting two
upserts to named parameters, and swapping the test-runner import. Every call site was untouched.

Two platform assumptions were verified empirically rather than assumed: SQLite supports partial
unique indexes, upserts targeting them with correct `RETURNING`, interactive transactions and
`json_each` prefix filters; the MCP SDK ships a web-standard `Request`→`Response` transport that
mounts directly in Hono. Two pragmas (`busy_timeout`, `foreign_keys`) are per-connection and do not
persist in the file, so there is exactly one `open()` and no other constructor.

Driver quirks worth knowing, each learned the hard way and each now guarded by a test:

- **Numbered placeholders (`?1`, `?2`) are rejected.** Use plain `?` or named `@name` parameters.
  This fails only at runtime, so `test/sql.test.ts` greps the source for them.
- **`.get()` returns `undefined`, not `null`,** on a miss. Every call site uses optional chaining.
- **A bare transaction is `BEGIN DEFERRED`.** Everything read-then-write uses `.immediate()`.
- **`LIKE` needs an explicit `ESCAPE`.** Also structurally enforced by `test/sql.test.ts`.
