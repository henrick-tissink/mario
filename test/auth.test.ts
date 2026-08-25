// src/auth.ts previously had no test file at all, and every HTTP test set
// MARIO_DEV_ACTOR — which short-circuits actorFromRequest before it reaches any
// of this. The browser authentication boundary was entirely unexercised, which
// is how a production dev-actor bypass and a missing test stayed invisible to
// two different reviewers looking at the same code.
import { beforeEach, expect, test } from 'vitest';
import { openMemory, type DB } from '../src/db';
import {
  actorFromRequest, csrfOk, hashToken, issueToken, mintToken,
  readCookie, resolveToken, revokeAllFor, touchToken, verifyAccess,
} from '../src/auth';
import { posture } from '../src/preflight';
import type { Config } from '../src/config';

const cfg: Config = {
  decayMs: 7200000, allow: ['gitlab.com/acme'], stateMaxLines: 15, maxSummary: 280,
  maxFoldEvents: 500, admins: ['boss@x.co'],
  accessTeamDomain: 'acme.cloudflareaccess.com', accessAud: 'aud123', foldModel: 't',
};
let db: DB;
beforeEach(() => { db = openMemory(); });

const req = (h: Record<string, string> = {}, method = 'GET') =>
  new Request('https://mario.example.com/api/me', { method, headers: h });

test('a minted token is 256 bits of base64url and only its hash is stored', () => {
  const t = mintToken();
  expect(Buffer.from(t, 'base64url').length).toBe(32);
  expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  const issued = issueToken(db, 'henry@x.co');
  const stored = db.query<{ hash: string }>('SELECT hash FROM tokens').get()!.hash;
  expect(stored).toBe(hashToken(issued));
  expect(stored).not.toContain(issued);
});

test('resolveToken accepts only the exact live token', () => {
  const t = issueToken(db, 'henry@x.co');
  expect(resolveToken(db, t)).toBe('henry@x.co');
  expect(resolveToken(db, t + 'x')).toBeNull();
  expect(resolveToken(db, t.slice(0, -1))).toBeNull();
  expect(resolveToken(db, '')).toBeNull();
});

test('revoking retires every live endpoint for that actor and nobody else', () => {
  const mine1 = issueToken(db, 'me@x.co');
  const mine2 = issueToken(db, 'me@x.co');
  const theirs = issueToken(db, 'other@x.co');
  expect(revokeAllFor(db, 'me@x.co')).toBe(2);
  expect(resolveToken(db, mine1)).toBeNull();
  expect(resolveToken(db, mine2)).toBeNull();
  expect(resolveToken(db, theirs)).toBe('other@x.co');
});

test('touchToken never throws, even for a token that does not exist', () => {
  expect(() => touchToken(db, 'nonsense')).not.toThrow();
});

test('readCookie handles the shapes a browser actually sends', () => {
  expect(readCookie('CF_Authorization=abc; other=1', 'CF_Authorization')).toBe('abc');
  expect(readCookie('a=1; CF_Authorization=x.y.z', 'CF_Authorization')).toBe('x.y.z');
  expect(readCookie('CF_Authorization=a=b', 'CF_Authorization')).toBe('a=b'); // base64 padding
  expect(readCookie('', 'CF_Authorization')).toBeUndefined();
  expect(readCookie(undefined, 'CF_Authorization')).toBeUndefined();
  expect(readCookie('Other=1', 'CF_Authorization')).toBeUndefined();
});

test('verifyAccess rejects junk and refuses to run unconfigured', async () => {
  expect(await verifyAccess(cfg, 'not-a-jwt')).toBeNull();
  expect(await verifyAccess(cfg, '')).toBeNull();
  // Unconfigured must fail closed rather than reaching for a JWKS URL.
  expect(await verifyAccess({ ...cfg, accessAud: '' }, 'x.y.z')).toBeNull();
  expect(await verifyAccess({ ...cfg, accessTeamDomain: '' }, 'x.y.z')).toBeNull();
});

test('no assertion and no cookie means no actor', async () => {
  expect(await actorFromRequest(req(), cfg)).toBeNull();
  expect(await actorFromRequest(req({ cookie: 'unrelated=1' }), cfg)).toBeNull();
  expect(await actorFromRequest(req({ 'cf-access-jwt-assertion': 'forged' }), cfg)).toBeNull();
});

test('devActor short-circuits everything — which is why preflight guards it', async () => {
  const dev = { ...cfg, devActor: 'dev@x.co' };
  expect(await actorFromRequest(req(), dev)).toBe('dev@x.co');
  // Harmless locally, unauthenticated admin in production.
  expect(posture(dev, { NODE_ENV: 'production' } as never).fatal.join(' ')).toContain(
    'MARIO_DEV_ACTOR',
  );
  expect(posture(dev, {} as never).fatal.join(' ')).not.toContain('MARIO_DEV_ACTOR');
});

test('CSRF: reads pass, writes need the custom header a form cannot set', () => {
  expect(csrfOk(req({}, 'GET'))).toBe(true);
  expect(csrfOk(req({}, 'HEAD'))).toBe(true);
  expect(csrfOk(req({}, 'POST'))).toBe(false);
  expect(csrfOk(req({}, 'DELETE'))).toBe(false);
  expect(csrfOk(req({ 'x-mario': '1' }, 'POST'))).toBe(true);
  expect(csrfOk(req({ 'x-mario': '0' }, 'POST'))).toBe(false);
});

test('preflight is fatal for the states that leave the tool silently useless', () => {
  expect(posture({ ...cfg, allow: [] }).fatal.join(' ')).toContain('MARIO_ALLOWED_REPOS');
  expect(posture({ ...cfg, accessAud: '' }).fatal.join(' ')).toContain('MARIO_ACCESS');
  expect(posture({ ...cfg, admins: [] }).warn.join(' ')).toContain('MARIO_ADMINS');
  expect(posture(cfg).fatal).toEqual([]);
});
