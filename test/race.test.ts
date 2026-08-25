// The regression test for the defect that motivated the rewrite.
//
// The previous implementation collapsed presence with a SELECT followed by an
// UPDATE. The file-edit hook is installed async, so two hook processes in one
// session routinely overlapped and the later UPDATE overwrote the earlier one's
// path set — losing exactly the signal collision detection exists to provide.
//
// These tests use SEPARATE CONNECTIONS to a real file-backed database, because
// a single in-memory connection cannot exhibit the bug either way.

import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, parsePaths, type DB } from '../src/db';
import { emit } from '../src/emit';
import type { Config } from '../src/config';

const cfg: Config = {
  decayMs: 120 * 60_000,
  allow: ['gitlab.com/acme'],
  stateMaxLines: 15,
  maxSummary: 280,
  maxFoldEvents: 500,
  admins: [],
  accessTeamDomain: '',
  accessAud: '',
  foldModel: 'test',
};
const REPO = 'git@gitlab.com:acme/widgets.git';

let dir: string;
let file: string;
const conns: DB[] = [];

/** A genuinely separate connection to the same file, via the one constructor. */
function connect(): DB {
  const db = open(file);
  conns.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mario-race-'));
  file = join(dir, 'test.db');
  connect(); // creates the file and applies the schema
});

afterEach(() => {
  for (const c of conns.splice(0)) c.close();
  rmSync(dir, { recursive: true, force: true });
});

test('interleaved writers from one session lose no paths', () => {
  const a = connect();
  const b = connect();

  // Alternate connections, as two hook processes would.
  const written: string[] = [];
  for (let i = 0; i < 200; i++) {
    const db = i % 2 === 0 ? a : b;
    const path = `src/file${i}.ts`;
    written.push(path);
    const r = emit(db, cfg, 'henry@x.co', {
      kind: 'touch',
      session: 'one-session',
      repo: REPO,
      paths: [path],
    });
    expect(r.ok).toBe(true);
  }

  const rows = a.query<{ paths: string; writes: number }>('SELECT paths, writes FROM presence').all();
  expect(rows.length).toBe(1);
  expect(rows[0]!.writes).toBe(200);

  // The row caps at 50 paths, and it must be the 50 most recent — a collision
  // check cares about where someone is now, not where they started.
  const kept = parsePaths(rows[0]!.paths);
  expect(kept.length).toBe(50);
  expect(kept).toContain(written[written.length - 1]!);
  expect(kept).not.toContain(written[0]!);
});

test('concurrent findings of the same defect produce one row with a true count', () => {
  const conn = [connect(), connect(), connect()];
  for (let i = 0; i < 60; i++) {
    emit(conn[i % 3]!, cfg, `dev${i % 5}@x.co`, {
      kind: 'finding',
      repo: REPO,
      summary: 'retry loop has no backoff',
      paths: [`src/area${i % 4}/worker.ts`],
    });
  }
  const rows = conn[0]!
    .query<{ seen_count: number; paths: string }>('SELECT seen_count, paths FROM findings')
    .all();
  expect(rows.length).toBe(1);
  expect(rows[0]!.seen_count).toBe(60);
  // Every reporter's location survives, deduplicated.
  expect(parsePaths(rows[0]!.paths).sort()).toEqual([
    'src/area0/worker.ts',
    'src/area1/worker.ts',
    'src/area2/worker.ts',
    'src/area3/worker.ts',
  ]);
});

test('two writers registering an unseen repo do not race into an error', () => {
  const a = connect();
  const b = connect();
  const ra = emit(a, cfg, 'x@x.co', { kind: 'done', summary: 'a', repo: REPO });
  const rb = emit(b, cfg, 'y@x.co', { kind: 'done', summary: 'b', repo: REPO });
  expect(ra.ok && rb.ok).toBe(true);
  expect(a.query('SELECT * FROM projects').all().length).toBe(1);
});
