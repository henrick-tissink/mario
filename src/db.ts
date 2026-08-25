// Database access.
//
// One SQLite file, WAL mode, opened once per process, on `better-sqlite3` under
// Node. Every call site goes through the thin `DB` interface below rather than
// the driver's own API — that seam is deliberate, and it is what made moving
// engines a one-file change rather than a rewrite.
//
// The system this replaces had no migration story at all: its single migrate
// script re-ran a file of bare `CREATE TABLE`s, which fails on any populated
// database. Schema versioning is here from the start.

import Sqlite from 'better-sqlite3';
import type { Database as SqliteDB, Statement } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A path is a filesystem path; anything longer is a blob you keep forever. */
export const MAX_PATH = 512;

/** Bind values: positional arguments, or a single object for named parameters. */
export type Binds = readonly unknown[];

export interface Stmt<T> {
  /** The row, or `undefined` when there is none. */
  get(...args: Binds): T | undefined;
  all(...args: Binds): T[];
  run(...args: Binds): { changes: number };
}

export interface DB {
  query<T = unknown>(sql: string): Stmt<T>;
  exec(sql: string): void;
  /** Always `.immediate()` for read-then-write; see `migrate`. */
  transaction(fn: () => void): { immediate(): void };
  close(): void;
}

function wrap(db: SqliteDB): DB {
  // Preparing is cheap but not free, and the hot paths (touch, check) run on
  // every file edit across the team.
  const cache = new Map<string, Statement>();
  const prepare = (sql: string): Statement => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };

  return {
    query<T>(sql: string): Stmt<T> {
      const s = prepare(sql);
      return {
        get: (...a) => s.get(...(a as unknown[])) as T | undefined,
        all: (...a) => s.all(...(a as unknown[])) as T[],
        run: (...a) => s.run(...(a as unknown[])),
      };
    },
    exec: (sql) => void db.exec(sql),
    transaction(fn) {
      const t = db.transaction(fn);
      return { immediate: () => void t.immediate() };
    },
    close: () => db.close(),
  };
}

/**
 * The ONLY way to open a connection. Every entry point must come through here.
 *
 * `busy_timeout` and `foreign_keys` are per-connection and are NOT persisted in
 * the database file — measured, not assumed. A connection that forgets
 * busy_timeout drops roughly 70% of its writes under two-process contention
 * while looking perfectly healthy in isolation, so there is deliberately no
 * other constructor in this codebase.
 */
export function open(path = process.env.MARIO_DB ?? 'mario.db'): DB {
  const raw = new Sqlite(path);
  // busy_timeout FIRST. Converting a fresh file to WAL needs an exclusive lock,
  // and with no timeout set it fails instantly rather than waiting — so two
  // containers starting together against an empty volume both died here.
  pragmas(raw);
  raw.pragma('journal_mode = WAL'); // persisted in the file
  const db = wrap(raw);
  migrate(db);
  return db;
}

function pragmas(raw: SqliteDB): void {
  raw.pragma('busy_timeout = 5000'); // per-connection
  raw.pragma('foreign_keys = ON'); // per-connection
  raw.pragma('synchronous = NORMAL');
}

/** Ordered. Append only; never edit a shipped entry. */
const MIGRATIONS: Array<{ name: string; sql: () => string }> = [
  { name: '001-init', sql: () => readFileSync(join(HERE, 'schema.sql'), 'utf8') },
  { name: '002-indexes', sql: () => readFileSync(join(HERE, '002-indexes.sql'), 'utf8') },
];

export function migrate(db: DB): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    // The applied-set is read INSIDE the transaction that writes it.
    //
    // Reading it outside was a time-of-check/time-of-use race: `.immediate()`
    // protects the write but not a decision made before the transaction began,
    // so two processes starting together both saw an empty set and the loser
    // re-ran `schema.sql` — which uses bare CREATE TABLE and threw.
    db.transaction(() => {
      const done = db
        .query<{ n: number }>('SELECT COUNT(*) AS n FROM migrations WHERE name = ?')
        .get(m.name);
      if (done && done.n > 0) return;
      db.exec(m.sql());
      db.query('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(m.name, Date.now());
      applied.push(m.name);
    }).immediate();
  }
  return applied;
}

/** A fresh in-memory database. The unit-test story, and the reason it exists. */
export function openMemory(): DB {
  const raw = new Sqlite(':memory:');
  pragmas(raw);
  const db = wrap(raw);
  migrate(db);
  return db;
}

// --- JSON path columns ------------------------------------------------------
// `paths` is stored as a JSON array of strings. Reads go through here so a
// corrupt or hand-edited value degrades to `[]` rather than throwing inside a
// request; nothing in this system is worth failing an agent's turn over.

export function parsePaths(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Element length is capped here as well as count.
 *
 * Count alone was not a bound: 50 x 1MB paths is a 50MB blob, which `check`
 * re-reads and `parsePaths` on every call, and which the presence upsert
 * re-expands with json_each on every touch. Measured — ~40-50MB of live paths in
 * one project puts check() over its 250ms budget for every agent in that
 * project, and one request can create that in a single row. No malice needed: a
 * hook passing a file's CONTENTS instead of its name does it by accident.
 *
 * Trade-off, deliberately taken: an over-long path is truncated, so it no longer
 * matches an exact path and degrades from a `hot` collision to a `warm` one. A
 * slightly weaker signal on a pathological input beats an unusable one for
 * everybody.
 */
export function serialisePaths(paths: readonly string[], cap = 50, maxLen = MAX_PATH): string {
  // Keep the most recent: a long session's newest files are the ones a
  // collision check cares about.
  const seen = [...new Set(paths.filter(Boolean).map((p) => p.slice(0, maxLen)))];
  return JSON.stringify(seen.slice(-cap));
}

/**
 * Escape a LIKE pattern's metacharacters. Must be paired with `ESCAPE '\'`.
 *
 * The system this replaces interpolated a caller-supplied id straight into
 * `id LIKE ? || '%'`, so `id: ""` became `LIKE '%'` and closed every finding in
 * the database in one call — reporting success.
 */
export function likePrefix(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}
