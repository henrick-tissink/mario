import { beforeEach, expect, test } from 'vitest';
import { openMemory, type DB } from '../src/db';
import { emit } from '../src/emit';
import { runLuigi, runLuigiExclusive, sweepPresence, buildPrompt } from '../src/luigi';
import type { Config } from '../src/config';

const cfg: Config = {
  decayMs: 120 * 60_000, allow: ['gitlab.com/acme'], stateMaxLines: 15,
  maxSummary: 280, maxFoldEvents: 500, admins: [], accessTeamDomain: '', accessAud: '',
  foldModel: 'test',
};
const REPO = 'git@gitlab.com:acme/widgets.git';
const NOW = 1_800_000_000_000;
let db: DB;
beforeEach(() => { db = openMemory(); });

const rows = <T>(sql: string): T[] => db.query<T>(sql).all();
const ok = async (s: string) => s;

test('presence outside the window becomes history exactly once', () => {
  const old = NOW - 3 * 3600_000;
  emit(db, cfg, 'h@x.co', { kind: 'touch', session: 's', repo: REPO, paths: ['a.ts'] }, old);
  emit(db, cfg, 'h@x.co', { kind: 'touch', session: 'live', repo: REPO, paths: ['b.ts'] }, NOW);

  expect(sweepPresence(db, cfg, NOW)).toBe(1);
  expect(rows('SELECT * FROM presence').length).toBe(1);      // the live one stays
  expect(rows("SELECT * FROM events WHERE kind='worked'").length).toBe(1);
  expect(sweepPresence(db, cfg, NOW)).toBe(0);                // idempotent
});

test('a fold stamps only what it summarised', async () => {
  for (let i = 0; i < 12; i++) {
    emit(db, cfg, 'h@x.co', { kind: 'done', summary: `did ${i}`, repo: REPO }, NOW - (100 - i) * 1000);
  }
  // Cap the fold at 5 events.
  const out = await runLuigi(db, { ...cfg, maxFoldEvents: 5 }, ok, NOW);
  expect(out[0]!.status).toBe('folded');
  expect(out[0]!.events).toBe(5);

  const folded = rows<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE folded_at IS NOT NULL');
  // THE regression: exactly 5 stamped, not all 12.
  expect((folded[0] as any).n).toBe(5);
  expect(rows<{ folded_thru: number }>('SELECT folded_thru FROM state')[0]!.folded_thru)
    .toBe(out[0]!.foldedThru);
});

test('the remainder is picked up by the next run', async () => {
  for (let i = 0; i < 12; i++) {
    emit(db, cfg, 'h@x.co', { kind: 'done', summary: `did ${i}`, repo: REPO }, NOW - (100 - i) * 1000);
  }
  const small = { ...cfg, maxFoldEvents: 5 };
  await runLuigi(db, small, ok, NOW);
  await runLuigi(db, small, ok, NOW);
  await runLuigi(db, small, ok, NOW);
  expect(rows<any>('SELECT COUNT(*) AS n FROM events WHERE folded_at IS NULL')[0].n).toBe(0);
});

test('a failed fold stamps nothing and leaves the prior doc intact', async () => {
  emit(db, cfg, 'h@x.co', { kind: 'done', summary: 'x', repo: REPO }, NOW);
  await runLuigi(db, cfg, async () => 'first doc', NOW);

  emit(db, cfg, 'h@x.co', { kind: 'done', summary: 'y', repo: REPO }, NOW + 1000);
  const out = await runLuigi(db, cfg, async () => { throw new Error('api down'); }, NOW + 2000);

  expect(out[0]!.status).toBe('failed');
  expect(rows<any>('SELECT COUNT(*) AS n FROM events WHERE folded_at IS NULL')[0].n).toBe(1);
  expect(rows<{ doc: string }>('SELECT doc FROM state')[0]!.doc).toBe('first doc');
});

test('an empty document stamps nothing and is reported, not silent', async () => {
  emit(db, cfg, 'h@x.co', { kind: 'done', summary: 'x', repo: REPO }, NOW);
  const out = await runLuigi(db, cfg, async () => '   \n  ', NOW);
  expect(out[0]!.status).toBe('empty');
  expect(rows<any>('SELECT COUNT(*) AS n FROM events WHERE folded_at IS NULL')[0].n).toBe(1);
  expect(rows('SELECT * FROM state').length).toBe(0);
});

test('the line cap is enforced after generation too', async () => {
  emit(db, cfg, 'h@x.co', { kind: 'done', summary: 'x', repo: REPO }, NOW);
  await runLuigi(db, { ...cfg, stateMaxLines: 3 }, async () => 'a\nb\nc\nd\ne\nf', NOW);
  expect(rows<{ doc: string }>('SELECT doc FROM state')[0]!.doc.split('\n').length).toBe(3);
});

test('findings are counted, never consumed', async () => {
  emit(db, cfg, 'h@x.co', { kind: 'finding', summary: 'broken thing', repo: REPO }, NOW);
  emit(db, cfg, 'h@x.co', { kind: 'done', summary: 'x', repo: REPO }, NOW);
  let seen = '';
  await runLuigi(db, cfg, async (p) => { seen = p; return 'doc'; }, NOW);
  expect(seen).toContain('There are 1 open findings');
  expect(seen).not.toContain('broken thing');
  expect(rows<any>("SELECT COUNT(*) AS n FROM findings WHERE status='open'")[0].n).toBe(1);
});

