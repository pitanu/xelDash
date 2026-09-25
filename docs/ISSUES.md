# Follow-up issues

Open:

- Select and add a project license before any public release.
- Pin `XELIS_DAEMON_IMAGE` to a tested release tag and define the upgrade process alongside
  the native hash implementation.
- Add a daemon healthcheck to Compose (the API and Stratum already have one).
- Verify the native share hash, the BLAKE3 block hash, and block submission against a real
  miner and devnet daemon before relying on persisted share data. Compare a recorded
  `blocks.hash` against `get_block_by_hash` after the first devnet block.
- Track block lifecycle after submission: poll or listen for the daemon's final block type
  and update `blocks.status` beyond `submitted` / `rejected`.
- Add per-IP connection and invalid-share rate limits; per-connection request queues are
  capped and unauthenticated handshakes time out.
- Add vardiff; Stratum currently uses a fixed configured target capped at network difficulty.
  Check the default target against realistic miner hashrates before trusting 5-minute estimates.
- Hash shares off the event loop (napi `AsyncTask` or a worker thread) and reuse the V3
  scratchpad instead of allocating one per share.
- Make the data model in `docs/PLAN.md` reference the migration instead of duplicating DDL
  with mismatched identity/count types.
- Reconcile remaining planning details: getwork support, TLS, default vardiff parameters,
  retention, dashboard authentication, and block lifecycle status names.

Resolved:

- Submitted block candidates are recorded in `blocks` and `service_events`.
- Stratum pushes new work on daemon `new_block` events; polling is only a fallback, and
  shares on superseded jobs are rejected as stale.
- Migrations run in a one-shot `migrate` service; Stratum no longer waits on API health.
- The API imports `@xeldash/db` by package name; the API route matcher uses parsed
  pathnames; Stratum shuts down its sessions, event watcher, and database pool cleanly.
