-- The hashrate each worker reports about itself (Stratum mining.hashrate), shown next to the
-- estimate from accepted shares. Only the latest value is kept.
ALTER TABLE workers
  ADD COLUMN reported_hashrate DOUBLE PRECISION,
  ADD COLUMN reported_at TIMESTAMPTZ,
  ADD CONSTRAINT workers_reported_hashrate_nonnegative CHECK (reported_hashrate IS NULL OR reported_hashrate >= 0);
