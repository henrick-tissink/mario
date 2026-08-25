import { beforeEach, expect, test } from 'vitest';
import { openMemory, type DB } from '../src/db';
import { emit } from '../src/emit';
import { runLuigi, sweepPresence, buildPrompt } from '../src/luigi';
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

const rows = <T>(sql: string): T[] => db.query<T, []>(sql).all();
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
    actor: 'henry@x.co', agent: 'claude', branch: 'fix/x', kind: 'done',
    summary: 'landed it', paths: JSON.stringify(['a.ts','b.ts']), ts: NOW - 60_000,
  }], 2, 15, NOW);
  expect(p).toContain('- henry@x.co (claude) done on fix/x: landed it [a.ts, b.ts] — 1m ago');
  expect(p).toContain('(none yet — this is the first fold)');
});

test('nothing to fold is a no-op', async () => {
  expect(await runLuigi(db, cfg, ok, NOW)).toEqual([]);
});
