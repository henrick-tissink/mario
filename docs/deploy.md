# Deploying Mario

One process, one SQLite file, behind a Cloudflare Tunnel with Access in front.

Everything in this document that says CERTAIN was verified against primary Cloudflare
documentation; the two items marked VERIFY are five-minute tests that must be done before cutover.

## Cloudflare Access: two applications, not one

Access is an edge policy bound to a hostname and path, not to an origin type — it works identically
in front of a Tunnel as in front of a Worker (CERTAIN).

| App | Hostname / Path | Policy |
|---|---|---|
| A — browser | `mario.example.com`, **empty path** | Allow, your IdP |
| B — agents | `mario.example.com`, path `a` | **Bypass** |

Two details that are easy to get wrong:

- **Use path `a` with no wildcard, not `/a/*`.** The docs confirm `/alpha/*` covers `/alpha/one` but
  never state it covers `/alpha/one/two` — and agent URLs are `/a/<token>/<anything>`. Policy
  inheritance from a non-wildcard parent path *is* documented. **VERIFY** with a deep URL
  (`/a/<token>/x/y/z`) before cutover.
- **App B has its own AUD tag.** Verify browser JWTs against **app A's** AUD only. Set
  `MARIO_ACCESS_AUD` to app A.

Access sends the identity to the origin as a `Cf-Access-Jwt-Assertion` **request header**, injected
at the edge after policy evaluation — the tunnel is transport and plays no part (CERTAIN). Mario
reads that header first and treats the `CF_Authorization` cookie only as a fallback, because
Cloudflare states the cookie "is not guaranteed to be passed."

On the bypassed `/a` path no token is issued and no header is added. That is the intent: identity
there comes solely from the URL token, and the `/a` handler never consults an Access header.
**Access does not log bypassed requests**, so Mario logs them itself.

**VERIFY:** that `Cf-Access-Jwt-Assertion` survives Traefik. Nothing in Cloudflare's or Traefik's
docs says it is stripped and neither strips arbitrary headers by default, but it is unconfirmed.
Echo the header once from a debug route behind Access, then delete the route.

## Coolify

- Set the app's domain as **`http://`**, not `https://` — Cloudflare terminates TLS and `https`
  causes a redirect loop.
- Point the tunnel's public hostname at `http://localhost:80` and let Traefik route by Host header,
  so tunnel routes survive deploys.
- **Do not do path routing in tunnel ingress.** A second routing layer will silently diverge from the
  Access path apps. Route on hostname only; the app handles `/a/*`.
- **Deploy as a Dockerfile or single image, never Docker Compose.** Coolify cannot do zero-downtime
  with Compose; one measured report puts it near 23s per deploy. With a synchronous SessionStart
  hook that is a visible stall for every developer on every deploy.
- The origin sees Traefik's IP. Use `CF-Connecting-IP` for anything that needs the caller.
- Your endpoint token appears in the URL, so it lands in Traefik access logs on disk. Disable or
  scrub access logging for the `/a` prefix.

## The operational bill

The platform used to provide these. Now you do. Ordered by what actually bites.

**Before cutover**

0. **Build the image and run the suite.** `docker build .`; `npm test` (149 tests). The Dockerfile
   needs no compiler — better-sqlite3 ships prebuilds — so a compile during `npm ci` means prebuild
   resolution broke and is worth investigating rather than papering over with a toolchain.
1. **The SessionStart hook fails open.** Already implemented: a 250ms timeout
   (`MARIO_HOOK_TIMEOUT_MS`), and any timeout or error prints nothing and lets the turn proceed.
   Measured at 59ms against an unreachable server. This is what stops one unwell box from becoming a
   company-wide stop-work event, and it is the reason the single-box design is defensible at all.
2. **Deliberately break it before trusting it.** Start with `MARIO_ALLOWED_REPOS` unset and confirm
   **exit 78**; start with `MARIO_DEV_ACTOR` plus `NODE_ENV=production` and confirm exit 78. Those two
   checks are what prove the silent-misconfiguration class is closed. Then `curl /statusz` and require
   `warnings: []` — the cutover gate is that, not "the page loads".
3. **Firewall: deny all inbound except SSH.** A Tunnel is outbound-only, but the box still has a
   public IP and Coolify's Traefik binds :80/:443. Verify from an external host that both fail —
   and check Docker's iptables rules have not punched through a naive `ufw` config.
