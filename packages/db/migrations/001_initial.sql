-- Core identity, share, block, and operational event tables.
-- Raw share partitioning and retention are intentionally deferred until limits are chosen.

CREATE TABLE miners (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT miners_address_nonempty CHECK (length(address) > 0)
);

CREATE TABLE workers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  miner_id BIGINT NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'default',
  last_ip INET,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workers_name_length CHECK (length(name) BETWEEN 1 AND 128),
  CONSTRAINT workers_miner_name_unique UNIQUE (miner_id, name)
);

CREATE INDEX workers_last_seen_idx ON workers (last_seen DESC);

CREATE TABLE shares (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id BIGINT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  difficulty NUMERIC(40, 12) NOT NULL,
  accepted BOOLEAN NOT NULL,
  reject_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shares_job_id_nonempty CHECK (length(job_id) > 0),
  CONSTRAINT shares_difficulty_positive CHECK (difficulty > 0),
  CONSTRAINT shares_rejection_reason_consistent CHECK (accepted OR reject_reason IS NOT NULL)
);

CREATE INDEX shares_worker_created_idx ON shares (worker_id, created_at DESC);
CREATE INDEX shares_created_idx ON shares (created_at DESC);
CREATE UNIQUE INDEX shares_no_duplicate_accepted_idx
  ON shares (worker_id, job_id, nonce)
  WHERE accepted;

CREATE TABLE worker_stats_1m (
  bucket TIMESTAMPTZ NOT NULL,
  worker_id BIGINT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  accepted BIGINT NOT NULL DEFAULT 0,
  rejected BIGINT NOT NULL DEFAULT 0,
  sum_difficulty NUMERIC(40, 12) NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, worker_id),
  CONSTRAINT worker_stats_counts_nonnegative CHECK (accepted >= 0 AND rejected >= 0),
  CONSTRAINT worker_stats_difficulty_nonnegative CHECK (sum_difficulty >= 0)
);

CREATE INDEX worker_stats_worker_bucket_idx ON worker_stats_1m (worker_id, bucket DESC);

CREATE TABLE blocks (
  hash TEXT PRIMARY KEY,
  height BIGINT,
  topoheight BIGINT,
  miner_id BIGINT REFERENCES miners(id) ON DELETE SET NULL,
  worker_id BIGINT REFERENCES workers(id) ON DELETE SET NULL,
  reward NUMERIC(40, 0), -- daemon atomic units; format only at the API boundary
  status TEXT NOT NULL,
  found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blocks_hash_nonempty CHECK (length(hash) > 0),
  CONSTRAINT blocks_height_nonnegative CHECK (height IS NULL OR height >= 0),
  CONSTRAINT blocks_topoheight_nonnegative CHECK (topoheight IS NULL OR topoheight >= 0),
  CONSTRAINT blocks_reward_nonnegative CHECK (reward IS NULL OR reward >= 0)
);

CREATE INDEX blocks_found_at_idx ON blocks (found_at DESC);
CREATE INDEX blocks_status_updated_idx ON blocks (status, updated_at DESC);

CREATE TABLE bans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip INET NOT NULL,
  reason TEXT,
  until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bans_ip_until_idx ON bans (ip, until DESC);

CREATE TABLE service_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_events_type_nonempty CHECK (length(type) > 0)
);

CREATE INDEX service_events_created_idx ON service_events (created_at DESC);
