// The write path.
//
// Every branch is a single statement against a real constraint, so there is no
// read-then-write anywhere in this file. That is deliberate: the previous
// implementation collapsed presence by SELECTing a row and then UPDATEing it,
// and because the harness installs its file-edit hook asynchronously, two hook
// processes in one session routinely raced — losing exactly the paths that
// collision detection exists to report.

import { createHash, randomUUID } from 'node:crypto';
import type { DB } from './db';
import { MAX_PATH, serialisePaths } from './db';
import type { Config } from './config';
import { oneLine } from './config';
import { defaultProject, inScope, normaliseRepo, type Repo } from './repo';

export type EmitKind = 'touch' | 'claim' | 'done' | 'finding';

export interface EmitInput {
  kind: EmitKind;
  summary?: string | null;
  paths?: string[] | null;
  repo?: string | null;
  branch?: string | null;
  session?: string | null;
  agent?: 'claude' | 'codex' | null;
}

export type EmitResult =
  | { ok: true; kind: EmitKind; project: string; id?: string; merged: boolean; seen?: number }
  | { ok: false; skipped: 'out-of-scope' | 'no-repo' | 'empty'; reason: string };

const KINDS: readonly EmitKind[] = ['touch', 'claim', 'done', 'finding'];
export const isEmitKind = (k: unknown): k is EmitKind =>
  typeof k === 'string' && (KINDS as readonly string[]).includes(k);

/**
 * Findings dedupe on a hash of (project, aggressively normalised summary).
 * The normalisation is blunt on purpose: five agents describing one lint gripe
 * five slightly different ways must collide, or the list dies of noise.
 */
export function dedupeKey(project: string, summary: string): string {
  // Unicode-aware. `[^a-z0-9 ]` stripped Chinese, Arabic, Cyrillic, Japanese and
  // emoji to the empty string, so every non-ASCII finding in a project hashed
  // identically and merged into whichever arrived first — its text discarded.
  // camelCase and snake_case are split so `parseUser` and `parse_user` collide,
  // which is the point of normalising at all.
  const norm = summary
    .normalize('NFKD')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // The WHOLE normalised summary, not a prefix. Truncating at 160 chars meant
  // two findings sharing a long prefix were the same finding.
  return createHash('sha256').update(`${project}\u0000${norm}`).digest('hex');
}

/** Resolve a repo to a project, registering it on first sight. */
export function projectFor(db: DB, repo: Repo, now = Date.now()): string {
  const existing = db
    .query<{ project: string }>('SELECT project FROM repos WHERE repo = ?')
    .get(repo);
  if (existing) return existing.project;

  const slug = defaultProject(repo);
  const name = repo.split('/').pop() ?? slug;
  // Two agents emitting from an unseen repo at the same moment must not race
  // each other into an error, hence OR IGNORE on both.
  db.transaction(() => {
    db.query('INSERT OR IGNORE INTO projects (slug, name, created_at) VALUES (?, ?, ?)').run(
      slug,
      name,
      now,
    );
    db.query('INSERT OR IGNORE INTO repos (repo, project, first_seen) VALUES (?, ?, ?)').run(
      repo,
      slug,
      now,
    );
  }).immediate();
  return (
    db.query<{ project: string }>('SELECT project FROM repos WHERE repo = ?').get(repo)
      ?.project ?? slug
  );
}

