// The read path: who else is here, and what is already known broken.
//
// If this ever returns thirty lines it will be ignored within a week, so the
// caps below are load-bearing rather than tidiness.

import type { DB } from './db';
import { likePrefix, parsePaths } from './db';
import type { Config } from './config';
import { ago, dirOf, inScope, normaliseRepo, shortName } from './repo';
import { projectFor } from './emit';

const MAX_COLLISIONS = 3;
const MAX_FINDINGS = 2;

export interface CheckResult {
  project: string;
  /** Machine-readable, so callers other than a terminal can render their own. */
  collisions: Array<{
    actor: string;
    heat: 'hot' | 'warm';
    files: string[];
    dirs: string[];
    branch: string | null;
    ts: number;
  }>;
  findings: Array<{ id: string; summary: string; seen: number }>;
  /** Luigi's headline only — the full document is a separate call. */
  state: string | null;
  clear: boolean;
  skipped?: 'out-of-scope';
}

export function check(
  db: DB,
  cfg: Config,
  actor: string,
  opts: { repo?: string | null; project?: string | null; paths?: string[] | null },
  now = Date.now(),
): CheckResult {
  const empty = (skipped?: 'out-of-scope'): CheckResult => ({
    project: '',
    collisions: [],
    findings: [],
    state: null,
    clear: true,
    ...(skipped ? { skipped } : {}),
  });

  // The scope guard runs even when a project is named explicitly. In the system
  // this replaces it did not, so `?project=anything` returned another team's
  // live activity, findings and state with no allow-list check at all.
  const repo = normaliseRepo(opts.repo);
  if (repo && !inScope(repo, cfg.allow)) return empty('out-of-scope');

  let project = opts.project ?? null;
  if (!project) {
    if (!repo) return empty();
    project = projectFor(db, repo, now);
  } else if (!repo) {
    // A bare project name is only honoured if it is one this caller could have
    // reached through an in-scope repo.
    const known = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM repos WHERE project = ?`,
      )
      .get(project);
    if (!known || known.n === 0) return empty();
    const reachable = db
      .query<{ repo: string }, [string]>(`SELECT repo FROM repos WHERE project = ?`)
      .all(project)
      .some((r) => inScope(r.repo as never, cfg.allow));
    if (!reachable) return empty('out-of-scope');
  }

  const mine = (opts.paths ?? []).filter(Boolean);
  const myDirs = new Set(mine.map(dirOf));

  const others = db
    .query<
      { actor: string; branch: string | null; paths: string; note: string | null; ts: number },
      [string, string, number]
    >(
      `SELECT actor, branch, paths, note, MAX(ts) AS ts
         FROM presence
        WHERE project = ? AND actor <> ? AND ts > ?
        GROUP BY actor
        ORDER BY ts DESC
        LIMIT 20`,
    )
    .all(project, actor, now - cfg.decayMs);

  const hot: CheckResult['collisions'] = [];
  const warm: CheckResult['collisions'] = [];

  for (const row of others) {
    const theirs = [...new Set(parsePaths(row.paths))];
    const theirDirs = [...new Set(theirs.map(dirOf))];

    const exact = theirs.filter((p) => mine.includes(p));
    if (exact.length) {
      hot.push({ actor: row.actor, heat: 'hot', files: exact, dirs: [], branch: row.branch, ts: row.ts });
      continue;
    }
    // `.filter(Boolean)` is load-bearing: dirOf() returns '' for a root-level
    // file, so without it two people editing *different* top-level files read as
    // sharing a directory — the exact false collision this product cannot afford.
    const shared = theirDirs.filter((d) => d && myDirs.has(d));
    if (shared.length) {
      warm.push({
        actor: row.actor,
        heat: 'warm',
        files: theirs.filter((p) => shared.includes(dirOf(p))),
        dirs: shared,
        branch: row.branch,
        ts: row.ts,
      });
      continue;
    }
    // With no paths supplied this is a session-start check, where "who else is
    // in this project at all" is the useful answer rather than nothing.
    if (mine.length === 0) {
      warm.push({
        actor: row.actor,
        heat: 'warm',
        files: [],
        dirs: theirDirs.filter(Boolean).slice(0, 2),
        branch: row.branch,
        ts: row.ts,
      });
    }
  }

  const collisions = [...hot, ...warm].slice(0, MAX_COLLISIONS);
  const findings = relevantFindings(db, project, [...myDirs].filter(Boolean));

  return {
    project,
    collisions,
    findings,
    state:
      db.query<{ doc: string }, [string]>('SELECT doc FROM state WHERE project = ?').get(project)
        ?.doc?.split('\n')[0]
        ?.trim() || null,
    clear: collisions.length === 0 && findings.length === 0,
  };
}

/**
 * Open findings near the caller's work, most-reported first.
 *
 * The area filter is applied IN SQL. The system this replaces filtered in
 * JavaScript after the query's LIMIT, so a finding in your area ranked 25th was
 * silently invisible and the tool answered "none" for a dirty area.
 */
export function relevantFindings(
  db: DB,
  project: string,
  dirs: readonly string[],
  limit = MAX_FINDINGS,
): CheckResult['findings'] {
  const rows = dirs.length
    ? db
        .query<{ id: string; summary: string; seen_count: number }, [string, string, number]>(
          `SELECT id, summary, seen_count FROM findings f
            WHERE f.project = ? AND f.status = 'open'
              AND EXISTS (
                SELECT 1 FROM json_each(f.paths) fp
                JOIN json_each(?) d ON fp.value LIKE d.value ESCAPE '\\'
              )
            ORDER BY seen_count DESC, updated_at DESC LIMIT ?`,
        )
        .all(project, JSON.stringify(dirs.map(likePrefix)), limit)
    : db
        .query<{ id: string; summary: string; seen_count: number }, [string, number]>(
          `SELECT id, summary, seen_count FROM findings
            WHERE project = ? AND status = 'open'
            ORDER BY seen_count DESC, updated_at DESC LIMIT ?`,
        )
        .all(project, limit);
  return rows.map((r) => ({ id: r.id, summary: r.summary, seen: r.seen_count }));
}

/** The terminal rendering. Hooks read this far more often than anything wants JSON. */
export function renderCheck(r: CheckResult, now = Date.now()): string {
  if (r.skipped === 'out-of-scope') return 'out of scope — this repo does not emit';
  const lines: string[] = [];
  for (const c of r.collisions) {
    const when = ago(c.ts, now);
    const branch = c.branch ? `, ${c.branch}` : '';
    const who = shortName(c.actor);
    if (c.heat === 'hot') {
      const more = c.files.length > 1 ? ` (+${c.files.length - 1} more)` : '';
      lines.push(`! ${who} is editing ${c.files[0]}${more} — ${when}${branch}`);
    } else if (c.dirs.length && c.files.length) {
      lines.push(`~ ${who} active in ${c.dirs[0]} (${c.files.length} files) — ${when}${branch}`);
    } else if (c.dirs.length) {
      lines.push(`~ ${who} active in ${c.dirs.join(', ')} — ${when}${branch}`);
    } else {
      lines.push(`~ ${who} active — ${when}${branch}`);
    }
  }
  for (const f of r.findings) {
    lines.push(`o open finding${f.seen > 1 ? ` x${f.seen}` : ''}: ${f.summary} [${f.id.slice(0, 8)}]`);
  }
  const body = lines.length ? lines.join('\n') : 'clear';
  return r.state ? `${body}\n(state: ${r.state})` : body;
}
