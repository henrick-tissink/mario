// Findings queries shared by the MCP tools, the CLI and the web UI, so the
// three cannot drift.

import type { DB } from './db';
import { likePrefix } from './db';

export interface Finding {
  id: string;
  project: string;
  summary: string;
  paths: string;
  seen_count: number;
  status: string;
  close_note: string | null;
  closed_by: string | null;
  created_at: number;
  updated_at: number;
}

export function listFindings(
  db: DB,
  opts: { project?: string | null; area?: string | null; status?: string; limit?: number } = {},
): Finding[] {
  const status = opts.status === 'closed' ? 'closed' : 'open';
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20) || 20, 1), 200);
  const where: string[] = ['status = ?'];
  const args: unknown[] = [status];

  if (opts.project) {
    where.push('project = ?');
    args.push(opts.project);
  }
  // The area filter is a SQL predicate, not a post-LIMIT array filter, so a
  // relevant finding ranked below the limit is still found.
  if (opts.area) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(findings.paths) p
                WHERE p.value LIKE ? ESCAPE '\\')`,
    );
    args.push(likePrefix(opts.area));
  }
  args.push(limit);

  return db
    .query<Finding>(
      `SELECT id, project, summary, paths, seen_count, status, close_note, closed_by, created_at, updated_at
         FROM findings
        WHERE ${where.join(' AND ')}
        ORDER BY seen_count DESC, updated_at DESC
        LIMIT ?`,
    )
    .all(...args);
}

export type CloseResult =
  | { ok: true; id: string; summary: string }
  | { ok: false; reason: 'too-short' | 'not-found' | 'ambiguous' | 'already-closed' };

const MIN_ID = 8;

/**
 * Close one finding.
 *
 * Three guards, each replacing a specific way the previous implementation went
 * wrong: a minimum id length and an escaped LIKE (an empty id became `LIKE '%'`
 * and closed every finding in the database, reporting success), a match count
 * check (a prefix could silently hit several rows), and a status check. The
 * note goes in its own column — concatenating it into the summary meant a
 * reopened finding carried a stale resolution forever, and a summary-less
 * finding was wiped outright by the concatenation.
 */
export function closeFinding(
  db: DB,
  id: string,
  note: string | null = null,
  now = Date.now(),
  actor: string | null = null,
): CloseResult {
  const raw = (id ?? '').trim();
  if (raw.length < MIN_ID) return { ok: false, reason: 'too-short' };

  const matches = db
    .query<{ id: string; summary: string; status: string }>(
      `SELECT id, summary, status FROM findings WHERE id LIKE ? ESCAPE '\\' LIMIT 2`,
    )
    .all(likePrefix(raw));

  if (matches.length === 0) return { ok: false, reason: 'not-found' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  const found = matches[0]!;
  if (found.status === 'closed') return { ok: false, reason: 'already-closed' };

  // `changes` is checked: another agent can close the same finding between the
  // SELECT above and this UPDATE, and reporting success would silently discard
  // the loser's note.
  const res = db
    .query(
      `UPDATE findings SET status = 'closed', closed_at = ?, close_note = ?, closed_by = ?,
              updated_at = ?
        WHERE id = ? AND status = 'open'`,
    )
    .run(now, note, actor, now, found.id);
  if (res.changes === 0) return { ok: false, reason: 'already-closed' };

  return { ok: true, id: found.id, summary: found.summary };
}
