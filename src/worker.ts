// The Workers entry point.
//
// Everything lives in ONE Durable Object. That is unusual — DOs are normally
// sharded — and it is deliberate:
//
//   * A single object has no cross-object fan-out. `presence()` and the findings
//     list are global by nature; sharding per project would mean querying N
//     objects and merging, or maintaining a denormalised index, which is the
//     dual-write consistency problem this design spent real effort deleting.
//   * A DO is single-threaded, so every remaining concurrency concern is gone by
//     construction rather than by care. There is one writer, always.
//   * Write volume is low thousands a day. Serialisation costs nothing here.
//
// The Worker itself is a router: it resolves the object and forwards. All state,
// all SQL and the fold live inside the object.

import { DurableObject } from 'cloudflare:workers';
import type { Hono } from 'hono';
import { loadConfig, type Config } from './config';
import { createApp } from './http';
import { openDo } from './db.do';
import { anthropicSummariser, runLuigiExclusive, type Summariser } from './luigi';
import { preflight } from './preflight';
import type { DB } from './db';

export interface Env {
  MARIO: DurableObjectNamespace<MarioDurableObject>;
  [key: string]: unknown;
}

const FOUR_HOURS = 4 * 60 * 60 * 1000;

export class MarioDurableObject extends DurableObject<Env> {
  private readonly db: DB;
  private readonly cfg: Config;
  private readonly summarise: Summariser;
  private readonly app: Hono<{ Variables: { actor: string } }>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // `env` is the Worker's binding object, not process.env, so config is read
    // from it here. loadConfig() throws on a malformed number and preflight()
    // refuses to run a deployment that would look healthy and record nothing.
    this.cfg = loadConfig(env as Record<string, string | undefined>);
    preflight(this.cfg, env as Record<string, string | undefined>);
    this.db = openDo(state);
    this.summarise = anthropicSummariser(this.cfg);
    this.app = createApp({
      db: this.db,
      cfg: this.cfg,
      summarise: this.summarise,
      storageSize: () => state.storage.sql.databaseSize,
    });

    // Arm the fold if it is not already armed. Alarms survive eviction and
    // restart, which `setInterval` did not — a redeploy silently reset the
    // schedule, and a crash-looping process re-folded every project 30 seconds
    // into each restart.
    void state.blockConcurrencyWhile(async () => {
      if ((await state.storage.getAlarm()) === null) {
        await state.storage.setAlarm(Date.now() + FOUR_HOURS);
      }
    });
  }

  override fetch(request: Request): Response | Promise<Response> {
    return this.app.fetch(request);
  }

  /**
   * The fold.
   *
   * Alarms are at-least-once with automatic exponential backoff, so a failed run
   * retries without a monitor — the platform guarantees what a dead-man's switch
   * had to watch for on the self-hosted path. The next alarm is armed FIRST so
   * that a throwing fold cannot leave the schedule unarmed.
   */
  override async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + FOUR_HOURS);
    if (!this.cfg.anthropicApiKey) return; // no key: events simply accumulate
    try {
      const out = await runLuigiExclusive(this.db, this.cfg, this.summarise);
      const folded = out.filter((o) => o.status === 'folded').length;
      if (out.length) console.log(`luigi: folded ${folded}/${out.length} project(s)`);
    } catch (err) {
      console.error('luigi: run failed', err);
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // One object, one name. `idFromName` is deterministic, so every request in
    // every region reaches the same instance — which is what makes the global
    // queries in presence() and the findings list possible at all.
    const id = env.MARIO.idFromName('mario');
    return env.MARIO.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
