# Architecture

How xelDash is built: the services, the mining protocols, how it talks to XELIS nodes, the data
model and the security model. For using it, start with [Getting started](GETTING-STARTED.md).

---

## 1. Scope and users

- An open-source, self-hosted XELIS solo mining server and statistics dashboard, run with
  Docker Compose and intended for a home or office network.
- Whoever deploys it runs their own XELIS node (or two). Miners connect to the LAN Stratum or
  getwork endpoint; it is not meant to be reachable from the internet, and refuses connections from outside your networks by default.
- Validated shares provide pool-quality worker and miner hashrate, share history, and
  time-to-block estimates. Only solved blocks are submitted, to the operator's own node.
- Each found block pays the address authorized by its miner. xelDash does not split rewards,
  hold funds, track balances, run payouts, or use a hot wallet.
- Each connection authorizes with its own `xel:` address; the operator can configure a
  default address for miners that do not send one.

**Non-goals:** shared-reward pool mining (PPLNS/PPS), fees, custodial wallets.

## 2. Architecture

```
 miners ──► stratum (Stratum :3333, TLS :3334, getwork :8090) ──► daemon [, daemon2]
                │ shares, blocks, events                             ▲  (RPC internal only)
                ▼                                                    │ settings, snapshots
            PostgreSQL ◄── api (REST + live WebSocket, alerts)    node-admin ──► GitHub releases
                                ▲                                    ▲  (settings, snapshots,
 browser ──► web (nginx: dashboard, /api → api, /api/v1/node → node-admin)   versions, stop/start)
```

node-admin, Stratum and the API share a small config volume (`/config`). node-admin writes it;
Stratum and the API read it: the dashboard's switches (official node fallback, automatic updates,
scheduled upgrade), the mining address and the alert settings. Stratum can add the XELIS team's
public node as a last-resort work source when the fallback is on.

Containers sit on three Compose networks: `edge` (dashboard and proxy), `node` (the daemons) and
`data`, which is internal (no route out). Only the API, Stratum, node-admin and the migration and
backup jobs join `data`, so the database is unreachable from the web container and from outside.

| Service      | Responsibility | Exposed to host? |
|--------------|----------------|------------------|
| `daemon`     | Official XELIS daemon (re-based image) under a small supervisor that applies settings, snapshots, stop and start, and release versions | P2P on loopback by default; RPC internal |
| `daemon2`    | Optional second node for failover and one-at-a-time upgrades (profile `redundant`) | No |
| `stratum`    | Miner connections, jobs, share validation, vardiff, block submission, node failover, retention | LAN (loopback by default) |
| `api`        | Stats, health, live updates, alerts | LAN (loopback by default) |
| `web`        | React dashboard behind nginx | LAN (loopback by default) |
| `node-admin` | For each local node: settings, snapshots and copies, stop and start, version switches (now, at a height, or automatic); the fallback switch, the mining address and the alert settings (admin token) | No |
| `postgres`, `migrate` | Storage and one-shot schema migrations | No |
| `backup`     | Optional daily database dumps (profile `backup`) | No |

## 3. Mining protocols

