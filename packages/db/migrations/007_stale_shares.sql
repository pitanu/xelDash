-- Stale shares (found just after the network moved on) counted on their own. They are still
-- part of `rejected`; `stale` says how many of those were stale rather than invalid. Filled in
-- for the shares still on record; older stats keep 0.
ALTER TABLE worker_stats_1m
  ADD COLUMN stale BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT worker_stats_1m_stale_valid CHECK (stale >= 0 AND stale <= rejected);

ALTER TABLE worker_stats_1h
  ADD COLUMN stale BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT worker_stats_1h_stale_valid CHECK (stale >= 0 AND stale <= rejected);

UPDATE worker_stats_1m s SET stale = LEAST(f.stale, s.rejected)
FROM (
  SELECT date_trunc('minute', created_at) AS bucket, worker_id, count(*) AS stale
  FROM shares WHERE NOT accepted AND reject_reason = 'stale' GROUP BY 1, 2
) f
WHERE s.bucket = f.bucket AND s.worker_id = f.worker_id;

UPDATE worker_stats_1h s SET stale = LEAST(f.stale, s.rejected)
FROM (
  SELECT date_trunc('hour', bucket) AS bucket, worker_id, SUM(stale) AS stale
  FROM worker_stats_1m GROUP BY 1, 2
) f
WHERE s.bucket = f.bucket AND s.worker_id = f.worker_id;