export function emit(
  db: DB,
  cfg: Config,
  actor: string,
  input: EmitInput,
  now = Date.now(),
): EmitResult {
  const repo = normaliseRepo(input.repo);
  if (!repo) return { ok: false, skipped: 'no-repo', reason: 'no recognisable git remote' };
  // Server-side backstop. The CLI filters before sending — that is the half
  // providing privacy — and this half is central policy, so a stale client
  // config cannot pollute the feed. Both fail closed.
  if (!inScope(repo, cfg.allow)) {
    return { ok: false, skipped: 'out-of-scope', reason: `${repo} is not in scope` };
  }

  const project = projectFor(db, repo, now);
  // Length capped here; COUNT capped by serialisePaths, which dedupes first.
  // Slicing to 50 before dedupe meant 60 repeats of one file evicted 50 distinct
  // ones. Element length was never capped at all, so a path could be megabytes
  // — in an append-only table, re-read on every check and re-parsed on every
  // touch.
  const paths = (input.paths ?? []).filter(Boolean).map((p) => String(p).slice(0, MAX_PATH));
  // EVERY caller-supplied string that can reach another agent's context goes
  // through oneLine, not just `summary`. Branch names are attacker-controlled
  // and were previously stored raw.
  const summary = oneLine(input.summary, cfg.maxSummary);
  const agent = input.agent === 'claude' || input.agent === 'codex' ? input.agent : null;
  const branch = oneLine(input.branch, 200);

  switch (input.kind) {
    case 'touch':
    case 'claim': {
      // Presence needs a session to key on. Without one there is nothing to
      // collapse against, so it degrades to an event rather than inventing a key.
      if (!input.session) {
        if (input.kind === 'claim' && summary) break; // fall through to the event insert
        return {
          ok: false,
          skipped: 'empty',
          reason: `${input.kind} requires a session`,
        };
      }
      const merged = upsertPresence(db, {
        actor,
        session: String(input.session).slice(0, 200),
        project,
        repo,
        branch,
        agent,
        paths,
        note: input.kind === 'claim' ? summary : null,
        ts: now,
      });
      if (input.kind === 'claim' && summary) {
        insertEvent(db, {
          actor,
          agent,
          session: input.session,
          project,
          repo,
          branch,
          kind: 'claim',
          summary,
          paths,
          ts: now,
        });
      }
      return { ok: true, kind: input.kind, project, merged };
    }

    case 'done': {
      if (!summary) return { ok: false, skipped: 'empty', reason: 'done requires a summary' };
      const id = insertEvent(db, {
        actor,
        agent,
        session: input.session ?? null,
        project,
        repo,
        branch,
        kind: 'done',
        summary,
        paths,
        ts: now,
      });
      return { ok: true, kind: 'done', project, id, merged: false };
    }

    case 'finding': {
      if (!summary) return { ok: false, skipped: 'empty', reason: 'finding requires a summary' };
      return upsertFinding(db, { actor, project, repo, summary, paths, now });
    }
  }

  // `claim` with a summary but no session: record the narrative, skip presence.
  const id = insertEvent(db, {
    actor,
    agent,
    session: null,
    project,
    repo,
    branch,
    kind: 'claim',
    summary,
    paths,
    ts: now,
  });
  return { ok: true, kind: 'claim', project, id, merged: false };
}

interface PresenceRow {
  actor: string;
  session: string;
  project: string;
  repo: string | null;
  branch: string | null;
  agent: string | null;
  paths: string[];
  note: string | null;
  ts: number;
}

/**
 * One statement, one constraint. `json_patch`-free union: the incoming paths are
 * merged with whatever is already stored, newest kept, in SQL — so concurrent
 * writers cannot lose each other's work.
 */
