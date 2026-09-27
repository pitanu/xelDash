# xelDash: Project Plan

*Last updated: 2026-09-27. Status: Phases 1 to 5 done and verified on a private devnet;
mainnet trial done and Rigel tested; Phase 6 (release) waits on more third-party miner tests.*

Each section is marked **Decided**, **Draft** (a proposal to confirm), or **Open** (not
discussed yet). Decisions are recorded in [DECISIONS.md](DECISIONS.md); open work is in
[ISSUES.md](ISSUES.md).

---

## 1. Scope and users (Decided)

- An open-source, self-hosted XELIS solo mining server and statistics dashboard, run with
  Docker Compose and intended for LAN use.
- Whoever deploys it runs their own XELIS node (or two). Miners connect to the LAN Stratum or
  getwork endpoint; public internet exposure is outside the v1 deployment model.
- Validated shares provide pool-quality worker and miner hashrate, share history, and
  time-to-block estimates. Only solved blocks are submitted, to the operator's own node.
- Each found block pays the address authorized by its miner. xelDash does not split rewards,
  hold funds, track balances, run payouts, or use a hot wallet.
- Each connection authorizes with its own `xel:` address; the operator can configure a
  default address for miners that do not send one.

**Non-goals (for v1):** shared-reward pool mining (PPLNS/PPS), fees, custodial wallets.

## 2. Architecture (Decided)

```
 miners ──► stratum (Stratum :3333, TLS :3334, getwork :8090) ──► daemon [, daemon2]
                │ shares, blocks, events                             ▲  (RPC internal only)
                ▼                                                    │ settings, snapshots
            PostgreSQL ◄── api (REST + live WebSocket, alerts)    node-admin
                                ▲                                    ▲
 browser ──► web (nginx: dashboard, /api → api, /api/v1/node → node-admin)
```

| Service      | Responsibility | Exposed to host? |
|--------------|----------------|------------------|
| `daemon`     | Official XELIS daemon (re-based image) under a small supervisor that applies settings and snapshots | P2P on loopback by default; RPC internal |
| `daemon2`    | Optional second node for failover and one-at-a-time upgrades (profile `redundant`) | No |
| `stratum`    | Miner connections, jobs, share validation, vardiff, block submission, node failover, retention | LAN (loopback by default) |
| `api`        | Stats, health, live updates, alerts | LAN (loopback by default) |
| `web`        | React dashboard behind nginx | LAN (loopback by default) |
| `node-admin` | Daemon settings and snapshots for the dashboard (admin token) | No |
| `postgres`, `migrate` | Storage and one-shot schema migrations | No |
| `backup`     | Optional daily database dumps (profile `backup`) | No |

## 3. Mining protocols (Decided; third-party miner tests open)

