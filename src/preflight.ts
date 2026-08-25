// Startup posture check.
//
// The failure this exists to prevent is not a crash. It is a process that starts
// cleanly, answers every request, passes every health check, and records nothing
// — for weeks, because the only symptom was one `console.warn` that scrolled
// past on boot.
//
// Fatal conditions exit 78 (EX_CONFIG) so the platform reports a failed deploy
// instead of a healthy one. `MARIO_ALLOW_UNCONFIGURED=1` downgrades them all to
// warnings, which is what local development and a restore rehearsal want.

import type { Config } from './config';

export interface Posture {
  fatal: string[];
  warn: string[];
}

export function posture(cfg: Config, env: NodeJS.ProcessEnv = process.env): Posture {
  const fatal: string[] = [];
  const warn: string[] = [];
  const production = env.NODE_ENV === 'production';

  // First, because it is the only one that fails OPEN. Every other item here
  // makes the service do less than expected; this one makes it do more.
  if (production && cfg.devActor) {
    fatal.push(
      'MARIO_DEV_ACTOR is set with NODE_ENV=production. It bypasses Cloudflare Access ' +
        'entirely — actorFromRequest returns before any JWT check — so anyone who reaches ' +
        `the origin is authenticated as ${cfg.devActor}, including every admin route if ` +
        'that address is in MARIO_ADMINS. Unset it.',
    );
  }

  if (!cfg.allow.length) {
    fatal.push(
      'MARIO_ALLOWED_REPOS is empty. Scoping is an allow-list, so every emit is dropped ' +
        'as out-of-scope and every check returns clear. The service would run indefinitely ' +
        'and record nothing.',
    );
  }

  if (!cfg.devActor && (!cfg.accessTeamDomain || !cfg.accessAud)) {
    fatal.push(
      'MARIO_ACCESS_TEAM_DOMAIN and MARIO_ACCESS_AUD are required. Without them every ' +
        'browser request returns 401 — including /setup, so nobody can mint an endpoint.',
    );
  }

  if (!cfg.admins.length) {
    warn.push('MARIO_ADMINS is empty: no manual fold and no admin route, for anyone.');
  }

  if (!cfg.anthropicApiKey) {
    warn.push(
      'ANTHROPIC_API_KEY is unset: the fold is skipped every cycle, events accumulate ' +
        'unfolded, and no state document is ever written. Silent at runtime by design — ' +
        'reported here instead.',
    );
  }

  if (production && !env.MARIO_DB) {
    warn.push(
      'MARIO_DB is unset: the database defaults to the RELATIVE path "mario.db", which in ' +
        'a container lands on the writable layer and is destroyed on the next deploy.',
    );
  }

  return { fatal, warn };
}

export function preflight(cfg: Config, env: NodeJS.ProcessEnv = process.env): void {
  const { fatal, warn } = posture(cfg, env);

  for (const w of warn) console.warn(`mario: WARNING: ${w}`);
  if (!fatal.length) return;

  for (const f of fatal) console.error(`mario: FATAL: ${f}`);
  if (env.MARIO_ALLOW_UNCONFIGURED === '1') {
    console.error('mario: MARIO_ALLOW_UNCONFIGURED=1 — starting anyway. Never do this in production.');
    return;
  }
  console.error('mario: refusing to start. Set MARIO_ALLOW_UNCONFIGURED=1 to override.');
  process.exit(78); // EX_CONFIG
}
