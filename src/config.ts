// Server configuration.
//
// Every numeric read is validated. The system this replaces used
// `Number(env.X || default)`, which silently turned "0" into the default and a
// typo into NaN — and a NaN decay window makes every `ts > now - decay`
// comparison false, emptying every collision query with no error anywhere.

export interface Config {
  /** How long a presence row counts as an active claim. The one tuning knob. */
  decayMs: number;
  /** Repo prefixes permitted to emit. Empty means nothing emits. */
  allow: string[];
  /** Hard cap on a state document, in lines. */
  stateMaxLines: number;
  /** Hard cap on any caller-supplied summary, in characters. */
  maxSummary: number;
  /** Max events fed to one fold. */
  maxFoldEvents: number;
  admins: string[];
  accessTeamDomain: string;
  accessAud: string;
  /** Absent means the fold is skipped and events stay in the tail. */
  anthropicApiKey?: string;
  foldModel: string;
  /** Local development only. Never set this in production. */
  devActor?: string;
}

/** The environment, as data. Node passes `process.env`; a Worker passes `env`. */
export type EnvLike = Record<string, string | undefined>;

function num(env: EnvLike, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function list(env: EnvLike, name: string, fallback: string[] = []): string[] {
  const raw = env[name];
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: EnvLike = process.env): Config {
  return {
    decayMs: num(env, 'MARIO_DECAY_MINUTES', 120, 1, 60 * 24 * 7) * 60_000,
    // Allow-list, not deny-list: an org nobody has considered is out, not in.
    // Defaulting to empty means a misconfigured deployment emits nothing rather
    // than everything.
    allow: list(env, 'MARIO_ALLOWED_REPOS'),
    stateMaxLines: num(env, 'MARIO_STATE_MAX_LINES', 15, 1, 200),
    maxSummary: num(env, 'MARIO_MAX_SUMMARY', 280, 40, 4000),
    maxFoldEvents: num(env, 'MARIO_MAX_FOLD_EVENTS', 500, 10, 10_000),
    admins: list(env, 'MARIO_ADMINS').map((e) => e.toLowerCase()),
    accessTeamDomain: env.MARIO_ACCESS_TEAM_DOMAIN ?? '',
    accessAud: env.MARIO_ACCESS_AUD ?? '',
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    foldModel: env.MARIO_FOLD_MODEL ?? 'claude-opus-5',
    devActor: env.MARIO_DEV_ACTOR,
  };
}

/** Guarded: an unset admin list denies, it does not throw mid-request. */
export function isAdmin(cfg: Config, actor: string): boolean {
  return cfg.admins.includes(actor.toLowerCase());
}

/**
 * One line, trimmed, capped, control characters stripped.
 *
 * This is the boundary function for EVERY caller-supplied string that can reach
 * another developer's agent context. It was previously applied to `summary`
 * only, so `branch` arrived with newlines and no length bound and broke clean
 * out of its slot in the rendered output — one token holder could plant text
 * that the SessionStart hook fed into every other agent on the team.
 *
 * Newlines are the specific danger: the rendered block is line-oriented, so a
 * newline is how attacker text stops looking like a field value and starts
 * looking like a new instruction.
 */
export function oneLine(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  const first = String(s)
    .split(/[\r\n\u2028\u2029]/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return null;
  // Strip C0/C1 controls and zero-width/bidi marks, which can hide or reorder
  // text in a terminal without appearing in its length.
  const clean = first
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  if (!clean) return null;
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}
