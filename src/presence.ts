// Presence and liveness — shared by the CLI, the dashboard and the setup page
// so the three cannot drift.
//
// Primarily an "is this thing actually operational?" signal, which is why it
// carries fold times and the findings count alongside people: those are the
// three ways the system fails quietly (nobody emitting, folds not running,
// agents not recording findings).
//
// Deliberately no per-person counts, durations or ordering by volume. Presence
// has to stay honest to be useful for collision detection, and the moment it
// reads as a scoreboard the incentive is to keep your name on it. That is a
// standing constraint, not an omission.

import type { DB } from './db';
import { parsePaths } from './db';
import type { Config } from './config';
import { ago, dirOf } from './repo';

export interface Presence {
  hours: number;
  people: Array<{
    actor: string;
    ts: number;
    // Areas are grouped under their project: `src/worker/` exists in most repos,
    // so an area without its project says nothing about where someone is.
    projects: Array<{ project: string; areas: string[] }>;
  }>;
  folds: Array<{ project: string; updated_at: number }>;
  openFindings: number;
}

export function presence(db: DB, cfg: Config, hours = 48): Presence {
  const window = Math.min(Math.max(Number.isFinite(hours) ? hours : 48, 1), 168);
  const since = Date.now() - window * 3_600_000;

  // Live presence plus recent history, so a window longer than the decay period
  // still shows the day. `paths` stays a JSON array the whole way — the previous
  // system concatenated them with a `|` separator, which any filename containing
  // a pipe silently corrupted.
  const rows = db
    .query<{ actor: string; project: string; paths: string; ts: number }>(
      // Two plain placeholders, not `?1`/`?2`: reused numbered parameters are
      // rejected by the driver, and the failure only shows at runtime.
      `SELECT actor, project, paths, ts FROM presence WHERE ts > ?
       UNION ALL
       SELECT actor, project, paths, ts FROM events WHERE ts > ?
       ORDER BY ts DESC`,
    )
    .all(since, since);

  const byActor = new Map<string, Presence['people'][number]>();
  const seenArea = new Map<string, Set<string>>();

  for (const r of rows) {
    let entry = byActor.get(r.actor);
    if (!entry) {
      entry = { actor: r.actor, ts: r.ts, projects: [] };
      byActor.set(r.actor, entry);
    }
    let proj = entry.projects.find((p) => p.project === r.project);
    if (!proj) {
      if (entry.projects.length >= 3) continue;
      proj = { project: r.project, areas: [] };
      entry.projects.push(proj);
    }
    const key = `${r.actor} ${r.project}`;
    let seen = seenArea.get(key);
    if (!seen) seenArea.set(key, (seen = new Set()));
    for (const p of parsePaths(r.paths)) {
      const d = dirOf(p);
      if (!d || seen.has(d) || proj.areas.length >= 3) continue;
      seen.add(d);
      proj.areas.push(d);
    }
  }

  return {
    hours: window,
    people: [...byActor.values()].sort((a, b) => b.ts - a.ts),
    folds: db
      .query<{ project: string; updated_at: number }, []>(
        'SELECT project, updated_at FROM state ORDER BY updated_at DESC LIMIT 10',
      )
      .all(),
    openFindings:
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM findings WHERE status = 'open'")
        .get()?.n ?? 0,
  };
}

export function renderPresence(p: Presence, now = Date.now()): string {
  const out = [`Active in the last ${p.hours}h`];
  if (!p.people.length) {
    out.push('  (nobody — either a quiet day or nothing is emitting)');
  } else {
    for (const person of p.people) {
      const who = (person.actor.split('@')[0] ?? person.actor).padEnd(10);
      const where =
        person.projects
          .map((pr) => `${pr.project}: ${pr.areas.join(', ') || '—'}`)
          .join('  ·  ') || '—';
      out.push(`  ${who} ${where.padEnd(52)} ${ago(person.ts, now)}`);
    }
  }
  out.push('', 'Last folded');
  if (!p.folds.length) {
    out.push('  (never — Luigi has not run, or had nothing old enough to fold)');
  } else {
    for (const f of p.folds) out.push(`  ${f.project.padEnd(18)} ${ago(f.updated_at, now)}`);
  }
  out.push('', `${p.openFindings} open finding${p.openFindings === 1 ? '' : 's'}`);
  return out.join('\n');
}
