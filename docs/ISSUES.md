# Follow-up issues

Open:

- Test a third-party Stratum miner (SRBMiner, lolMiner or similar) against the devnet stack.
- Upstream glibc mismatch (built on Debian 13, shipped on cc-debian12; commit 99599508) is
  fixed upstream in commit f6ea12c (2026-09-27), not yet released: `1.25.0` and `latest`
  are still the broken build. When a fixed release ships, test it without the re-base in
  docker/daemon/Dockerfile and bump XELIS_DAEMON_IMAGE; the busybox wrapper stays.

Resolved:

- License (MIT) and name (xelDash) decided.
- Optional `proxy` profile (Caddy): HTTPS, a login for the dashboard, and a host-name check.
  The admin token moved to its own `X-Admin-Token` header so it works behind the login.
- Cleanup: PLAN.md and README.md describe the current project; the phase-1 spike client and
  notes are removed (their results are in `docs/DEVNET.md`).
- Security review (2026-09-27): three request-crash bugs, login flooding, worker limits,
  dashboard headers, snapshot links and more fixed; model and remaining risks in
  `docs/SECURITY.md`.
- Daemon settings editable from the dashboard (primary node only), with parser checks and rollback.
- Snapshots: official mainnet download (opt-in automatic on first start) and dashboard upload, behind an admin token.
- Multiple nodes with automatic failover and failback (`XELIS_RPC_URLS`, optional `daemon2`).
- Changelog, contributing guide, code of conduct, issue and pull request templates.
- CI workflow and multi-arch (amd64, arm64) release images on GHCR.
- Miner-reported hashrate is stored and shown next to the share-based estimate.
- Alerts (Discord, Telegram, JSON webhook) for blocks, mining pauses and offline workers.
- Backups (optional `backup` profile, restore steps) and an upgrade guide in
  `docs/OPERATIONS.md`.
- Stratum pauses work while the node is syncing or not responding, and resumes on its own.
- `docs/PLAN.md` section 5 summarizes the tables and points to the migrations instead of
  duplicating DDL.
- Native hash, MinerWork layout, block submission and BLAKE3 block hash verified on devnet
  (see `docs/DEVNET.md`).
- Shares are hashed on the libuv thread pool (`hashMinerWorkAsync`), reusing one V3
  scratchpad per thread.
- Per-IP connection limits, per-connection message rate limits, and timed bans for
  invalid submissions, stored in `bans` and reloaded on restart.
- Dashboard with Overview, Miner, Worker, Blocks and Health pages, served by the `web`
  service, with live updates over `/api/v1/live` (Postgres LISTEN/NOTIFY).
- Getwork endpoint (port 8090) with shares, vardiff and limits; verified with the official
  xelis_miner.
- Optional TLS Stratum listener (port 3334), verified with certificate-checked mining.
- Retention: 7 days raw shares, 90 days minute stats, hourly rollups kept; 30-day and
  1-year chart ranges.
- Vardiff per connection, with configurable defaults (see `docs/PLAN.md` section 6).
- Block lifecycle: submitted blocks move to `main-chain`, `side` or `orphaned` at stable
  height, with topoheight and miner reward.
- Daemon pinned to 1.25.0, re-based onto Debian 13 to work around the upstream glibc
  mismatch, with a Compose healthcheck and a documented upgrade check.
- Submitted block candidates are recorded in `blocks` and `service_events`.
- Stratum pushes new work on daemon `new_block` events; polling is only a fallback, and
  shares on superseded jobs are rejected as stale.
- Migrations run in a one-shot `migrate` service; Stratum no longer waits on API health.
- The API imports `@xeldash/db` by package name; the API route matcher uses parsed
  pathnames; Stratum shuts down its sessions, event watcher, and database pool cleanly.
