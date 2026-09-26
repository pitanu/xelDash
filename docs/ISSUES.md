# Follow-up issues

Open:

- Select and add a project license before any public release.
- Test a third-party Stratum miner (SRBMiner, lolMiner or similar) against the devnet stack.
- Recheck newer daemon images when upstream fixes the glibc mismatch in 1.22.0 and later.
- Add per-IP connection and invalid-share rate limits; per-connection request queues are
  capped and unauthenticated handshakes time out.
- Make the data model in `docs/PLAN.md` reference the migration instead of duplicating DDL
  with mismatched identity/count types.
- Reconcile remaining planning details: getwork support, TLS, retention, and dashboard
  authentication.

Resolved:

- Native hash, MinerWork layout, block submission and BLAKE3 block hash verified on devnet
  (see `docs/DEVNET.md`).
- Shares are hashed on the libuv thread pool (`hashMinerWorkAsync`), reusing one V3
  scratchpad per thread.
- Vardiff per connection, with configurable defaults (see `docs/PLAN.md` section 6).
- Block lifecycle: submitted blocks move to `main-chain`, `side` or `orphaned` at stable
  height, with topoheight and miner reward.
- Daemon pinned to 1.21.3 with a Compose healthcheck and a documented upgrade check.
- Submitted block candidates are recorded in `blocks` and `service_events`.
- Stratum pushes new work on daemon `new_block` events; polling is only a fallback, and
  shares on superseded jobs are rejected as stale.
- Migrations run in a one-shot `migrate` service; Stratum no longer waits on API health.
- The API imports `@xeldash/db` by package name; the API route matcher uses parsed
  pathnames; Stratum shuts down its sessions, event watcher, and database pool cleanly.
