import { beforeEach, describe, expect, test } from 'vitest';
import { openMemory, type DB } from '../src/db';
import { emit } from '../src/emit';
import { check, renderCheck } from '../src/check';
import type { Config } from '../src/config';

const cfg: Config = {
  decayMs: 120 * 60_000, allow: ['gitlab.com/acme'], stateMaxLines: 15,
  maxSummary: 280, maxFoldEvents: 500, admins: [], accessTeamDomain: '', accessAud: '',
  foldModel: 'test',
};
const REPO = 'git@gitlab.com:acme/widgets.git';
const OTHER = 'git@github.com:acme-labs/x.git';
let db: DB;
beforeEach(() => { db = openMemory(); });

const touch = (actor: string, paths: string[], session = 's', branch?: string) =>
  emit(db, cfg, actor, { kind: 'touch', session, repo: REPO, paths, branch });

describe('collisions', () => {
  test('exact file overlap is hot', () => {
    touch('henry@x.co', ['src/pricing/refunds.ts'], 's1', 'fix/rounding');
    const r = check(db, cfg, 'me@x.co', { repo: REPO, paths: ['src/pricing/refunds.ts'] });
    expect(r.collisions[0]!.heat).toBe('hot');
    expect(renderCheck(r)).toContain('! Henry is editing src/pricing/refunds.ts');
    expect(renderCheck(r)).toContain('fix/rounding');
  });

  test('same directory is warm', () => {
    touch('henry@x.co', ['src/pricing/a.ts', 'src/pricing/b.ts']);
    const r = check(db, cfg, 'me@x.co', { repo: REPO, paths: ['src/pricing/c.ts'] });
    expect(r.collisions[0]!.heat).toBe('warm');
    expect(renderCheck(r)).toContain('~ Henry active in src/pricing/ (2 files)');
  });

  test('unrelated directory is not a collision', () => {
    touch('henry@x.co', ['src/billing/a.ts']);
    const r = check(db, cfg, 'me@x.co', { repo: REPO, paths: ['src/pricing/c.ts'] });
    expect(r.collisions.length).toBe(0);
    expect(r.clear).toBe(true);
  });

  test('two root-level files are NOT a shared directory', () => {
    touch('henry@x.co', ['package.json']);
    const r = check(db, cfg, 'me@x.co', { repo: REPO, paths: ['README.md'] });
    expect(r.collisions.length).toBe(0);
  });

  test('no paths supplied answers who is in the project at all', () => {
    touch('henry@x.co', ['src/pricing/a.ts']);
    const r = check(db, cfg, 'me@x.co', { repo: REPO });
    expect(r.collisions.length).toBe(1);
    expect(renderCheck(r)).toContain('~ Henry active in src/pricing/');
  });

  test('your own presence never collides with you', () => {
    touch('me@x.co', ['src/pricing/a.ts']);
    expect(check(db, cfg, 'me@x.co', { repo: REPO, paths: ['src/pricing/a.ts'] }).clear).toBe(true);
  });

  test('one line per person, not per session', () => {
    touch('henry@x.co', ['src/a.ts'], 's1');
    touch('henry@x.co', ['src/b.ts'], 's2');
    const r = check(db, cfg, 'me@x.co', { repo: REPO, paths: ['src/c.ts'] });
    expect(r.collisions.length).toBe(1);
  });

  test('presence outside the decay window is not a collision', () => {
    const long = Date.now() - 3 * 60 * 60 * 1000;
    emit(db, cfg, 'henry@x.co', { kind: 'touch', session: 's', repo: REPO, paths: ['src/a.ts'] }, long);
    expect(check(db, cfg, 'me@x.co', { repo: REPO, paths: ['src/a.ts'] }).clear).toBe(true);
  });

  test('capped at three collisions', () => {
    for (let i = 0; i < 6; i++) touch(`dev${i}@x.co`, ['src/p/a.ts'], `s${i}`);
    expect(check(db, cfg, 'me@x.co', { repo: REPO, paths: ['src/p/a.ts'] }).collisions.length).toBe(3);
  });
});

