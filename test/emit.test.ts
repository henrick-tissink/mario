import { beforeEach, describe, expect, test } from 'vitest';
import { openMemory, parsePaths, type DB } from '../src/db';
import { emit, dedupeKey, projectFor } from '../src/emit';
import { normaliseRepo } from '../src/repo';
import type { Config } from '../src/config';

const cfg: Config = {
  decayMs: 120 * 60_000,
  allow: ['gitlab.com/acme', 'github.com/acme-labs'],
  stateMaxLines: 15,
  maxSummary: 280,
  maxFoldEvents: 500,
  admins: ['boss@acme.co'],
  accessTeamDomain: '',
  accessAud: '',
  foldModel: 'test',
};

const REPO = 'git@gitlab.com:acme/widgets.git';
let db: DB;
beforeEach(() => {
  db = openMemory();
});

const rows = <T>(sql: string): T[] => db.query<T>(sql).all();

describe('scoping', () => {
  test('an out-of-scope repo writes nothing and says why', () => {
    const r = emit(db, cfg, 'henry@x.co', {
      kind: 'finding',
      summary: 'leak',
      repo: 'git@github.com:someone/personal.git',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe('out-of-scope');
    expect(rows('SELECT * FROM findings').length).toBe(0);
    expect(rows('SELECT * FROM projects').length).toBe(0);
  });

  test('a missing remote is out of scope, not "unassigned"', () => {
    const r = emit(db, cfg, 'henry@x.co', { kind: 'done', summary: 'x', repo: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe('no-repo');
  });

  test('an empty allow-list emits nothing', () => {
    const r = emit(db, { ...cfg, allow: [] }, 'henry@x.co', {
      kind: 'done',
      summary: 'x',
      repo: REPO,
    });
    expect(r.ok).toBe(false);
  });
});

describe('presence', () => {
  test('touches from one session collapse into a single row', () => {
    for (const p of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
      emit(db, cfg, 'henry@x.co', { kind: 'touch', session: 's1', repo: REPO, paths: [p] });
    }
    const all = rows<{ paths: string }>('SELECT paths FROM presence');
    expect(all.length).toBe(1);
    expect(parsePaths(all[0]!.paths).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  test('paths union rather than overwrite — the race the old design lost', () => {
    emit(db, cfg, 'h@x.co', { kind: 'touch', session: 's', repo: REPO, paths: ['a.ts', 'b.ts'] });
    emit(db, cfg, 'h@x.co', { kind: 'touch', session: 's', repo: REPO, paths: ['c.ts'] });
    const p = parsePaths(rows<{ paths: string }>('SELECT paths FROM presence')[0]!.paths);
    expect(p).toContain('a.ts');
    expect(p).toContain('b.ts');
    expect(p).toContain('c.ts');
  });

  test('separate sessions and separate actors stay separate', () => {
    emit(db, cfg, 'a@x.co', { kind: 'touch', session: 's1', repo: REPO, paths: ['x'] });
    emit(db, cfg, 'a@x.co', { kind: 'touch', session: 's2', repo: REPO, paths: ['x'] });
    emit(db, cfg, 'b@x.co', { kind: 'touch', session: 's1', repo: REPO, paths: ['x'] });
    expect(rows('SELECT * FROM presence').length).toBe(3);
  });

  test('first write reports merged:false, second reports true', () => {
    const a = emit(db, cfg, 'h@x.co', { kind: 'touch', session: 's', repo: REPO, paths: ['x'] });
    const b = emit(db, cfg, 'h@x.co', { kind: 'touch', session: 's', repo: REPO, paths: ['y'] });
    expect(a.ok && a.merged).toBe(false);
    expect(b.ok && b.merged).toBe(true);
  });

  test('records OpenCode attribution', () => {
    emit(db, cfg, 'h@x.co', {
      kind: 'touch',
      session: 's',
      repo: REPO,
      paths: ['src/a.ts'],
      agent: 'opencode',
    });
    expect(rows<{ agent: string }>('SELECT agent FROM presence')[0]!.agent).toBe('opencode');
  });

  test('a touch without a session is refused rather than given a fake key', () => {
    const r = emit(db, cfg, 'h@x.co', { kind: 'touch', repo: REPO, paths: ['x'] });
    expect(r.ok).toBe(false);
  });

  test('branch survives a later touch that carries none', () => {
    emit(db, cfg, 'h@x.co', {
      kind: 'claim',
      session: 's',
      repo: REPO,
      branch: 'fix/rounding',
      summary: 'refunds',
    });
    emit(db, cfg, 'h@x.co', { kind: 'touch', session: 's', repo: REPO, paths: ['x'] });
    expect(rows<{ branch: string }>('SELECT branch FROM presence')[0]!.branch).toBe('fix/rounding');
  });
});

describe('findings', () => {
  const file = (summary: string, paths: string[] = [], actor = 'a@x.co') =>
    emit(db, cfg, actor, { kind: 'finding', summary, paths, repo: REPO });

  test('near-identical wording collapses and counts', () => {
    file('Retry loop has no backoff');
    file('retry loop has no backoff!!');
    file('  RETRY   loop, has no backoff  ');
    const f = rows<{ seen_count: number }>('SELECT seen_count FROM findings');
    expect(f.length).toBe(1);
    expect(f[0]!.seen_count).toBe(3);
  });

  test('a re-report returns the ORIGINAL id, so short ids stay stable', () => {
    const first = file('flaky auth test');
    const again = file('Flaky auth test.');
    expect(again.ok && again.id).toBe((first.ok && first.id)!);
    expect(again.ok && again.merged).toBe(true);
  });

  test('a re-report merges paths instead of discarding the second location', () => {
    file('N+1 query in list view', ['src/orders/list.ts']);
    file('n+1 query in list view', ['src/invoices/list.ts']);
    const p = parsePaths(rows<{ paths: string }>('SELECT paths FROM findings')[0]!.paths);
    expect(p).toContain('src/orders/list.ts');
    expect(p).toContain('src/invoices/list.ts');
  });

  test('different projects keep their own copy of the same wording', () => {
    file('same words');
    emit(db, cfg, 'a@x.co', {
      kind: 'finding',
      summary: 'same words',
      repo: 'git@github.com:acme-labs/other.git',
    });
    expect(rows('SELECT * FROM findings').length).toBe(2);
  });

  test('dedupe key is project-scoped', () => {
    expect(dedupeKey('a', 'x')).not.toBe(dedupeKey('b', 'x'));
    expect(dedupeKey('a', 'Hello,  World!')).toBe(dedupeKey('a', 'hello world'));
  });

  test('a summary is capped and reduced to one line', () => {
    const r = emit(db, { ...cfg, maxSummary: 40 }, 'a@x.co', {
      kind: 'finding',
      repo: REPO,
      summary: 'x'.repeat(200) + '\nsecond line',
    });
    expect(r.ok).toBe(true);
    const s = rows<{ summary: string }>('SELECT summary FROM findings')[0]!.summary;
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).not.toContain('\n');
  });

  test('a finding with no summary is refused', () => {
    expect(emit(db, cfg, 'a@x.co', { kind: 'finding', repo: REPO }).ok).toBe(false);
  });
});

describe('project identity', () => {
  test('same-named repos in different orgs do NOT merge', () => {
    const a = projectFor(db, normaliseRepo('git@gitlab.com:acme/api.git')!);
    const b = projectFor(db, normaliseRepo('https://github.com/acme-labs/api.git')!);
    expect(a).not.toBe(b);
    expect(rows('SELECT * FROM projects').length).toBe(2);
  });

  test('a repo resolves to the same project every time', () => {
    const a = projectFor(db, normaliseRepo(REPO)!);
    const b = projectFor(db, normaliseRepo('https://gitlab.com/acme/widgets')!);
    expect(a).toBe(b);
  });

  test('an umbrella override survives re-resolution', () => {
    projectFor(db, normaliseRepo(REPO)!);
    db.query('INSERT INTO projects (slug,name,created_at) VALUES (?,?,?)').run(
      'umbrella',
      'umbrella',
      1,
    );
    db.query("UPDATE repos SET project = 'umbrella' WHERE repo = ?").run(
      'gitlab.com/acme/widgets',
    );
    expect(projectFor(db, normaliseRepo(REPO)!)).toBe('umbrella');
  });
});

describe('events', () => {
  test('done appends one row per turn', () => {
    emit(db, cfg, 'h@x.co', { kind: 'done', summary: 'landed the fix', repo: REPO });
    emit(db, cfg, 'h@x.co', { kind: 'done', summary: 'landed the fix', repo: REPO });
    expect(rows('SELECT * FROM events').length).toBe(2);
  });

  test('a claim records both presence and narrative', () => {
    emit(db, cfg, 'h@x.co', {
      kind: 'claim',
      session: 's',
      summary: 'starting refunds',
      repo: REPO,
    });
    expect(rows('SELECT * FROM presence').length).toBe(1);
    expect(rows("SELECT * FROM events WHERE kind='claim'").length).toBe(1);
  });
});
