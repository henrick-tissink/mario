// Two authentication worlds, and only two.
//
//   /a/<token>/*   agents and the CLI. A 256-bit token in the URL path resolves
//                  the actor. This prefix must be exempted from SSO at the edge,
//                  because an agent cannot complete an interactive login.
//   everything else  browser traffic behind Cloudflare Access.
//
// The token IS the actor identity. Nothing on the wire carries an `actor`
// field, so an agent can neither forget it nor spoof someone else's — the worst
// it can do is act as whoever the URL was issued to. That is also why an
// endpoint must never be shared: it does not fail, it silently attributes the
// sharer's work to the person it was minted for.

import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { DB } from './db';
import type { Config } from './config';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintToken(): string {
  // 256 bits. "Secure by obscurity" only holds if the obscurity is real, so this
  // is not a memorable slug and never will be.
  //
  // Web Crypto and btoa rather than Buffer: both exist natively in Node and in
  // Workers, so this needs no compatibility shim on either backend.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function issueToken(db: DB, actor: string, label: string | null = null): string {
  const token = mintToken();
  db.query('INSERT INTO tokens (hash, actor, label, created_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    actor,
    label,
    Date.now(),
  );
  return token;
}

/** Retires every live endpoint for an actor. Returns how many. */
export function revokeAllFor(db: DB, actor: string, now = Date.now()): number {
  return db
    .query('UPDATE tokens SET revoked_at = ? WHERE actor = ? AND revoked_at IS NULL')
    .run(now, actor).changes;
}

export function resolveToken(db: DB, token: string): string | null {
  if (!token) return null;
  const row = db
    .query<{ actor: string }>(
      'SELECT actor FROM tokens WHERE hash = ? AND revoked_at IS NULL',
    )
    .get(hashToken(token));
  return row?.actor ?? null;
}

/** Fire-and-forget: `last_used` feeds the admin screen, never authentication. */
export function touchToken(db: DB, token: string, now = Date.now()): void {
  try {
    db.query('UPDATE tokens SET last_used = ? WHERE hash = ?').run(now, hashToken(token));
  } catch {
    /* never let bookkeeping fail a request */
  }
}

// --- Cloudflare Access ------------------------------------------------------

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * Verify the Access JWT ourselves rather than trusting that Access "must have"
 * run in front of us. A present-but-invalid assertion resolves to null and the
 * caller decides the status code.
 */
export async function verifyAccess(cfg: Config, jwt: string): Promise<string | null> {
  if (!cfg.accessTeamDomain || !cfg.accessAud) return null;
  try {
    const { payload } = await jwtVerify(jwt, jwksFor(cfg.accessTeamDomain), {
      issuer: `https://${cfg.accessTeamDomain}`,
      audience: cfg.accessAud,
      // Pinned rather than left to library defaults. jose rejects `none` and
      // HS-with-a-public-key on its own, but algorithm confusion is not a thing
      // to rely on a default for.
      algorithms: ['RS256'],
    });
    if (typeof payload.email === 'string') return payload.email;
    if (typeof payload.common_name === 'string') return `svc:${payload.common_name}`;
    return null;
  } catch (err) {
    // Logged, because an expired token and a JWKS outage are both 401s and were
    // previously indistinguishable to an operator.
    console.warn('access: jwt rejected:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function actorFromRequest(
  req: Request,
  cfg: Config,
): Promise<string | null> {
  // Local development only. Set from a gitignored .env, never in production —
  // it disables authentication outright.
  if (cfg.devActor) return cfg.devActor;
  const jwt =
    req.headers.get('cf-access-jwt-assertion') ??
    readCookie(req.headers.get('cookie'), 'CF_Authorization');
  return jwt ? verifyAccess(cfg, jwt) : null;
}

/**
 * The browser API authenticates by cookie, so a state-changing request needs
 * something a cross-site form cannot produce. A custom header is exactly that:
 * it cannot be set by a form post, and forcing a preflight on fetch means an
 * attacker's origin is checked before the request is delivered.
 */
export function csrfOk(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  return req.headers.get('x-mario') === '1';
}