describe('findings surfaced by check', () => {
  const file = (summary: string, paths: string[]) =>
    emit(db, cfg, 'a@x.co', { kind: 'finding', summary, paths, repo: REPO });

  test('area-relevant findings are found even when ranked low', () => {
    // 30 noisier findings elsewhere; the relevant one is last by count.
    for (let i = 0; i < 30; i++) {
      for (let n = 0; n < 5; n++) file(`noise ${i}`, ['src/other/x.ts']);
    }
    file('the one that matters', ['src/pricing/refunds.ts']);
    const r = check(db, cfg, 'me@x.co', { repo: REPO, paths: ['src/pricing/other.ts'] });
    expect(r.findings.map((f) => f.summary)).toContain('the one that matters');
  });

  test('with no paths, the most-reported findings are shown', () => {
    file('rare', ['a/x.ts']);
    for (let i = 0; i < 4; i++) file('common', ['b/y.ts']);
    const r = check(db, cfg, 'me@x.co', { repo: REPO });
    expect(r.findings[0]!.summary).toBe('common');
    expect(r.findings[0]!.seen).toBe(4);
  });

  test('a closed finding disappears, and reopens when re-reported', () => {
    file('flaky', ['src/p/a.ts']);
    db.query("UPDATE findings SET status='closed'").run();
    expect(check(db, cfg, 'me@x.co', { repo: REPO }).findings.length).toBe(0);
    file('flaky', ['src/p/a.ts']);
    expect(check(db, cfg, 'me@x.co', { repo: REPO }).findings.length).toBe(1);
  });

  test('a path containing LIKE metacharacters cannot widen the match', () => {
    file('sneaky', ['src/100%/a.ts']);
    file('elsewhere', ['totally/other.ts']);
    const r = check(db, cfg, 'me@x.co', { repo: REPO, paths: ['src/100%/b.ts'] });
    expect(r.findings.map((f) => f.summary)).toEqual(['sneaky']);
  });

  test('findings count against clear', () => {
    file('something', ['src/p/a.ts']);
    expect(check(db, cfg, 'me@x.co', { repo: REPO }).clear).toBe(false);
  });
});

describe('scoping', () => {
  test('an out-of-scope repo returns out-of-scope, not a fake clear', () => {
    const r = check(db, cfg, 'me@x.co', { repo: 'git@github.com:someone/personal.git' });
    expect(r.skipped).toBe('out-of-scope');
    expect(renderCheck(r)).toContain('out of scope');
  });

  test('naming another project explicitly does not bypass the guard', () => {
    emit(db, { ...cfg, allow: ['gitlab.com/acme', 'github.com/acme-labs'] }, 'x@x.co',
      { kind: 'touch', session: 's', repo: OTHER, paths: ['secret.ts'] });
    // acme-labs is no longer in this caller's allow-list.
    const r = check(db, cfg, 'me@x.co', { project: 'acme-labs-x' });
    expect(r.collisions.length).toBe(0);
    expect(r.skipped).toBe('out-of-scope');
  });

  test('an unknown project name reveals nothing', () => {
    expect(check(db, cfg, 'me@x.co', { project: 'does-not-exist' }).clear).toBe(true);
  });

  test('checking never registers a project as a side effect', () => {
    check(db, cfg, 'me@x.co', { repo: 'git@github.com:someone/personal.git' });
    expect(db.query('SELECT * FROM projects').all().length).toBe(0);
  });
});

test('renderCheck says clear, with the state headline when there is one', () => {
  const r = check(db, cfg, 'me@x.co', { repo: REPO });
  expect(renderCheck(r)).toBe('clear');
  db.query('INSERT OR IGNORE INTO projects (slug,name,created_at) VALUES (?,?,?)').run('acme-widgets','c',1);
  db.query('INSERT INTO state (project,doc,folded_thru,updated_at) VALUES (?,?,?,?)')
    .run('acme-widgets', 'Pricing rewrite in progress.\nmore detail', 1, 1);
  const r2 = check(db, cfg, 'me@x.co', { repo: REPO });
  expect(renderCheck(r2)).toBe('clear\n(state: Pricing rewrite in progress.)');
});
