// Luigi — the scheduled fold. Does the background work nobody watches.
//
// Two properties matter more than the prose quality:
//
//   1. It is a FOLD, not a window summary. Input is the prior document plus new
//      events. Summarising only the last window would give the system amnesia on
//      a fixed cycle.
//   2. It stamps EXACTLY the events it summarised, BY ID. Bounding the stamp by
//      a timestamp — even the maximum one actually read — is not the same thing,
//      and the difference destroys history: events sharing the boundary
//      millisecond, and `worked` rows a concurrent sweep inserts during the model
//      call, both fall inside the bound without ever reaching the model.
//   3. A fold is not re-entrant, and one project's failure must not abort the
//      rest of the run. See `runLuigiExclusive` and the per-project try.

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { DB } from './db';
import { parsePaths } from './db';
import type { Config } from './config';
import { ago } from './repo';

export interface FoldEvent {
  id: string;
  actor: string;
  agent: string | null;
  branch: string | null;
  kind: string;
  summary: string | null;
  paths: string;
  ts: number;
}

/** Injectable so the fold is testable without a network call. */
export type Summariser = (prompt: string) => Promise<string>;

export interface FoldOutcome {
  project: string;
  events: number;
  foldedThru: number;
  status: 'folded' | 'failed' | 'empty';
}

/**
 * Presence that has fallen outside the decay window is no longer a live claim.
 * It becomes history in one transaction, so the fold has a single input and the
 * presence table stays small and hot.
 */
export function sweepPresence(db: DB, cfg: Config, now = Date.now()): number {
  const cutoff = now - cfg.decayMs;
  let swept = 0;
  db.transaction(() => {
    const stale = db
      .query<{
          actor: string;
          session: string;
          project: string;
          repo: string | null;
          branch: string | null;
          agent: string | null;
          paths: string;
          note: string | null;
          ts: number;
        }>('SELECT * FROM presence WHERE ts <= ?')
      .all(cutoff);

    const ins = db.query(
      `INSERT INTO events (id, ts, actor, agent, session, project, repo, branch, kind, summary, paths)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'worked', ?, ?)`,
    );
    const del = db.query(
      'DELETE FROM presence WHERE actor = ? AND session = ? AND project = ?',
    );
    for (const p of stale) {
      ins.run(
        randomUUID(),
        p.ts,
        p.actor,
        p.agent,
        p.session,
        p.project,
        p.repo,
        p.branch,
        p.note,
        p.paths,
      );
      del.run(p.actor, p.session, p.project);
      swept++;
    }
  }).immediate();
  return swept;
}

export function buildPrompt(
  project: string,
  prior: string | null,
  events: FoldEvent[],
  openFindings: number,
  maxLines: number,
  now: number,
): string {
  const lines = events.map((e) => {
    const paths = parsePaths(e.paths);
    const where = paths.length
      ? ` [${paths.slice(0, 6).join(', ')}${paths.length > 6 ? ` +${paths.length - 6}` : ''}]`
      : '';
    const who = `${e.actor}${e.agent ? ` (${e.agent})` : ''}`;
    const branch = e.branch ? ` on ${e.branch}` : '';
    const what = e.summary ? `: ${e.summary}` : '';
    return `- ${who} ${e.kind}${branch}${what}${where} — ${ago(e.ts, now)}`;
  });

  return [
    `You maintain the rolling state document for the project "${project}".`,
    ``,
    `PREVIOUS STATE (carry forward what is still true; drop what is stale):`,
    prior ?? '(none yet — this is the first fold)',
    ``,
    `NEW EVENTS since the last fold:`,
    ...lines,
    ``,
    `There are ${openFindings} open findings on this project (do not list them; a count is enough).`,
    ``,
    `Write the updated state document. Rules:`,
    `- At most ${maxLines} lines. Hard limit.`,
    `- Name actors and code areas. "Henry: pricing/, landed refund-rounding fix" — not narrative prose.`,
    `- Report only what the events support. Invent nothing; if something is unclear, omit it.`,
    `- Keep durable facts from the previous state even if no new event mentions them.`,
    `- Drop anything that has clearly completed and stopped mattering.`,
    `- First line is a one-sentence headline; it is shown on its own elsewhere.`,
    `- No preamble, no markdown headers, no closing summary. Just the document.`,
  ].join('\n');
}

/**
 * The real summariser.
 *
 * No fallback to a weaker model on purpose: this document is what the whole team
 * reads, and a model that quietly turns an in-progress claim into "landed the
 * refund fix" is worse than a skipped fold. A skipped fold is free — the events
 * stay unstamped and the next run picks them up.
 */
