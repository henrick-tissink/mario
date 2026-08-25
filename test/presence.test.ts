// `who` had no test, and a runtime-only SQL error slipped through because of it.
import { beforeEach, expect, test } from 'vitest';
import { openMemory, type DB } from '../src/db';
import { emit } from '../src/emit';
import { presence, renderPresence } from '../src/presence';
import { sweepPresence } from '../src/luigi';
import type { Config } from '../src/config';

const cfg: Config = {
  decayMs: 120 * 60_000, allow: ['gitlab.com/acme'], stateMaxLines: 15, maxSummary: 280,
  maxFoldEvents: 500, admins: [], accessTeamDomain: '', accessAud: '', foldModel: 't',
};
const A = 'git@gitlab.com:acme/widgets.git';
const B = 'git@gitlab.com:acme/atlas.git';
const NOW = 1_800_000_000_000;
let db: DB;
beforeEach(() => { db = openMemory(); });

test('reports live presence with areas grouped under their project', () => {
  emit(db, cfg, 'henry@x.co', { kind: 'touch', session: 's', repo: A, paths: ['src/pricing/a.ts'] }, NOW);
  emit(db, cfg, 'henry@x.co', { kind: 'touch', session: 's', repo: B, paths: ['src/worker/b.ts'] }, NOW);
  const p = presence(db, cfg, 48);
  expect(p.people.length).toBe(1);
  const projects = p.people[0]!.projects.map((x) => x.project).sort();
  expect(projects).toEqual(['gitlab-acme-atlas', 'gitlab-acme-widgets']);
  // src/worker/ exists in most repos — an area without its project says nothing.
  for (const pr of p.people[0]!.projects) expect(pr.areas.length).toBeGreaterThan(0);
});

test('history is included, so a 48h window survives the sweep', () => {
  const old = NOW - 3 * 3600_000;
  emit(db, cfg, 'henry@x.co', { kind: 'touch', session: 's', repo: A, paths: ['src/p/a.ts'] }, old);
  sweepPresence(db, cfg, NOW);           // presence row becomes a `worked` event
  expect(db.query('SELECT * FROM presence').all().length).toBe(0);
  const p = presence(db, cfg, 48);
  expect(p.people.length).toBe(1);
  expect(p.people[0]!.projects[0]!.areas).toContain('src/p/');
});

test('caps at 3 projects and 3 areas, and carries no counts', () => {
  for (let i = 0; i < 5; i++) {
    emit(db, cfg, 'h@x.co', {
      kind: 'touch', session: `s${i}`, repo: A,
      paths: [`src/a${i}/x.ts`, `src/b${i}/y.ts`, `src/c${i}/z.ts`, `src/d${i}/w.ts`],
    }, NOW);
  }
  const p = presence(db, cfg, 48);
  expect(p.people[0]!.projects.length).toBeLessThanOrEqual(3);
  for (const pr of p.people[0]!.projects) expect(pr.areas.length).toBeLessThanOrEqual(3);
  // No per-person aggregate exists to leak.
  expect(Object.keys(p.people[0]!)).toEqual(['actor', 'ts', 'projects']);
});

test('a path containing a pipe does not corrupt anyone else', () => {
  emit(db, cfg, 'h@x.co', { kind: 'touch', session: 's', repo: A, paths: ['src/we|ird/a.ts'] }, NOW);
  emit(db, cfg, 'other@x.co', { kind: 'touch', session: 't', repo: A, paths: ['src/fine/b.ts'] }, NOW);
  const p = presence(db, cfg, 48);
  expect(p.people.length).toBe(2);
  const areas = p.people.flatMap((x) => x.projects.flatMap((y) => y.areas));
  expect(areas).toContain('src/we|ird/');
  expect(areas).toContain('src/fine/');
});

test('folds and open findings are reported for liveness', () => {
  emit(db, cfg, 'h@x.co', { kind: 'finding', summary: 'broken', repo: A }, NOW);
  db.query('INSERT OR IGNORE INTO projects (slug,name,created_at) VALUES (?,?,?)')
    .run('gitlab-acme-widgets', 'widgets', NOW);
  db.query('INSERT INTO state (project,doc,folded_thru,updated_at) VALUES (?,?,?,?)')
    .run('gitlab-acme-widgets', 'doc', NOW, NOW);
  const p = presence(db, cfg, 48);
  expect(p.openFindings).toBe(1);
  expect(p.folds.length).toBe(1);
});

test('hours is clamped and a non-numeric value does not poison the query', () => {
  expect(presence(db, cfg, 0).hours).toBe(1);
  expect(presence(db, cfg, 9999).hours).toBe(168);
  expect(presence(db, cfg, NaN).hours).toBe(48);
});

test('renders a readable report, including the empty case', () => {
  expect(renderPresence(presence(db, cfg, 48), NOW)).toContain('(nobody');
  emit(db, cfg, 'henry@x.co', { kind: 'touch', session: 's', repo: A, paths: ['src/p/a.ts'] }, NOW);
  const out = renderPresence(presence(db, cfg, 48), NOW);
  expect(out).toContain('henry');
  expect(out).toContain('gitlab-acme-widgets: src/p/');
  expect(out).toContain('0 open findings');
});
