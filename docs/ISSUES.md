# Follow-up issues

Open:

- Try the macOS and Linux launcher (`xeldash.sh`) on real systems: it was tested for what it writes and
  its network checks, but only run in Git Bash on Windows. The Windows launcher has been run end to end.
- Beginner help still to build: a "why is my rig not connecting?" panel that shows rejected logins (an
  invalid address, a wrong port), alerts set up from the dashboard with a test message, and published
  images so a first install pulls in a minute instead of building for ten.
- Someone who has never used a computer terminal should try the install once and tell us where they got stuck.
- Test more third-party Stratum miners (SRBMiner, lolMiner, OneZeroMiner) against the stack.
- Upstream glibc mismatch (built on Debian 13, shipped on cc-debian12; commit 99599508) is
  fixed upstream in commit f6ea12c (2026-09-27), not yet released: `1.25.0` and `latest`
  are still the broken build. When a fixed release ships, test it without the re-base in
  docker/daemon/Dockerfile and bump XELIS_DAEMON_IMAGE; the busybox wrapper stays.
- Ask the XELIS team to publish the release signing key (the checksums are signed with Ed25519
  key D29353EF21F021E7CC86F55A97BC1E87FA8D93AC, which is not on keys.openpgp.org or Slixe's
  GitHub profile). Then check signatures before switching versions.
- Tests (unit and integration) are deferred; see docs/PLAN.md section 10.

Resolved:

- The beginner path: launcher scripts, mainnet and snapshot defaults, the Get started page with sync
  progress and time left, the address checked by the node, copy-ready miner settings, and
  `address.worker` logins. Tested by running the Windows installer from a fresh folder.

- Node actions are recorded as events (Recent events, live updates) and version switches and
  failed copies send `node_update` alerts; tested on mainnet with a webhook and on devnet
  with a failing switch.
- Scheduled version switches at a block height, tested on mainnet (prepared on both nodes,
  switched at the height with no pause).
- Optional automatic node updates (off by default, two local nodes), tested on mainnet by
  moving daemon2 to 1.24.0 and letting it update itself.
- Daemon upgrades from the dashboard with official release binaries, tested on mainnet (both
  nodes to the 1.25.0 release build, one at a time) and for the switch-back on devnet (1.25.0
  cannot open a 1.21.3 database: "Invalid size").
- Both local nodes managed from the dashboard: stop, start, restart, per-node settings and
  snapshots, and copying one node's chain into the other (11 GB in about 90 s on mainnet).
- Fixed difficulty from the password, expected earnings, round effort and luck, XEL price,
  themes, a Settings page with explained options, and chart smoothing.
- ~10% stale shares with Rigel on mainnet: late shares after a new block are now accepted
  for 1.5 s, and later ones recorded as stale.
- Official node fallback and trusted peers, tested on mainnet.
- Redundant nodes and rolling updates tested on mainnet (daemon2 seeded from daemon's data).
  daemon2's `--priority-nodes=daemon:2125` was silently ignored (the daemon takes IP:port
  only); the entrypoint now resolves peer host names on each start.
- Rigel 1.23.0 (RTX 3060 Ti, about 8.7 KH/s) mines on mainnet through Stratum; all shares
  accepted. It sends classic Stratum without `"jsonrpc"`, which is now accepted.

- License (MIT) and name (xelDash) decided.
- Optional `proxy` profile (Caddy): HTTPS, a login for the dashboard, and a host-name check.
  The admin token moved to its own `X-Admin-Token` header so it works behind the login.
- Cleanup: PLAN.md and README.md describe the current project; the phase-1 spike client and
  notes are removed (their results are in `docs/DEVNET.md`).
- Security review (2026-09-27): three request-crash bugs, login flooding, worker limits,
  dashboard headers, snapshot links and more fixed; model and remaining risks in
  `docs/SECURITY.md`.
- Daemon settings editable from the dashboard, with parser checks and rollback.
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
- Stratum pushes new work on daemon `new_block` events; polling is only a fallback.
- Migrations run in a one-shot `migrate` service; Stratum no longer waits on API health.
- The API imports `@xeldash/db` by package name; the API route matcher uses parsed
  pathnames; Stratum shuts down its sessions, event watcher, and database pool cleanly.
