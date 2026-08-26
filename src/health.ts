// Health, readiness, and the operator's one status page.
//
// Three endpoints, three consumers, deliberately not merged:
//
//   /healthz  liveness  — the platform's restart probe. Process only. It must
//                         NEVER touch the database and never consider fold
//                         freshness: a probe that fails on a transient lock
//                         turns a two-second stall into a restart loop, and one
//                         that fails on a stale fold restarts the process for a
//                         condition no restart can fix.
//   /readyz   readiness — the deploy gate. Proves the schema is reachable.
//   /statusz  operator  — everything needed to tell "up" from "up but recording
//                         nothing". Wired to no probe; polled by a dead-man's
//                         switch. Counts, timestamps and booleans only — no
//                         actor names, no project names, no token material.

import type { DB } from './db';
import type { Config } from './config';
import { posture } from './preflight';

const STARTED = Date.now();
const STALE_FOLD_MS = 5 * 60 * 60 * 1000; // the 4h cycle plus one missed run
const QUIET_MS = 24 * 60 * 60 * 1000;

export interface Status {
  ok: boolean;
  uptime_s: number;
  db: { ok: boolean; error?: string };
  config: {
    allowed_repos: number;
    admins: number;
    access_configured: boolean;
    fold_enabled: boolean;
    dev_actor_set: boolean;
  };
  fold: { last_at: number | null; age_s: number | null; unfolded_events: number };
  activity: {
    last_emit_at: number | null;
    age_s: number | null;
    endpoints_live: number;
    endpoints_used_7d: number;
    open_findings: number;
  };
  size: { events: number; presence: number; paths_bytes: number; storage_bytes: number | null };
  warnings: string[];
}

export function ready(db: DB): { ok: boolean; error?: string } {
  try {
    // Not `SELECT 1` — that succeeds against an empty file with no schema.
    db.query('SELECT COUNT(*) AS n FROM migrations').get();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
}

/**
 * Total bytes the backend reports, or null when it cannot say.
 *
 * A Durable Object has a HARD 10 GB ceiling at which writes fail — so unlike the
 * self-hosted path, where a full disk is an operational failure, this is a
 * platform limit that needs a signal long before it arrives.
 */
export type StorageSize = () => number | null;

export function status(
  db: DB,
  cfg: Config,
  now = Date.now(),
  storageSize: StorageSize = () => null,
): Status {
  const n = (sql: string, ...a: unknown[]) => db.query<{ n: number }>(sql).get(...a)?.n ?? 0;
  const t = (sql: string, ...a: unknown[]) =>
    db.query<{ t: number | null }>(sql).get(...a)?.t ?? null;

  let dbOk = true;
  let dbErr: string | undefined;
  let lastFold: number | null = null;
  let unfolded = 0;
  let lastEmit: number | null = null;
  let live = 0;
  let used7d = 0;
  let open = 0;
  let events = 0;
  let presenceRows = 0;
  let pathsBytes = 0;

  try {
    lastFold = t('SELECT MAX(updated_at) AS t FROM state');
    unfolded = n('SELECT COUNT(*) AS n FROM events WHERE folded_at IS NULL');
    lastEmit = t(
      `SELECT MAX(t) AS t FROM (
         SELECT MAX(ts) AS t FROM presence UNION ALL SELECT MAX(ts) AS t FROM events)`,
    );
    live = n('SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL');
    used7d = n(
      'SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL AND last_used > ?',
      now - 7 * 24 * 3600_000,
    );
    open = n("SELECT COUNT(*) AS n FROM findings WHERE status = 'open'");
    events = n('SELECT COUNT(*) AS n FROM events');
    presenceRows = n('SELECT COUNT(*) AS n FROM presence');
    // Bytes, not rows. Growth is reachable by accident — an agent emitting a
    // generated file list as a "path" — and row counts would miss 50 rows
    // holding 250 MB.
    pathsBytes = n(
      `SELECT COALESCE(SUM(LENGTH(paths)), 0) AS n FROM (
         SELECT paths FROM events
         UNION ALL SELECT paths FROM presence
         UNION ALL SELECT paths FROM findings)`,
    );
  } catch (err) {
    dbOk = false;
    dbErr = String(err instanceof Error ? err.message : err).slice(0, 200);
  }

  // Startup posture is re-reported on every call, not only at boot, so an
  // operator who missed the log still sees it.
  const { fatal, warn } = posture(cfg);
  const warnings = [...fatal, ...warn];

  // Reported regardless of NODE_ENV. preflight() only refuses to BOOT on this in
  // production, but an operator reading a status page wants to know that browser
  // authentication is bypassed whatever the environment claims to be.
  if (cfg.devActor && !warnings.some((w) => w.includes('MARIO_DEV_ACTOR'))) {
    warnings.push(`MARIO_DEV_ACTOR=${cfg.devActor}: browser authentication is BYPASSED`);
  }

  const foldAge = lastFold === null ? null : now - lastFold;
  // Only stale once there is something to fold. A quiet weekend is not an
  // incident, and an alert that fires every Sunday is one nobody reads.
  if (unfolded > 0 && (lastFold === null || foldAge! > STALE_FOLD_MS)) {
    warnings.push(`fold-stale: ${unfolded} unfolded events`);
  }

  const emitAge = lastEmit === null ? null : now - lastEmit;
  if (lastEmit === null || emitAge! > QUIET_MS) {
    warnings.push('no-activity-24h: nobody has emitted anything for a day');
  }
  const storageBytes = (() => {
    try {
      return storageSize();
    } catch {
      return null;
    }
  })();
  // Half the ceiling, which at this write volume is years of warning.
  if (storageBytes !== null && storageBytes > 5 * 1024 * 1024 * 1024) {
    warnings.push(
      `storage-ceiling: ${Math.round(storageBytes / 1073741824)} GB of a hard 10 GB limit`,
    );
  }
  if (pathsBytes > 512 * 1024 * 1024) {
    warnings.push(`paths-bloat: ${Math.round(pathsBytes / 1048576)} MB of path blobs`);
  }

  return {
    // What the dead-man's switch tests. Any warning flips it, because every one
    // of them means the tool is silently not doing its job.
    ok: dbOk && warnings.length === 0,
    uptime_s: Math.round((now - STARTED) / 1000),
    db: { ok: dbOk, ...(dbErr ? { error: dbErr } : {}) },
    config: {
      allowed_repos: cfg.allow.length,
      admins: cfg.admins.length,
      access_configured: !!(cfg.accessTeamDomain && cfg.accessAud),
      fold_enabled: !!cfg.anthropicApiKey,
      dev_actor_set: !!cfg.devActor,
    },
    fold: {
      last_at: lastFold,
      age_s: foldAge === null ? null : Math.round(foldAge / 1000),
      unfolded_events: unfolded,
    },
    activity: {
      last_emit_at: lastEmit,
      age_s: emitAge === null ? null : Math.round(emitAge / 1000),
      endpoints_live: live,
      endpoints_used_7d: used7d,
      open_findings: open,
    },
    size: { events, presence: presenceRows, paths_bytes: pathsBytes, storage_bytes: storageBytes },
    warnings,
  };
}
