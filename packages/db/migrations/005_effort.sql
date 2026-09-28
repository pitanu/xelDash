-- Mining effort: each accepted share adds share difficulty / network difficulty (at the time
-- of the share), so the sum is how many blocks the work was expected to find. Round effort
-- and luck on the dashboard come from it. Stats recorded before this migration have none, so
-- luck is tracked from the first share after it.
ALTER TABLE worker_stats_1m
  ADD COLUMN sum_effort NUMERIC(40, 20) NOT NULL DEFAULT 0,
  ADD CONSTRAINT worker_stats_1m_effort_nonnegative CHECK (sum_effort >= 0);

ALTER TABLE worker_stats_1h
  ADD COLUMN sum_effort NUMERIC(40, 20) NOT NULL DEFAULT 0,
  ADD CONSTRAINT worker_stats_1h_effort_nonnegative CHECK (sum_effort >= 0);
