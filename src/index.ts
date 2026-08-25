// Entry point.

import { serve } from '@hono/node-server';
import { open } from './db';
import { loadConfig } from './config';
import { preflight } from './preflight';
import { createApp } from './http';
import { anthropicSummariser, runLuigiExclusive } from './luigi';

const cfg = loadConfig();
// Before open(): a misconfigured deploy should fail before it touches the volume.
preflight(cfg);
const db = open();

if (!cfg.allow.length) {
  console.warn(
    'mario: MARIO_ALLOWED_REPOS is empty — nothing will emit. This is the safe default, ' +
      'not a working configuration.',
  );
}

const summarise = anthropicSummariser(cfg);
const app = createApp({ db, cfg, summarise });

// The fold, in-process. One box, one process — there is no scheduler to operate
// and nothing to keep in sync with the deploy.
const FOUR_HOURS = 4 * 60 * 60 * 1000;
async function fold(): Promise<void> {
  if (!cfg.anthropicApiKey) return; // no key: events simply accumulate
  try {
    const out = await runLuigiExclusive(db, cfg, summarise);
    const folded = out.filter((o) => o.status === 'folded').length;
    if (out.length) console.log(`luigi: folded ${folded}/${out.length} project(s)`);
  } catch (err) {
    console.error('luigi: run failed', err);
  }
}
setInterval(() => void fold(), FOUR_HOURS).unref?.();
setTimeout(() => void fold(), 30_000).unref?.();

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, (info) =>
  console.log(`mario listening on :${info.port}`),
);

// A deploy replaces the container while the old one may hold the WAL file. Exit
// cleanly so SQLite is not killed mid-write.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    // A deadline, so one hung in-flight request cannot stall the drain until the
    // platform SIGKILLs us mid-write.
    const deadline = setTimeout(() => process.exit(1), 8000);
    deadline.unref?.();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
