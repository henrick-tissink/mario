// The `DB` interface, implemented over Durable Object SQL storage.
//
// This file is the entire cost of running on Workers instead of Node. Every
// other module — emit, check, findings, presence, luigi, auth, http, mcp — is
// unchanged and unaware, because they were written against the interface in
// db.ts rather than against a driver. That seam has now paid for itself twice:
// once moving from bun:sqlite to better-sqlite3, and once here.
//
// It works because Durable Object SQL is SYNCHRONOUS. `sql.exec()` returns a
// cursor without awaiting and `transactionSync()` takes a synchronous callback,
// so the ~50 call sites keep their shape. D1 would have forced every one of them
// to become async.
//
// Three differences from better-sqlite3, each handled here so nothing above has
// to know:
//
//   1. Bindings are positional only — no `@name`, no reused `?N`. The queries
//      were converted to plain `?` for exactly this reason.
//   2. `changes` is `cursor.rowsWritten`.
//   3. There is no `foreign_keys` pragma and no pragmas at all. FK clauses in
//      the schema are inert. Nothing relies on enforcement — `luigi` inserts the
//      parent row itself with `INSERT OR IGNORE` — but it is a real difference,
//      not a formality.

import type { DB, Stmt } from './db';
import { migrate } from './db';
import { stripComments } from './schema';

type Row = Record<string, SqlStorageValue>;

export function wrapSql(sql: SqlStorage, storage: DurableObjectStorage): DB {
  const q = <T>(query: string): Stmt<T> => ({
    get: (...args) => {
      // `.one()` throws when there is not exactly one row; the interface
      // contract is `undefined` for a miss, which callers already handle with
      // optional chaining.
      const rows = sql.exec<Row>(query, ...(args as unknown[])).toArray();
      return rows.length ? (rows[0] as T) : undefined;
    },
    all: (...args) => sql.exec<Row>(query, ...(args as unknown[])).toArray() as T[],
    run: (...args) => ({
      changes: sql.exec<Row>(query, ...(args as unknown[])).rowsWritten,
    }),
  });

  return {
    query: q,
    // A migration is a multi-statement script, and `exec` takes one directly as
    // long as no bindings are passed — which migrations never do.
    //
    // Comments are stripped first. The schema is heavily commented for humans,
    // and this backend rejects a script whose tail is comments with "SQL code
    // did not contain a statement" — 002 ends with a note explaining what was
    // deliberately NOT fixed, which is exactly the kind of comment worth keeping
    // in the source and not worth sending to SQLite.
    exec: (statements) => {
      const stripped = stripComments(statements);
      if (stripped) sql.exec(stripped);
    },
    // Single-threaded by construction, so there is no BEGIN IMMEDIATE to get
    // wrong and no busy_timeout to forget. `.immediate()` is kept only so the
    // call sites stay identical across backends.
    transaction: (fn) => ({ immediate: () => void storage.transactionSync(fn) }),
    close: () => {
      /* the platform owns the connection lifetime */
    },
  };
}

/** Open (and migrate) the object's storage. Mirrors `open()` on the Node side. */
export function openDo(state: DurableObjectState): DB {
  const db = wrapSql(state.storage.sql, state.storage);
  migrate(db);
  return db;
}

/** Bytes in use. There is a hard 10 GB ceiling per object; watch it. */
export function databaseSize(sql: SqlStorage): number {
  return sql.databaseSize;
}
