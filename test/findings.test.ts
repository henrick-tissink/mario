import { beforeEach, expect, test } from 'vitest';
import { openMemory, type DB } from '../src/db';
import { emit } from '../src/emit';
import { closeFinding, listFindings } from '../src/findings';
import type { Config } from '../src/config';

const cfg: Config = {
  decayMs: 120*60_000, allow: ['gitlab.com/acme'], stateMaxLines: 15, maxSummary: 280,
  maxFoldEvents: 500, admins: [], accessTeamDomain: '', accessAud: '', foldModel: 't',
};
const REPO = 'git@gitlab.com:acme/widgets.git';
let db: DB;
beforeEach(() => { db = openMemory(); });
const file = (summary: string, paths: string[] = []) =>
  emit(db, cfg, 'a@x.co', { kind: 'finding', summary, paths, repo: REPO });

/** Unwraps the id, failing the test loudly rather than typing around it. */
function idOf(r: ReturnType<typeof file>): string {
  if (!r.ok || !r.id) throw new Error(`expected a recorded finding, got ${JSON.stringify(r)}`);
  return r.id;
}

test('an empty id cannot close the backlog', () => {
  file('one'); file('two'); file('three');
  for (const bad of ['', '   ', '%', '_', '%%%%%%%%', '_______']) {
    expect(closeFinding(db, bad).ok).toBe(false);
  }
  expect(listFindings(db).length).toBe(3);
});

test('a wildcard id that IS long enough still matches nothing', () => {
  file('one'); file('two');
  // 8 chars of pure wildcard — long enough to pass the length guard, but the
  // LIKE escape makes it a literal, so it matches no real uuid.
  expect(closeFinding(db, '%%%%%%%%').ok).toBe(false);
  expect(listFindings(db).length).toBe(2);
});

test('an 8-character short id closes exactly one finding', () => {
  const r = file('retry loop has no backoff');
  const out = closeFinding(db, idOf(r).slice(0, 8), 'added backoff');
  expect(out.ok).toBe(true);
  expect(listFindings(db).length).toBe(0);
  expect(listFindings(db, { status: 'closed' })[0]!.close_note).toBe('added backoff');
});

test('the close note never touches the summary', () => {
  const r = file('flaky auth test');
  closeFinding(db, idOf(r), 'not real, config issue');
  const closed = listFindings(db, { status: 'closed' })[0]!;
  expect(closed.summary).toBe('flaky auth test');
  expect(closed.summary).not.toContain('closed:');
});

test('a reopened finding does not carry the old resolution', () => {
  const r = file('flaky auth test');
  closeFinding(db, idOf(r), 'not real');
  file('Flaky auth test!');       // same defect, re-reported
  const open = listFindings(db)[0]!;
  expect(open.status).toBe('open');
  expect(open.close_note).toBeNull();
  expect(open.summary).toBe('flaky auth test');
  expect(open.seen_count).toBe(2);
});

test('closing twice is refused rather than silently succeeding', () => {
  const r = file('x');
  const id = idOf(r);
  expect(closeFinding(db, id).ok).toBe(true);
  const again = closeFinding(db, id);
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.reason).toBe('already-closed');
});

test('area filter finds a match ranked below the limit', () => {
  for (let i = 0; i < 40; i++) for (let n = 0; n < 3; n++) file(`noise ${i}`, ['src/other/a.ts']);
  file('needle', ['src/pricing/refunds.ts']);
  const found = listFindings(db, { area: 'src/pricing/', limit: 5 });
  expect(found.map(f => f.summary)).toEqual(['needle']);
});

test('area filter treats metacharacters literally', () => {
  file('percent dir', ['src/100%/a.ts']);
  file('other', ['src/1009/a.ts']);
  expect(listFindings(db, { area: 'src/100%/' }).map(f => f.summary)).toEqual(['percent dir']);
});
