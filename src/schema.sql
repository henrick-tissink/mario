-- mario v1
--
-- The system this replaces kept one `events` table for four different kinds of
-- thing, and paid for it four times over: a `kind != 'finding'` filter repeated
-- in every fold query, presence collapsed in application code (a read-then-write
-- race that silently lost the very paths collision detection exists to report),
-- a `status` column meaningful for one kind only, and an invariant — "findings
-- are never compacted" — that lived in a comment and had to be remembered.
--
-- Three purpose-built tables are simpler than one general one. Each has exactly
-- one lifecycle:
--   presence  is live and mutable   -> upserted in place, expires by time
--   findings  are durable           -> deduped on write, never folded away
--   events    are the narrative     -> append-only, folded and stamped

CREATE TABLE projects (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- One row per repo the system has ever resolved, written on first sight. An
-- "umbrella" project is simply several repos pointing at one slug — created by
-- editing this table, which is the only way and is now documented as such.
CREATE TABLE repos (
  repo        TEXT PRIMARY KEY,          -- normalised: host/owner/.../name
  project     TEXT NOT NULL REFERENCES projects(slug),
  first_seen  INTEGER NOT NULL
);

-- PRESENCE — "who is in this code right now".
--
-- The composite primary key is the whole point: an emit is a single atomic
-- upsert, so two concurrent hook processes in one session cannot lose each
-- other's paths. No application-level read-then-write, no lost updates.
CREATE TABLE presence (
  actor       TEXT NOT NULL,
  session     TEXT NOT NULL,
  project     TEXT NOT NULL,
  repo        TEXT,
  branch      TEXT,
  agent       TEXT,                      -- claude | codex | null
  paths       TEXT NOT NULL DEFAULT '[]',-- JSON array, most-recent-last
  note        TEXT,                      -- optional one-line claim
  created_at  INTEGER NOT NULL,          -- set on insert only; never refreshed
  writes      INTEGER NOT NULL DEFAULT 1,-- refreshes folded into this row
  ts          INTEGER NOT NULL,          -- last refresh; decay is measured off this
  PRIMARY KEY (actor, session, project)
);
CREATE INDEX idx_presence_project ON presence(project, ts DESC);
CREATE INDEX idx_presence_ts      ON presence(ts DESC);

-- FINDINGS — the durable backlog, and the reason the system exists.
--
-- `dedupe` is NOT NULL and UNIQUE rather than a partial index: every finding has
-- a key, so the constraint is total and the upsert needs no conflict predicate.
-- A closing note lives in its own column and is never concatenated into the
-- summary — appending it there meant a reopened finding carried a stale
-- resolution forever, and a NULL summary was wiped outright by the concatenation.
CREATE TABLE findings (
  id           TEXT PRIMARY KEY,
  dedupe       TEXT NOT NULL UNIQUE,     -- sha256(project + normalised summary)
  project      TEXT NOT NULL,
  repo         TEXT,
  summary      TEXT NOT NULL,
  paths        TEXT NOT NULL DEFAULT '[]',
  first_actor  TEXT NOT NULL,
  seen_count   INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  close_note   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER
);
CREATE INDEX idx_findings_triage  ON findings(status, seen_count DESC, updated_at DESC);
CREATE INDEX idx_findings_project ON findings(project, status);

-- EVENTS — the narrative Luigi folds. Append-only; stamped, never deleted.
--
-- `worked` rows are swept-up presence: when a presence row falls outside the
-- decay window it stops being a live claim and becomes history, in one
-- transaction, so the fold has a single input and presence stays small.
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  agent      TEXT,
  session    TEXT,
  project    TEXT NOT NULL,
  repo       TEXT,
  branch     TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('claim', 'done', 'worked')),
  summary    TEXT,
  paths      TEXT NOT NULL DEFAULT '[]',
  folded_at  INTEGER
);
CREATE INDEX idx_events_unfolded ON events(project, ts) WHERE folded_at IS NULL;

-- STATE — Luigi's only output. One row per project, replaced each run.
-- `folded_thru` is authoritative: the fold stamps exactly the rows it summarised,
-- never a time range that might contain rows it never read.
CREATE TABLE state (
  project      TEXT PRIMARY KEY REFERENCES projects(slug),
  doc          TEXT NOT NULL,
  folded_thru  INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- TOKENS — per-user endpoints. The token IS the actor identity: nothing on the
-- wire carries an `actor`, so an agent can neither forget it nor spoof another.
-- Only the lowercase hex sha256 is stored; plaintext is shown once.
CREATE TABLE tokens (
  hash        TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX idx_tokens_actor ON tokens(actor) WHERE revoked_at IS NULL;