- **Stratum** follows the [official XELIS Stratum protocol](https://docs.xelis.io/developers-api/stratum)
  and negotiates `xel/v3` and its documented aliases.
- **Getwork** (port 8090) for miners that only speak getwork, such as the official
  xelis_miner. Jobs carry the share difficulty, so those miners submit shares too.
- **TLS Stratum** (port 3334) is optional: `STRATUM_TLS_ENABLED=true` and a certificate in
  `docker/stratum-tls/`.
- **Miner compatibility (open):** verified with our devnet test miner and xelis_miner
  1.21.3 over getwork, and with Rigel 1.23.0 over Stratum on mainnet. SRBMiner, lolMiner,
  OneZeroMiner and others still need a run (issue template: "Miner compatibility report").
- **Algorithm:** XELIS Hash V3 (block versions 3 to 7). A future algorithm needs a new
  addon release before its fork height; see [OPERATIONS.md](OPERATIONS.md#algorithm-changes).

## 4. Daemon integration (Decided)

- Work comes from the daemon's `get_block_template` and `get_miner_work` for each miner's
  address; solved blocks go back with `submit_block`. Verified on devnet with daemon 1.21.3
  and 1.25.0: our V3 hash, MinerWork layout and BLAKE3 block hash match the daemon's.
- New work is pushed on the daemon's `new_block` event, with polling as the fallback.
- A node is usable while it responds and its peers' median topoheight is at most 16 ahead
  (two consecutive 5-second checks). No peers counts as ready (normal on devnet); the Health
  page warns about it.
- Several nodes (`XELIS_RPC_URLS`, in priority order): Stratum mines through the first
  usable node that is not more than 16 topoheights behind another of ours, fails over without
  disconnecting miners, and fails back when the preferred node recovers. Blocks go to the
  node that issued the job, then to the others if it is unreachable. With no usable node,
  miners are disconnected and logins refused until one recovers.
- A block is final once its height is at or below the daemon's `stableheight`: Normal and
  Sync become `main-chain`, Side becomes `side`, Orphaned (or unknown) becomes `orphaned`.
- Mainnet needs daemon 1.24.0 or newer (V7 fork at 6,909,122). The tested release is 1.25.0.
- The network (`mainnet`, `testnet`, `devnet`) is chosen with `XELIS_NETWORK`.

## 5. Data model (Decided)

PostgreSQL, with plain SQL migrations applied in order by the one-shot `migrate` service.
The migrations in [`packages/db/migrations/`](../packages/db/migrations/) are the source of
truth for columns, types and constraints; this section only summarizes them.

| Table | Holds | Written by | Kept |
|-------|-------|-----------|------|
| `miners` | One row per mining address | Stratum (on authorize) | Forever |
| `workers` | Worker names per address, last IP, reported hashrate | Stratum | Forever |
| `shares` | Every submission: difficulty, accepted or reject reason | Stratum | 7 days |
| `worker_stats_1m` | Per-worker, per-minute accepted/rejected counts and difficulty sum | Stratum, with each share | 90 days |
| `worker_stats_1h` | Hourly rollup of the minute stats | Stratum's hourly retention job | Forever |
| `blocks` | Block candidates with status, topoheight and miner reward | Stratum (submit and block tracker) | Forever |
| `bans` | Stratum IP bans with reason and expiry | Stratum | Forever |
| `service_events` | Blocks, bans, node switches and pauses, Stratum starts | Stratum | Forever |

Notes:

- Hashrate is accepted share difficulty divided by elapsed seconds over completed buckets
  (section 6). The API reads minute stats for ranges up to 30 days and hourly rollups for a year.
- Every `service_events` insert is announced on the `xeldash_live` channel for live updates.
- Retention periods are set with `RETENTION_*`. There is no partitioning at this size.
- There are no balance, payout or wallet tables: rewards go straight to each miner's address.

## 6. Difficulty and stats (Decided)

- V3 hashes are compared as big-endian U256 values against `floor((2^256 - 1) / difficulty)`,
  matching XELIS consensus.
- Estimated H/s is the accepted share difficulty over a completed window (5 minutes, 1 hour,
  24 hours), divided by its length. Expected time-to-block is network difficulty divided by
  that hashrate; the API returns `null` when a window has no accepted shares. Miners'
  self-reported hashrate is shown next to it.
- Vardiff per connection: start at 100,000 and aim for one share every 10 seconds; retarget
  after 60 seconds or 20 accepted shares, by at most 2x, skipping changes under 50%, between
  1,000 and the network difficulty.
- Shares are hashed (on a thread pool) before they are recorded; low-difficulty and
  duplicate shares are recorded as rejected; malformed and stale ones are refused.

## 7. Security (Decided)

LAN-only by default; the model, protections and remaining risks are in
[SECURITY.md](SECURITY.md). In short: nothing sensitive is published, Stratum and getwork
have per-IP connection, message and ban limits, the dashboard sends a strict
Content-Security-Policy, and every change to the node (settings, snapshots) needs
`XELDASH_ADMIN_TOKEN`. Viewing the dashboard needs no login by default; the optional `proxy` service adds
HTTPS, a login and a host-name check.

## 8. API and dashboard (Decided)

- Pages: Overview, Miner, Worker, Blocks, Health, and Node (daemon settings and snapshots).
  Light and dark mode, phone-sized layouts, live updates over `/api/v1/live` with polling as
  the fallback.
- REST endpoints (all `GET`; `address` must be a valid `xel:`/`xet:` address; `worker` needs
  `address`): `/api/v1/overview`, `/api/v1/status`, `/api/v1/hashrate`, `/api/v1/miners`,
  `/api/v1/miners/{address}`, `/api/v1/miners/{address}/workers/{name}`, `/api/v1/blocks`,
  `/api/v1/events`. node-admin serves `/api/v1/node/settings` and `/api/v1/node/snapshot/*`.
- Alerts to Discord, Telegram or a JSON webhook: blocks found and final, mining paused,
  resumed or switched, workers offline. See [OPERATIONS.md](OPERATIONS.md#alerts).

## 9. Deployment and operations (Decided)

- One `docker-compose.yml` and `.env.example`. Images build locally by default, or are pulled
  from GHCR (amd64 and arm64) by setting `XELDASH_VERSION`.
- Healthchecks and `restart: unless-stopped` on every long-running service.
- Daemon pinned with `XELIS_DAEMON_IMAGE`; daemon settings and snapshots from the dashboard.
- Optional second node, backups, alerts, and the upgrade guide: [OPERATIONS.md](OPERATIONS.md).

## 10. Testing (Draft, deferred)

- Today: the devnet checks in [DEVNET.md](DEVNET.md) (our test miner, the official miner over
  getwork, two-node failover, snapshots), plus typecheck and image builds in CI.
- Planned later: unit tests for Stratum parsing, vardiff and hashrate math; hash test vectors;
  integration tests against the Compose stack; a load test with many simulated miners.

## 11. Open-source project setup (Decided)

- License: MIT (`LICENSE`).
- CI (typecheck, dashboard build, Compose validation, image builds) and multi-arch release
  images on `v*.*.*` tags.
- SemVer and `CHANGELOG.md`; `CONTRIBUTING.md`, code of conduct, issue and PR templates.
- JavaScript with JSDoc and TypeScript `checkJs`; Rust for the hash addon; npm workspaces.

---

## Repository layout

```
docker-compose.yml, .env.example
services/
  stratum/        Stratum, getwork, node pool, block tracker, retention (Node.js)
  api/            REST API, live updates, alerts (Node.js)
  node-admin/     daemon settings and snapshots for the dashboard (Node.js)
web/              React + Vite + Tailwind dashboard, nginx config
packages/
  db/             migrations, migration runner, shared queries
  xelis-hash/     XELIS Hash V3 native addon (Rust, napi-rs)
docker/
  daemon/         daemon image wrapper and supervisor entrypoint
  backup/         backup script
  stratum-tls/    optional Stratum TLS certificate
docs/             PLAN, DECISIONS, ISSUES, OPERATIONS, SECURITY, DEVNET
```

## Build phases

| # | Phase | Goal / done when | Status |
|---|-------|------------------|--------|
| 0 | Planning | Enough decided to start the spike | Done |
| 1 | Spike | Daemon runs in Docker; template to block on devnet; hash addon matches the daemon | Done |
| 2 | Minimal Stratum | A miner connects, shares are validated, blocks reach the chain | Done |
| 3 | Multi-miner | Vardiff, per-address work, shares and blocks stored, reconnects | Done |
| 4 | Dashboard | API and React UI with live stats | Done |
| 5 | Hardening | Limits, bans, optional TLS, node failover, security review | Done |
| 6 | Release | Mainnet trial, third-party miners, v0.1.0 tag | Current |

## Known technical risks

1. **Algorithm and hard-fork changes:** the daemon and the hash addon must be upgraded
   together, before the fork height.
2. **Untested on mainnet:** sync behavior, failover and snapshots have only run on a private
   devnet. A mainnet trial is the main release check.
3. **Upstream daemon images:** releases from 1.22.0 on need the Debian 13 re-base
   ([docker/daemon/README.md](../docker/daemon/README.md)) until the upstream fix ships.