test('the fold carries the prior document forward as input', async () => {
  emit(db, cfg, 'h@x.co', { kind: 'done', summary: 'first', repo: REPO }, NOW);
  await runLuigi(db, cfg, async () => 'STATE ONE', NOW);
  emit(db, cfg, 'h@x.co', { kind: 'done', summary: 'second', repo: REPO }, NOW + 1000);
  let seen = '';
  await runLuigi(db, cfg, async (p) => { seen = p; return 'STATE TWO'; }, NOW + 2000);
  expect(seen).toContain('STATE ONE');
  expect(seen).toContain('second');
  expect(seen).not.toContain('first');   // already folded, not re-fed
});

test('prompt renders events readably', () => {
  const p = buildPrompt('proj', null, [{
    id: 'e1',
    actor: 'henry@x.co', agent: 'claude', branch: 'fix/x', kind: 'done',
    summary: 'landed it', paths: JSON.stringify(['a.ts','b.ts']), ts: NOW - 60_000,
  }], 2, 15, NOW);
  expect(p).toContain('- henry@x.co (claude) done on fix/x: landed it [a.ts, b.ts] — 1m ago');
  expect(p).toContain('(none yet — this is the first fold)');
});

test('nothing to fold is a no-op', async () => {
  expect(await runLuigi(db, cfg, ok, NOW)).toEqual([]);
});

// --- regressions -----------------------------------------------------------
// Each of these reproduces a way the fold destroyed history. They exist because
// bounding the stamp by a timestamp looked equivalent to bounding it by identity
// and is not.

test('events sharing the boundary millisecond are not stamped unread', async () => {
  // A batched emit puts all 50 items in one millisecond, so a tie at the LIMIT
  // boundary is routine rather than exotic.
  const small = { ...cfg, maxFoldEvents: 2 };
  for (const s of ['a', 'b', 'c'])
    emit(db, small, 'x@y.co', { kind: 'done', summary: s, repo: REPO }, 1_000_000);

  let prompt = '';
  await runLuigi(db, small, async (p) => { prompt = p; return 'doc'; }, 2_000_000);

  expect(prompt).not.toContain(': c');
  expect(rows<any>('SELECT COUNT(*) AS n FROM events WHERE folded_at IS NULL')[0].n).toBe(1);
});

test('a sweep landing during the model call is not stamped by that fold', async () => {
  emit(db, cfg, 'a@x.co', { kind: 'done', summary: 'recent', repo: REPO }, NOW - 1000);
  emit(db, cfg, 'h@x.co', { kind: 'touch', session: 's', repo: REPO, paths: ['p/a.ts'] },
    NOW - cfg.decayMs + 1);

  // `worked` rows carry the presence row's OLD ts, so they always fall below a
  // timestamp bound taken before the model call.
  await runLuigi(db, cfg, async () => { sweepPresence(db, cfg, NOW + 2); return 'doc'; }, NOW);

  expect(rows<{ folded_at: number | null }>(
    "SELECT folded_at FROM events WHERE kind='worked'")[0]!.folded_at).toBeNull();
});

test('an umbrella project with no projects row folds instead of crashing', async () => {
  // The documented way to make an umbrella is to repoint repos.project by hand.
  // state.project has an FK to projects.slug and projectFor never created that
  // row, so the first fold threw a FOREIGN KEY error out of runLuigi — killing
  // the fold for every project in the deployment, on every subsequent run.
  emit(db, cfg, 'a@x.co', { kind: 'done', summary: 'x', repo: REPO }, 1000);
  // `sqlite3 mario.db` does NOT enable foreign_keys, so a hand-edit can leave
  // repos.project pointing at a slug with no projects row — which is precisely
  // the documented way to create an umbrella.
  db.exec('PRAGMA foreign_keys = OFF');
  db.query('UPDATE repos SET project = ?').run('umbrella');
  db.query('UPDATE events SET project = ?').run('umbrella');
  db.exec('PRAGMA foreign_keys = ON');

  const out = await runLuigi(db, cfg, async () => 'doc', 3000);
  expect(out[0]!.status).toBe('folded');
  expect(rows<any>('SELECT COUNT(*) AS n FROM state')[0].n).toBe(1);
});

test('a project the model refuses does not stop later projects', async () => {
  emit(db, cfg, 'a@x.co', { kind: 'done', summary: 'aaa', repo: 'git@gitlab.com:acme/aaa.git' }, 1000);
  emit(db, cfg, 'a@x.co', { kind: 'done', summary: 'bbb', repo: 'git@gitlab.com:acme/bbb.git' }, 1001);

  const out = await runLuigi(db, cfg, async (p) => {
    if (p.includes('aaa')) throw new Error('model refused');
    return 'doc';
  }, 3000);

  expect(out.map((o) => o.status).sort()).toEqual(['failed', 'folded']);
  // The healthy project still got its document, and the failed one kept its events.
  expect(rows<any>('SELECT COUNT(*) AS n FROM state')[0].n).toBe(1);
  expect(rows<any>('SELECT COUNT(*) AS n FROM events WHERE folded_at IS NULL')[0].n).toBe(1);
});

test('concurrent folds do not both call the model', async () => {
  emit(db, cfg, 'a@x.co', { kind: 'done', summary: 'x', repo: REPO }, NOW);
  let calls = 0;
  const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return 'doc'; };
  await Promise.all([
    runLuigiExclusive(db, cfg, slow, NOW),
    runLuigiExclusive(db, cfg, slow, NOW),
  ]);
  expect(calls).toBe(1);
});
