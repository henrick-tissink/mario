// Assumptions the Durable Object backend depends on.
//
// `db.do.ts` strips `--` comments before handing a migration to SQLite, because
// that backend rejects a script whose tail is comments. That is safe only while
// no string literal in the schema contains `--`; the day one does, stripping
// would corrupt a migration rather than fail it, so it is pinned here.
import { expect, test } from 'vitest';
import { MIGRATIONS, stripComments } from '../src/schema';
import { openMemory } from '../src/db';

test('migration names are unique and ordered', () => {
  const names = MIGRATIONS.map((m) => m.name);
  expect(new Set(names).size).toBe(names.length);
  expect([...names].sort()).toEqual(names);
});

test('no string literal in the schema contains a comment marker', () => {
  // Checked AFTER stripping, because prose comments are full of apostrophes
  // ("each other's paths") which are not string literals. If a real literal did
  // contain `--`, stripping would truncate it and leave an unbalanced quote —
  // which the semantic-equivalence test below would then fail on.
  for (const m of MIGRATIONS) {
    const sql = stripComments(m.sql);
    expect((sql.match(/'/g) ?? []).length % 2, `${m.name}: unbalanced quotes`).toBe(0);
    for (const lit of sql.match(/'[^']*'/g) ?? []) {
      expect(lit, `${m.name}: ${lit}`).not.toContain('--');
    }
  }
});

test('stripping comments leaves the schema semantically identical', () => {
  // Applied to a real database: same tables, same indexes, either way.
  const withComments = openMemory();
  const objects = (db: ReturnType<typeof openMemory>) =>
    db
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
  const before = objects(withComments);

  const stripped = openMemory();
  stripped.exec('DROP TABLE IF EXISTS migrations');
  for (const t of objects(stripped)) {
    stripped.exec(`DROP TABLE IF EXISTS ${t}`);
    stripped.exec(`DROP INDEX IF EXISTS ${t}`);
  }
  for (const m of MIGRATIONS) stripped.exec(stripComments(m.sql));
  expect(objects(stripped).sort()).toEqual(before.filter((n) => n !== 'migrations').sort());
});

test('stripComments removes comments without touching statements', () => {
  expect(stripComments('-- just a comment')).toBe('');
  expect(stripComments('SELECT 1; -- trailing')).toBe('SELECT 1;');
  expect(stripComments('\n\n-- a\n\nSELECT 1;\n-- b\n')).toBe('SELECT 1;');
});
