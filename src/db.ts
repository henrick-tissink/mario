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

/** Bind values: positional arguments, or a single object for named parameters. */
export type Binds = readonly unknown[];

export interface Stmt<T> {
  /** The row, or `undefined` when there is none. */
  get(...args: Binds): T | undefined;
  all(...args: Binds): T[];
  run(...args: Binds): { changes: number };
}

export interface DB {
  /** The second type parameter is accepted for call-site readability only. */
  query<T = unknown, _P = Binds>(sql: string): Stmt<T>;
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
  raw.pragma('journal_mode = WAL'); // persisted in the file
  pragmas(raw);
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
];

export function migrate(db: DB): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const done = new Set(db.query<{ name: string }>('SELECT name FROM migrations').all().map((r) => r.name));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    // `.immediate()`, never a bare transaction: SQLite's default BEGIN is
    // DEFERRED, under which a second connection can interleave a write between
    // a read and the write that depends on it.
    db.transaction(() => {
      db.exec(m.sql());
      db.query('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(m.name, Date.now());
    }).immediate();
    applied.push(m.name);
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

/**
 * SQLITE_BUSY_SNAPSHOT cannot be waited out — busy_timeout returns it in 0ms.
 * It only arises from a deferred read-then-write, so `.immediate()` avoids it;
 * this is the backstop for anything that slips through.
 */
export function isRetryableBusy(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_BUSY';
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

export function serialisePaths(paths: readonly string[], cap = 50): string {
  // Keep the most recent: a long session's newest files are the ones a
  // collision check cares about.
  const seen = [...new Set(paths.filter(Boolean))];
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
