// Process-startup contention, which no other test covered.
//
// `race.test.ts` exercises concurrent WRITES against an established database.
// Both bugs these tests pin lived earlier than that — in opening a FRESH file,
// where two containers starting together both convert to WAL and both apply
// migration 001.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mario-boot-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('N processes opening one fresh database all succeed', () => {
  const child = join(dir, 'child.mjs');
  const dbPath = join(dir, 'fresh.db');
  const src = new URL('../src/db.ts', import.meta.url).pathname;

  // A wall-clock barrier so they genuinely collide rather than queueing.
  writeFileSync(child, `
    const t = Number(process.argv[3]);
    while (Date.now() < t) {}
    const { open } = await import(${JSON.stringify(src)});
    const db = open(process.argv[2]);
    db.query('SELECT COUNT(*) AS n FROM migrations').get();
    db.close();
  `);

  const start = Date.now() + 700;
  const kids = Array.from({ length: 6 }, () =>
    execFileSync(process.execPath, ['--import', 'tsx', child, dbPath, String(start)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  expect(kids.length).toBe(6);   // execFileSync throws on a non-zero exit
});

test('migration 001 is applied exactly once', async () => {
  const { open } = await import('../src/db');
  const p = join(dir, 'once.db');
  const a = open(p);
  const b = open(p);   // a second connection must not re-apply it
  const n = a.query<{ n: number }>('SELECT COUNT(*) AS n FROM migrations').get()!.n;
  expect(n).toBe(1);
  a.close(); b.close();
});
