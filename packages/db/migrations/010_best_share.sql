-- Best share: the best accepted share of a worker in a minute (or an hour), as a fraction of a block, that is its achieved
-- difficulty divided by the network difficulty when it was found (1 = a block). Stored as a fraction rather than a difficulty, so it
-- stays right while the network difficulty moves. Empty for the minutes before this migration, and while XELDASH_BEST_SHARE=off.
ALTER TABLE worker_stats_1m ADD COLUMN best_share DOUBLE PRECISION;
ALTER TABLE worker_stats_1h ADD COLUMN best_share DOUBLE PRECISION;
