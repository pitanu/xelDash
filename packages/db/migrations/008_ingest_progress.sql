-- A second server (the cluster's standby) records what it does while it mines, and sends it here in
-- batches. Each record carries an increasing sequence number; this table remembers the last one applied
-- for each sending server, so a batch that is sent twice (the reply was lost) is never counted twice.
CREATE TABLE ingest_progress (
  instance TEXT PRIMARY KEY,
  last_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ingest_progress_instance_length CHECK (length(instance) BETWEEN 1 AND 128)
);
