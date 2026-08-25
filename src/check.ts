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

  let project: string;
  if (opts.project) {
    // A named project is checked for reachability ALWAYS — not only when no
    // repo was supplied. Guarding it inside an `else if (!repo)` meant passing
    // an in-scope repo alongside any project name walked straight past the
    // allow-list and returned another team's presence, findings and state.
    const repos = db
      .query<{ repo: string }>('SELECT repo FROM repos WHERE project = ?')
      .all(opts.project);
    if (!repos.length) return empty(); // unknown project reveals nothing
    if (!repos.some((r) => inScope(r.repo, cfg.allow))) return empty('out-of-scope');
    project = opts.project;
  } else {
    if (!repo) return empty();
    project = projectFor(db, repo, now);
  }

  const mine = (opts.paths ?? []).filter(Boolean);
  const myDirs = new Set(mine.map(dirOf));

  // Every live row, NOT one per actor.
  //
  // The primary key is (actor, session, project), so one person legitimately
  // holds several rows — two terminals, two worktrees, a subagent. `GROUP BY
  // actor` kept exactly one of them, so a developer editing a file in their
  // first session went invisible the moment their second session touched
  // anything newer, and `check` answered `clear`. A confident false negative on
  // the one question this tool exists to answer. Rows are merged per actor
  // below instead, which is what "one line per person" always meant.
  const rows = db
    .query<{
      actor: string;
      session: string;
      branch: string | null;
      paths: string;
      note: string | null;
      ts: number;
    }>(
      `SELECT actor, session, branch, paths, note, ts
         FROM presence
        WHERE project = ? AND actor <> ? AND ts > ?
        ORDER BY ts DESC
        LIMIT 200`,
    )
    .all(project, actor, now - cfg.decayMs);

  const merged = new Map<
    string,
    { actor: string; branch: string | null; paths: string[]; ts: number }
  >();
  for (const r of rows) {
    const e = merged.get(r.actor);
    if (!e) {
      merged.set(r.actor, {
        actor: r.actor,
        branch: r.branch,
        paths: parsePaths(r.paths),
        ts: r.ts,
      });
      continue;
    }
    // Rows arrive newest-first, so the first row seen sets `ts`, and `branch`
    // comes from the newest row that actually carries one — a `touch` carries
    // none and is usually the newest.
    e.paths.push(...parsePaths(r.paths));
    e.branch ??= r.branch;
  }
  const others = [...merged.values()];

  const hot: CheckResult['collisions'] = [];
  const warm: CheckResult['collisions'] = [];

  for (const row of others) {
    const theirs = [...new Set(row.paths)];
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
      db.query<{ doc: string }>('SELECT doc FROM state WHERE project = ?').get(project)
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
        .query<{ id: string; summary: string; seen_count: number }>(
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
        .query<{ id: string; summary: string; seen_count: number }>(
          `SELECT id, summary, seen_count FROM findings
            WHERE project = ? AND status = 'open'
            ORDER BY seen_count DESC, updated_at DESC LIMIT ?`,
        )
        .all(project, limit);
  return rows.map((r) => ({ id: r.id, summary: r.summary, seen: r.seen_count }));
}

/**
 * Neutralise one field for rendering.
 *
 * Defence in depth: `emit` already strips newlines from summaries and branches,
 * but paths are stored as given and a filename may legally contain a newline on
 * unix. Everything interpolated into the block below is squeezed to one line so
 * no field can stop looking like a value and start looking like an instruction.
 */
function safe(s: string, max = 200): string {
  const clean = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/** The terminal rendering. Hooks read this far more often than anything wants JSON. */
export function renderCheck(r: CheckResult, now = Date.now()): string {
  if (r.skipped === 'out-of-scope') return 'out of scope — this repo does not emit';
  const lines: string[] = [];
  for (const c of r.collisions) {
    const when = ago(c.ts, now);
    const branch = c.branch ? `, ${safe(c.branch, 60)}` : '';
    const who = safe(shortName(c.actor), 40);
    if (c.heat === 'hot') {
      const more = c.files.length > 1 ? ` (+${c.files.length - 1} more)` : '';
      lines.push(`! ${who} is editing ${safe(c.files[0]!)}${more} — ${when}${branch}`);
    } else if (c.dirs.length && c.files.length) {
      lines.push(`~ ${who} active in ${safe(c.dirs[0]!)} (${c.files.length} files) — ${when}${branch}`);
    } else if (c.dirs.length) {
      lines.push(`~ ${who} active in ${safe(c.dirs.map((d) => safe(d, 60)).join(', '))} — ${when}${branch}`);
    } else {
      lines.push(`~ ${who} active — ${when}${branch}`);
    }
  }
  for (const f of r.findings) {
    lines.push(
      `o open finding${f.seen > 1 ? ` x${f.seen}` : ''}: ${safe(f.summary, 300)} [${f.id.slice(0, 8)}]`,
    );
  }
  const body = lines.length ? lines.join('\n') : 'clear';
  return r.state ? `${body}\n(state: ${safe(r.state, 300)})` : body;
}