4. **Every public hostname on the tunnel has an Access application, or is deliberately public.** No
   orphans. Access is per-hostname.

**First week**

4. **Cron with a dead-man's switch.** The 4h fold runs in-process. Alert if no fold has completed in
   >5h. A silently-stopped fold is precisely the failure class this system exists to prevent; do not
   reintroduce it with a timer that fails quietly.
5. **Backups with a rehearsed restore.** Litestream, or `VACUUM INTO` snapshots shipped off-box.
   **Never `cp` a live WAL database** — you get a torn copy that restores clean and is silently
   wrong. Then actually restore one into a scratch container and run `npm test` against it. An
   unrehearsed backup is not a backup.
6. **Log rotation.** Set the Docker `json-file` driver's `max-size` and `max-file`. The default is
   unbounded: the disk fills, SQLite writes fail, and every hook fails at once. Two lines of config,
   and it is the classic single-box outage.
7. **Alerts:** disk >80%, process up, fold ran in the last 5h, p99 SessionStart latency.
8. **Restart policy with an RSS ceiling**, so a leak degrades into a restart rather than an OOM kill
   mid-write.
9. **Secrets** — `ANTHROPIC_API_KEY` is now an env file, not a platform secret. Confirm it is not in
   the repo and not in whatever Coolify backs up.
10. **Fleet migration** — the endpoint URL lives in every developer's harness config. Plan a
    dual-run window and a way to see who has not migrated.

## Scaling — two cliffs, measured

Benchmarked at 10k / 100k / 1M / 2M / 3M events. `check()` itself is flat across
that entire range (0.084ms), and over HTTP roughly **76% of observed check latency
is framework and socket floor, not the database** — so micro-optimising queries
would buy nothing. Two things genuinely break, and the dangerous one is not the
one you would guess.

**(a) Blob size — reachable today, by one request.** `paths` elements are now
capped at 512 bytes each (`serialisePaths`). Before that cap, ~40–50MB of live
paths in one project put `check()` over its 250ms budget *for every agent in that
project* — and a single `POST /e` carrying 50 distinct 1MB paths creates exactly
that in one row, with no growth in row count and nothing in the metrics looking
unusual. No malice required: a hook passing a file's contents instead of its name
does it by accident. `/statusz` reports `size.paths_bytes` for this reason —
watch bytes-per-row, not rows.

**(b) Event row count — around 2M events.** `check()` never slows; what breaks is
`presence()`. There is one synchronous database connection in one process, so a
slow `/who` blocks the event loop for every concurrent `/check`. Measured before
`idx_events_ts`: a dashboard tab polling `/who` pushed check p99 from 5ms to
137ms — a 27x degradation of the critical path caused by somebody's open browser
tab. The symptom in the field is nasty: *intermittent* hook timeouts, uncorrelated
with anyone's activity, on an endpoint whose own latency is microseconds.
`idx_events_ts` pushes this roughly 30x further out.

Nothing reclaims space — events are stamped `folded_at`, never deleted — so the
file grows monotonically (≈1.3GB at 3M events). The index fixes latency, not size.

## Runtime

Node 22+ with `better-sqlite3`. The project briefly ran on Bun and moved off it deliberately: Bun's
own rewrite writeup names v1.3.14 for use-after-free crashes in `node:http2` and `node:zlib`, a UAF
in `UDPSocket.send()`, a heap out-of-bounds read in `Buffer#copy`, and leaks in `crypto.scrypt` and
`tlsSocket.setSession()` — 128 bugs that reproduce in that version — while the upgrade path, 1.4.0,
was days old with its flagship regression in the test runner. A use-after-free in a long-lived server
is a crash loop, and a crash loop sits in front of every developer's turn.

Nothing was given up in the move. The capabilities that mattered were SQLite's, not the runtime's:
upserts with correct `RETURNING`, `json_each` prefix filters, real interactive
transactions. The test loop is unchanged in practice (~0.6s for the full suite), the schema and every
query are identical, and `src/db.ts` is still the only file that names a driver.

`cli/mario.mjs` remains dependency-free ESM and is verified to run under both Node and Bun, because
it ships to developer machines where you do not control the runtime. The installer resolves whichever
it finds to an absolute path.