export function anthropicSummariser(cfg: Config): Summariser {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  return async (prompt) => {
    const res = await client.beta.messages.create({
      model: cfg.foldModel,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      // A refusal here would silently skip a fold; the fallback re-runs the same
      // request on another model inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }],
    });
    if (res.stop_reason === 'refusal') throw new Error('fold refused by the model');
    return res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  };
}

export async function runLuigi(
  db: DB,
  cfg: Config,
  summarise: Summariser,
  now = Date.now(),
): Promise<FoldOutcome[]> {
  sweepPresence(db, cfg, now);

  const projects = db
    .query<{ project: string }>(`SELECT DISTINCT project FROM events WHERE folded_at IS NULL`)
    .all();

  const out: FoldOutcome[] = [];

  for (const { project } of projects) {
    // `id` is selected because the stamp is by identity, not by time — see below.
    const events = db
      .query<FoldEvent>(
        `SELECT id, actor, agent, branch, kind, summary, paths, ts
           FROM events
          WHERE project = ? AND folded_at IS NULL
          ORDER BY ts ASC LIMIT ?`,
      )
      .all(project, cfg.maxFoldEvents);
    if (!events.length) continue;

    const foldedThru = events[events.length - 1]!.ts;

    // Everything for one project, inside one try. Only `summarise` used to be
    // guarded, so any per-project WRITE failure threw out of the whole run and
    // every project later in the loop was skipped — permanently, on every
    // subsequent run. One misconfigured project could kill the fold for the
    // entire deployment.
    try {
      const prior =
        db.query<{ doc: string }>('SELECT doc FROM state WHERE project = ?').get(project)?.doc ??
        null;
      const open =
        db
          .query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM findings WHERE project = ? AND status = 'open'`,
          )
          .get(project)?.n ?? 0;

      let doc: string;
      try {
        doc = await summarise(buildPrompt(project, prior, events, open, cfg.stateMaxLines, now));
      } catch (err) {
        // A failed fold stamps nothing. Persisting a truncated or invented
        // document AND consuming the events behind it is the one unrecoverable
        // failure here.
        console.error(`luigi: fold failed for ${project}:`, err);
        out.push({ project, events: events.length, foldedThru, status: 'failed' });
        continue;
      }

      if (!doc.trim()) {
        // Logged, not silent: an empty generation must not look like a project
        // that simply had nothing to fold.
        console.warn(`luigi: empty document for ${project}, nothing stamped`);
        out.push({ project, events: events.length, foldedThru, status: 'empty' });
        continue;
      }

      // The cap is enforced here as well as in the prompt: a model that ignores
      // the instruction must not be able to grow the document nobody then reads.
      const capped = doc.split('\n').slice(0, cfg.stateMaxLines).join('\n');
      const ids = events.map((e) => e.id);

      db.transaction(() => {
        db.query(
          `INSERT OR IGNORE INTO projects (slug, name, created_at) VALUES (?, ?, ?)`,
        ).run(project, project, now);
        db.query(
          `INSERT INTO state (project, doc, folded_thru, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(project) DO UPDATE SET
             doc = excluded.doc, folded_thru = excluded.folded_thru,
             updated_at = excluded.updated_at`,
        ).run(project, capped, foldedThru, now);
        // Stamp EXACTLY the rows that were read, by id.
        //
        // Bounding by `ts <= foldedThru` looked equivalent and was not. Events
        // sharing the boundary timestamp — trivial, since a batched emit puts 50
        // items in one millisecond — were stamped without ever reaching the
        // model. So were `worked` rows a concurrent sweep inserted during the
        // model call, which carry the presence row's OLD ts and so are always
        // below the bound. Both destroyed history silently. Identity has no
        // such edge.
        const stamp = db.query(`UPDATE events SET folded_at = ? WHERE id = ? AND folded_at IS NULL`);
        for (const id of ids) stamp.run(now, id);
      }).immediate();

      out.push({ project, events: events.length, foldedThru, status: 'folded' });
    } catch (err) {
      console.error(`luigi: could not fold ${project}, continuing:`, err);
      out.push({ project, events: events.length, foldedThru, status: 'failed' });
    }
  }

  return out;
}

// A fold is not re-entrant. Four call sites can start one — the 4h interval, the
// startup timer, and both admin routes — and two concurrent runs read the same
// unfolded events, both pay for a model call, and the loser's document is
// overwritten while its events stay stamped as consumed.
let inFlight: Promise<FoldOutcome[]> | null = null;

export function runLuigiExclusive(
  db: DB,
  cfg: Config,
  summarise: Summariser,
  now = Date.now(),
): Promise<FoldOutcome[]> {
  if (inFlight) {
    console.log('luigi: fold already running, joining it');
    return inFlight;
  }
  inFlight = runLuigi(db, cfg, summarise, now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
