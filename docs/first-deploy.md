# First deploy — mario.launchinto.space

Concrete steps for this deployment. `docs/deploy.md` has the reasoning; this is
the order to do things in.

Everything in `wrangler.jsonc` is filled in except the two Access values, which
do not exist until step 3.

## 1. Authenticate

nvm's default here is Node 20 and this project needs 22+, so use the explicit
path (or `nvm use`, which will pick up `.nvmrc`):

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
npx wrangler login          # interactive; opens a browser
npx wrangler whoami         # confirm the account owning launchinto.space
```

The account must be the one `launchinto.space` sits on — a custom-domain route
can only bind to a zone on the same account. If `whoami` shows a different
account, stop here rather than deploying into the wrong one.

## 2. Enable Zero Trust

Cloudflare dashboard → Zero Trust. Pick a team name; the result is your
**team domain**, `<team>.cloudflareaccess.com`. Free to 50 users.

That value goes in `MARIO_ACCESS_TEAM_DOMAIN`.

## 3. Create TWO Access applications

This is the part that is easy to get subtly wrong.

**App A — the browser UI**
- Type: Self-hosted
- Domain: `mario.launchinto.space`, **path empty**
- Policy: Allow → your email (add teammates later)
- Copy its **Application Audience (AUD) tag** → `MARIO_ACCESS_AUD`

**App B — the agent surface**
- Type: Self-hosted
- Domain: `mario.launchinto.space`, **path `a`** — no wildcard, no slash
- Policy: **Bypass** → Everyone

Why `a` and not `/a/*`: Cloudflare documents `/alpha/*` as covering
`/alpha/one`, but never states it covers `/alpha/one/two`. Agent URLs are
`/a/<token>/check`, `/a/<token>/mcp`, … — deeper than one segment. Policy
inheritance from a non-wildcard parent path *is* documented, so path `a` is the
form that provably works.

App B has its own AUD. **Do not use it** — `MARIO_ACCESS_AUD` is App A's, because
that is the token the origin verifies for browser traffic.

## 4. Fill in the two values

In `wrangler.jsonc` → `vars`:
```jsonc
"MARIO_ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
"MARIO_ACCESS_AUD": "<App A's AUD tag>"
```

## 5. Set the secret

```sh
npx wrangler secret put ANTHROPIC_API_KEY
```
Not a `var` — vars are plaintext in the config and this repo is public.

## 6. Deploy

```sh
npx wrangler deploy
```

Wrangler creates the DNS record for the custom domain itself. First deploy also
applies the `v1` migration that gives the Durable Object SQL storage.

## 7. Verify before trusting it

```sh
# Should REDIRECT to an Access login, not answer:
curl -sI https://mario.launchinto.space/ | head -1

# Should answer without auth — /a is bypassed:
curl -s -o /dev/null -w '%{http_code}\n' https://mario.launchinto.space/a/nope/check   # 401 = reached the app

# The deep-path check that the docs are ambiguous about. MUST NOT redirect:
curl -s -o /dev/null -w '%{http_code}\n' https://mario.launchinto.space/a/nope/x/y/z   # 401, not 302
```

If that last one redirects to a login, App B's path matching is not covering
deep URLs and every agent call will break. Fix it before onboarding anyone.

Then sign in at `https://mario.launchinto.space/setup`, mint your endpoint, and:

```sh
./install.sh "<your endpoint URL>"
cd ~/some/repo && mario scope     # expect IN scope
mario check                       # expect clear
```

Finally, confirm posture is clean — this is the real cutover gate, not "the page
loads":

```sh
curl -s https://mario.launchinto.space/statusz   # behind Access, so use a browser
```
`ok: true` and `warnings: []`. A warning here means the service is running and
silently not doing its job.

## Onboarding everyone else

Send one link: `https://mario.launchinto.space/setup`. They sign in, click once,
run `./install.sh` with the URL it gives them. Nothing to issue by hand.

Watch `endpoints_used_7d` on `/statusz` against headcount to see who has actually
connected — the hook fails open, so a developer whose install is broken sees
nothing at all and simply never appears.
