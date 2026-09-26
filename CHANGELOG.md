# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may include
breaking changes; they are marked **Breaking**.

## [Unreleased]

First public version, planned as 0.1.0.

### Mining

- Stratum server for XELIS (`xel/v3`) with per-address work: rewards go straight to each
  miner's address, and xelDash holds no funds.
- Share validation with the official XELIS Hash V3 code (native addon), hashed on a thread
  pool. Hashing, MinerWork layout, block hash and block submission are verified against the
  daemon on devnet.
- Per-connection vardiff (10 s per share by default).
- Getwork endpoint (port 8090) for the official `xelis_miner`, with the same stats and
  limits as Stratum.
- Optional TLS Stratum port (3334).
- Several nodes in priority order (`XELIS_RPC_URLS`), with an optional second node in
  Compose: mining fails over within seconds and moves back when the preferred node is in
  sync, so node upgrades do not stop mining.
- Work is paused while no node is in sync, and resumes on its own.
- Per-IP connection and message limits, and timed bans for invalid submissions.
- Block tracking: submitted blocks end as main chain, side or orphaned at the stable
  height, with their reward.

### Dashboard and API

- Overview, Miner, Worker, Blocks and Health pages, in light and dark mode, with live
  updates over WebSocket.
- Hashrate charts from 6 hours to 1 year, estimated from accepted shares, next to the
  hashrate miners report.
- REST API for all dashboard data.
- Alerts to Discord, Telegram or a JSON webhook: blocks found and final, mining paused and
  resumed, workers offline.

### Operations

- Docker Compose stack; the daemon runs XELIS 1.25.0, which mainnet requires (1.24.0 or
  newer).
- Daemon settings from the dashboard: every option of the installed XELIS daemon, checked by
  the daemon's own parser before a restart and rolled back if the node does not stay up.
  Needs `XELDASH_ADMIN_TOKEN`.
- Snapshots: start or replace a node's chain data from the official daily mainnet snapshot
  (downloaded, resumable, checksum-verified) or a zip dropped onto the dashboard. Optional
  automatic download on a first start. Needs `XELDASH_ADMIN_TOKEN`.
- Share retention (raw 7 days, per-minute 90 days, hourly kept) with an hourly rollup.
- Optional daily database backups, and a guide for backups, restores and upgrades.
- Multi-arch images (amd64, arm64) published to GHCR on version tags; CI on every push.
