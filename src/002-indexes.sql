-- Two indexes, both added on measured evidence rather than intuition.

-- presence() UNIONs live rows with recent history from `events`, and `events`
-- has no index on ts — so it was a full table SCAN, 134ms at 1M rows and 3.5x
-- the window for the same cost (proof it was scanning, not reading a range).
--
-- That is not merely a slow /who. There is ONE synchronous connection in one
-- process, so a full scan blocks the event loop for every concurrent /check.
-- Measured: a dashboard tab polling /who every 250ms pushed check p99 from 5ms
-- to 137ms — a 27x degradation of the critical path caused by somebody else's
-- open browser tab. With this index, presence() drops 134ms -> 3.7ms (36x) and
-- check p99 returns to 5.4ms.
--
-- Cost: +3% storage, +3µs on `emit done`. The hot write — `emit touch` — never
-- writes to `events` at all, so it pays nothing.
--
-- The caveat that matters: this converts a full scan into a range seek, so it
-- helps in proportion to how SMALL the window is against the table. Measured
-- independently at 300k events spread over a year, a 48h window: 13.1ms -> 1.3ms.
-- Measured again with every event crammed INSIDE the window: no improvement at
-- all, because the query legitimately returns most of the table. The index is
-- not a substitute for the fact that presence() has no LIMIT — see below.
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

-- The triage index could serve `status` but not `project`, so a per-project
-- findings query filtered every open finding in the database, and the ORDER BY
-- could not be served at all. Measured at 100k findings: listFindings(project)
-- 7.2ms -> 0.024ms, and relevantFindings — which is on check's critical path —
-- 10.3ms -> 0.023ms.
--
-- This is a left-prefix superset of idx_findings_project, so that one is dropped
-- and the index count is unchanged. Pre-emptive at today's volume; it costs
-- nothing to have it already in place.
CREATE INDEX IF NOT EXISTS idx_findings_rank
  ON findings(project, status, seen_count DESC, updated_at DESC);
DROP INDEX IF EXISTS idx_findings_project;

-- STILL UNBOUNDED, deliberately not fixed here: presence() selects every row in
-- the window with no LIMIT and aggregates in JS. The index makes the seek cheap,
-- but a window that genuinely contains a million rows is slow regardless. That
-- has not bitten because the window is 48h and the table spans months — it would
-- bite on a bulk import or a backfill. If /who ever slows without the row count
-- growing, this is why.
