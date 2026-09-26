-- Hourly worker stats, rolled up from worker_stats_1m and kept indefinitely. Raw shares and
-- per-minute stats are deleted after their retention period (see packages/db/src/retention.js).

CREATE TABLE worker_stats_1h (
  bucket TIMESTAMPTZ NOT NULL,
  worker_id BIGINT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  accepted BIGINT NOT NULL DEFAULT 0,
  rejected BIGINT NOT NULL DEFAULT 0,
  sum_difficulty NUMERIC(40, 12) NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, worker_id),
  CONSTRAINT worker_stats_1h_counts_nonnegative CHECK (accepted >= 0 AND rejected >= 0),
  CONSTRAINT worker_stats_1h_difficulty_nonnegative CHECK (sum_difficulty >= 0)
);

CREATE INDEX worker_stats_1h_worker_bucket_idx ON worker_stats_1h (worker_id, bucket DESC);
CREATE INDEX worker_stats_1m_bucket_idx ON worker_stats_1m (bucket);
