import { expect, test } from 'vitest';
import { openMemory, migrate, likePrefix, parsePaths, serialisePaths } from '../src/db';

test('schema applies and is idempotent', () => {
  const db = openMemory();
  expect(migrate(db)).toEqual([]); // already applied
  const tables = db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map((r) => r.name);
  expect(tables).toContain('presence');
  expect(tables).toContain('findings');
  expect(tables).toContain('events');
});

test('presence upsert is atomic on the composite key', () => {
  const db = openMemory();
  db.query('INSERT INTO projects (slug,name,created_at) VALUES (?,?,?)').run('p', 'p', 1);
  const up = db.query(`INSERT INTO presence (actor,session,project,paths,created_at,ts)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(actor,session,project) DO UPDATE SET paths=excluded.paths, ts=excluded.ts`);
  up.run('a', 's', 'p', '["x"]', 1, 1);
  up.run('a', 's', 'p', '["y"]', 2, 2);
  const rows = db.query<{ paths: string; ts: number }>('SELECT paths, ts FROM presence').all();
  expect(rows.length).toBe(1);
  expect(rows[0]!.paths).toBe('["y"]');
});

test('CHECK constraints reject bad enum values', () => {
  const db = openMemory();
  db.query('INSERT INTO projects (slug,name,created_at) VALUES (?,?,?)').run('p', 'p', 1);
  expect(() =>
    db.query('INSERT INTO events (id,ts,actor,project,kind) VALUES (?,?,?,?,?)')
      .run('1', 1, 'a', 'p', 'bogus'),
  ).toThrow();
});

test('likePrefix neutralises wildcards', () => {
  expect(likePrefix('')).toBe('%');
  expect(likePrefix('%')).toBe('\\%%');
  expect(likePrefix('a_b')).toBe('a\\_b%');
});

test('paths round-trip and fail soft', () => {
  expect(parsePaths(serialisePaths(['a', 'b', 'a']))).toEqual(['a', 'b']);
  expect(parsePaths('not json')).toEqual([]);
  expect(parsePaths('{"a":1}')).toEqual([]);
  expect(parsePaths(null)).toEqual([]);
});