- **Stratum** follows the [official XELIS Stratum protocol](https://docs.xelis.io/developers-api/stratum)
  and negotiates `xel/v3` and its documented aliases.
- **Getwork** (port 8090) for miners that only speak getwork, such as the official
  xelis_miner. Jobs carry the share difficulty, so those miners submit shares too.
- **TLS Stratum** (port 3334) is optional: `STRATUM_TLS_ENABLED=true` and a certificate in
  `docker/stratum-tls/`.
- **Classic Stratum** without `"jsonrpc"` is accepted (Rigel sends it that way), and so are `address.worker` user names and
  `[user, password]` logins, which most third-party miners use. The password
  may carry a fixed difficulty (`d=50000`).
- **Miner compatibility:** verified with our devnet test miner and xelis_miner
  1.21.3 over getwork, and with Rigel 1.23.0 over Stratum on mainnet. SRBMiner, lolMiner,
  OneZeroMiner and others have not been tested yet (issue template: "Miner compatibility report").
- **Who may connect:** `XELDASH_ALLOWED_NETWORKS` (default: private networks and this computer).
  Connections from elsewhere are refused and recorded, so the dashboard can say why a miner could not
  connect. Docker Desktop hides the real address of a client; see [SECURITY.md](SECURITY.md).
- **Algorithm:** XELIS Hash V3 (block versions 3 to 7). A future algorithm needs a new
  addon release before its fork height; see [OPERATIONS.md](OPERATIONS.md#algorithm-changes).

## 4. Daemon integration

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
- **Official node fallback** (optional, off by default): Stratum mines through the XELIS team's
  public node only while none of ours can issue work. The reward key is still looked up on
  our own node whenever it answers.
- **Trusted peers:** priority or exclusive `IP:port` peers per node from the dashboard;
  daemon2 peers with daemon by service name, resolved to an address on each start.
- **Versions:** each node runs its image's daemon or a downloaded official release. Switches
  go one node at a time (the usual mining node last), each back in sync before the next,
  with a 30-second automatic switch-back; now, at a block height, or automatically (optional,
  two local nodes, 24 hours after a release).
- A block is final once its height is at or below the daemon's `stableheight`: Normal and
  Sync become `main-chain`, Side becomes `side`, Orphaned (or unknown) becomes `orphaned`.
- Mainnet needs daemon 1.24.0 or newer (V7 fork at 6,909,122). Tested on mainnet: 1.25.0,
  both the Docker image build and the GitHub release build, and 1.24.0 on the same database.
- The network (`mainnet`, `testnet`, `devnet`) is chosen with `XELIS_NETWORK`.

## 5. Data model

PostgreSQL, with plain SQL migrations applied in order by the one-shot `migrate` service.
The migrations in [`packages/db/migrations/`](../packages/db/migrations/) are the source of
truth for columns, types and constraints; this section only summarizes them.

| Table | Holds | Written by | Kept |
|-------|-------|-----------|------|
| `miners` | One row per mining address | Stratum (on authorize) | Forever |
| `workers` | Worker names per address, last IP, reported hashrate | Stratum | Forever |
| `shares` | Every submission: difficulty, accepted or reject reason | Stratum | 7 days |
| `worker_stats_1m` | Per-worker, per-minute accepted, rejected and stale counts, difficulty sum and effort sum | Stratum, with each share | 90 days |
| `worker_stats_1h` | Hourly rollup of the minute stats | Stratum's hourly retention job | Forever |
| `blocks` | Block candidates with status, topoheight and miner reward | Stratum (submit and block tracker) | Forever |
| `bans` | Stratum IP bans with reason and expiry | Stratum | Forever |
| `service_events` | Blocks (submitted, side, final), bans, node switches and pauses, Stratum starts, rejected connections and logins | Stratum, node-admin | Forever |

Notes:

- Hashrate is accepted share difficulty divided by elapsed seconds over completed buckets
  (section 6). The API reads minute stats for ranges up to 30 days and hourly rollups for a year.
- Effort (`sum_effort`, migration 005): each accepted share adds share difficulty ÷ network
  difficulty at the time, so luck and round effort survive the raw-share retention.
- `stale` (migration 007) counts the rejected shares that were stale, found just after the network moved on.
- Every `service_events` insert is announced on the `xeldash_live` channel for live updates.
- Retention periods are set with `RETENTION_*`. There is no partitioning at this size.
- There are no balance, payout or wallet tables: rewards go straight to each miner's address.

## 6. Difficulty and stats

- V3 hashes are compared as big-endian U256 values against `floor((2^256 - 1) / difficulty)`,
  matching XELIS consensus.
- Estimated H/s is the accepted share difficulty over a completed window (5 minutes, 1 hour,
  24 hours), divided by its length. Expected time-to-block is network difficulty divided by
  that hashrate; the API returns `null` when a window has no accepted shares. Miners'
  self-reported hashrate is shown next to it.
- Vardiff per connection: start at 100,000 and aim for one share every 10 seconds; retarget
  after 60 seconds or 20 accepted shares, by at most 2x, skipping changes under 50%, between
  1,000 and the network difficulty.
- A miner can ask for a fixed difficulty in its password (`d=`), never below the minimum.
- Shares are hashed (on a thread pool) before they are recorded; low-difficulty and
  duplicate shares are recorded as rejected, malformed ones refused. Shares on the job a new
  block replaced are accepted for 1.5 seconds (`STRATUM_STALE_GRACE_MS`); later ones are
  recorded as stale.
- Round effort is the effort since the last found block (100% = the work expected per
  block); luck is blocks found ÷ blocks expected. Expected earnings are blocks per day at the
  last hour's hashrate times the current miner reward.

## 7. Security

Local-network only by default; the model, protections and remaining risks are in
[SECURITY.md](SECURITY.md). In short: nothing sensitive is published, Stratum and getwork
have per-IP connection, message and ban limits, the dashboard sends a strict
Content-Security-Policy, and every change to a node (settings, snapshots, stop and start,
versions, the fallback) needs `XELDASH_ADMIN_TOKEN`. Nothing can control Docker. Viewing the dashboard needs no login by default; the optional `proxy` service adds HTTPS, a login and a host-name check.

## 8. API and dashboard

- Pages: Overview (with a setup banner until a miner has connected), Get started (`#/setup`), Miners (with Miner and Worker pages), Blocks, Health (with connection problems), Nodes (stop and start,
  versions and upgrades, copies and snapshots) and Settings (display, the official node fallback,
  alerts, each node's daemon settings). Light, dark or system theme and an optional XEL price, both
  per browser; phone-sized layouts; live updates over `/api/v1/live` with polling as the
  fallback.
- REST endpoints (all `GET`; `address` must be a valid `xel:`/`xet:` address; `worker` needs
  `address`): `/api/v1/overview`, `/api/v1/status`, `/api/v1/hashrate`, `/api/v1/miners`,
  `/api/v1/miners/{address}`, `/api/v1/miners/{address}/workers/{name}`, `/api/v1/blocks`,
  `/api/v1/blocks.csv`, `/api/v1/events`, `/api/v1/rewards`, `/api/v1/problems`, `/api/v1/price`, `/api/v1/connect`. The overview, miner and blocks responses include effort
  and luck. node-admin serves `/api/v1/node/*` (see services/node-admin/README.md).
- Alerts to Discord, Telegram or a JSON webhook: blocks found, side and final, mining paused,
  resumed or switched, workers offline, node updates. Set up on the Settings page, with a test message. See [OPERATIONS.md](OPERATIONS.md#alerts).

## 9. Deployment and operations

- One `docker-compose.yml` and `.env.example`. Images build locally by default, or are pulled
  from GHCR (amd64 and arm64) by setting `XELDASH_VERSION`.
- Healthchecks and `restart: unless-stopped` on every long-running service.
- Daemon pinned with `XELIS_DAEMON_IMAGE`, or switched to official releases from the dashboard;
  daemon settings, snapshots and node control from the dashboard.
- Optional second node, backups, alerts, and the upgrade guide: [OPERATIONS.md](OPERATIONS.md).

## 10. Testing

- Today: the devnet checks in [DEVNET.md](DEVNET.md) (our test miner, the official miner over
  getwork, two-node failover, snapshots), plus typecheck and image builds in CI.
- Not yet built: unit tests for Stratum parsing, vardiff and hashrate math; hash test vectors;
  integration tests against the Compose stack; a load test with many simulated miners.

## 11. Open-source project setup

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
  node-admin/     node settings, snapshots, control and versions for the dashboard (Node.js)
web/              React + Vite + Tailwind dashboard, nginx config
packages/
  db/             migrations, migration runner, shared queries
  xelis-hash/     XELIS Hash V3 native addon (Rust, napi-rs)
docker/
  daemon/         daemon image wrapper and supervisor entrypoint
  backup/         backup script
  stratum-tls/    optional Stratum TLS certificate
docs/             guides, this document, security, devnet notes
```

## Known limitations

1. **Algorithm and hard-fork changes:** the daemon and the hash addon must be upgraded
   together, before the fork height. Scheduled switches cover the daemon; a new algorithm
   still needs a new xelDash release.
2. **Release signatures:** the XELIS release signing key is not published, so dashboard
   upgrades rely on checksums from GitHub, like the official images.
3. **Upstream daemon images:** releases from 1.22.0 on need the Debian 13 re-base
   ([docker/daemon/README.md](../docker/daemon/README.md)); fixed upstream (f6ea12c), not yet
   released.
4. **Few miners tested:** Rigel, xelis_miner and our own miner; others may differ in details.
5. **Docker Desktop hides client addresses**, so the allowed-networks check cannot tell a LAN
   computer from an internet one there; the Windows firewall rules and the router protect it.