function upsertPresence(db: DB, row: PresenceRow): boolean {
  // Plain `?` placeholders, and `ts` is simply passed twice.
  //
  // Not `?N` (better-sqlite3 rejects reused numbered placeholders) and not
  // `@name` (Durable Object SQL binds positionally only). Plain positional is
  // the one form every driver accepts, which is what keeps this file portable
  // across the Node and Workers backends.
  const res = db
    .query<{ writes: number }>(
      `INSERT INTO presence (actor, session, project, repo, branch, agent, paths, note,
                             created_at, ts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(actor, session, project) DO UPDATE SET
            ts     = excluded.ts,
            writes = presence.writes + 1,
            repo   = COALESCE(excluded.repo, presence.repo),
            branch = COALESCE(excluded.branch, presence.branch),
            agent  = COALESCE(excluded.agent, presence.agent),
            note   = COALESCE(excluded.note, presence.note),
            paths  = (
              -- Union old and new, keep each path's most recent position, then
              -- take the 50 MOST RECENT and restore chronological order. The cap
              -- must drop the oldest: a collision check asks where someone is
              -- now, not where the session started.
              SELECT json_group_array(value) FROM (
                SELECT value, ord FROM (
                  SELECT value, MAX(ord) AS ord FROM (
                    SELECT value, key AS ord FROM json_each(presence.paths)
                    UNION ALL
                    SELECT value, 1000000 + key AS ord FROM json_each(excluded.paths)
                  ) GROUP BY value
                  ORDER BY ord DESC LIMIT 50
                ) ORDER BY ord ASC
              )
            )
       RETURNING writes`,
    )
    .get(
      row.actor,
      row.session,
      row.project,
      row.repo,
      row.branch,
      row.agent,
      serialisePaths(row.paths),
      row.note,
      row.ts, // created_at
      row.ts, // ts
    );
  // A counter, not a timestamp comparison: two hook processes landing in the
  // same millisecond must still be distinguishable from a fresh row.
  return (res?.writes ?? 1) > 1;
}

interface EventRow {
  actor: string;
  agent: string | null;
  session: string | null;
  project: string;
  repo: string | null;
  branch: string | null;
  kind: 'claim' | 'done' | 'worked';
  summary: string | null;
  paths: string[];
  ts: number;
}

function insertEvent(db: DB, e: EventRow): string {
  const id = randomUUID();
  db.query(
    `INSERT INTO events (id, ts, actor, agent, session, project, repo, branch, kind, summary, paths)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    e.ts,
    e.actor,
    e.agent,
    e.session,
    e.project,
    e.repo,
    e.branch,
    e.kind,
    e.summary,
    serialisePaths(e.paths),
  );
  return id;
}

function upsertFinding(
  db: DB,
  f: { actor: string; project: string; repo: Repo; summary: string; paths: string[]; now: number },
): EmitResult {
  const dedupe = dedupeKey(f.project, f.summary);
  const id = randomUUID();
  // On a re-report the paths are UNIONed rather than discarded: the second
  // reporter's location is real information, and dropping it meant a finding
  // filed against src/orders/ was invisible to anyone working in src/invoices/.
  const row = db
    .query<{ id: string; seen_count: number }>(
      `INSERT INTO findings (id, dedupe, project, repo, summary, paths, first_actor,
                             created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe) DO UPDATE SET
            seen_count = findings.seen_count + 1,
            updated_at = excluded.updated_at,
            status     = 'open',
            closed_at  = NULL,
            close_note = NULL,
            paths      = (
              -- Most recent 50, newest-first priority, then back into order.
              -- A bare DISTINCT ... LIMIT 50 returned the OLD rows first, so a
              -- re-report's paths were dropped — exactly the bug the comment
              -- above claims to prevent.
              SELECT json_group_array(value) FROM (
                SELECT value, ord FROM (
                  SELECT value, MAX(ord) AS ord FROM (
                    SELECT value, key AS ord FROM json_each(findings.paths)
                    UNION ALL
                    SELECT value, 1000000 + key AS ord FROM json_each(excluded.paths)
                  ) GROUP BY value
                  ORDER BY ord DESC LIMIT 50
                ) ORDER BY ord ASC
              )
            )
       RETURNING id, seen_count`,
    )
    .get(
      id,
      dedupe,
      f.project,
      f.repo,
      f.summary,
      serialisePaths(f.paths),
      f.actor,
      f.now, // created_at
      f.now, // updated_at
    );

  return {
    ok: true,
    kind: 'finding',
    project: f.project,
    // On a dedupe hit this is the ORIGINAL finding's id, which is what keeps the
    // short id printed by `check` stable across re-reports.
    id: row?.id ?? id,
    merged: (row?.seen_count ?? 1) > 1,
    seen: row?.seen_count ?? 1,
  };
}
