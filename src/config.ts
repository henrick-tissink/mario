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

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function list(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  return {
    decayMs: num('MARIO_DECAY_MINUTES', 120, 1, 60 * 24 * 7) * 60_000,
    // Allow-list, not deny-list: an org nobody has considered is out, not in.
    // Defaulting to empty means a misconfigured deployment emits nothing rather
    // than everything.
    allow: list('MARIO_ALLOWED_REPOS'),
    stateMaxLines: num('MARIO_STATE_MAX_LINES', 15, 1, 200),
    maxSummary: num('MARIO_MAX_SUMMARY', 280, 40, 4000),
    maxFoldEvents: num('MARIO_MAX_FOLD_EVENTS', 500, 10, 10_000),
    admins: list('MARIO_ADMINS').map((e) => e.toLowerCase()),
    accessTeamDomain: process.env.MARIO_ACCESS_TEAM_DOMAIN ?? '',
    accessAud: process.env.MARIO_ACCESS_AUD ?? '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    foldModel: process.env.MARIO_FOLD_MODEL ?? 'claude-opus-5',
    devActor: process.env.MARIO_DEV_ACTOR,
  };
}

/** Guarded: an unset admin list denies, it does not throw mid-request. */
export function isAdmin(cfg: Config, actor: string): boolean {
  return cfg.admins.includes(actor.toLowerCase());
}

/** One line, trimmed, capped. Applied at the boundary to everything a caller sends. */
export function oneLine(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const first = String(s)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return null;
  return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first;
}
