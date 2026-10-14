-- Rejected shares counted per worker, minute and reason, in place of a row for every share. The raw shares were only read for the
-- last day's reject reasons (everything else comes from the minute and hourly stats), and duplicates are now caught by Stratum,
-- so nothing writes to `shares` any more. The reasons of the shares still on record are counted here, so the last day stays
-- visible. The table itself is left for retention to empty (an older version going back to it still finds it).
CREATE TABLE worker_rejects_1m (
  worker_id BIGINT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  bucket TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  count BIGINT NOT NULL,
  PRIMARY KEY (worker_id, bucket, reason),
  CONSTRAINT worker_rejects_count_positive CHECK (count > 0)
);
-- For the retention job, which deletes by age across all workers.
CREATE INDEX worker_rejects_1m_bucket_idx ON worker_rejects_1m (bucket);

INSERT INTO worker_rejects_1m (worker_id, bucket, reason, count)
SELECT worker_id, date_trunc('minute', created_at), reject_reason, count(*)
FROM shares
WHERE NOT accepted
GROUP BY 1, 2, 3;
