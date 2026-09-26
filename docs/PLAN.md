# xelDash: Project Plan

*Working name. Last updated: 2026-09-26. Status: Phases 1 to 3 working on devnet; Phase 4
dashboard started.*

Each section is marked **Decided**, **Draft** (a proposal to confirm), or **Open** (not
discussed yet). When something is settled, record it in [DECISIONS.md](DECISIONS.md).

---

## 1. Scope and users (Decided)

- An open-source, self-hosted XELIS solo mining server and statistics dashboard, run with
  Docker Compose and intended for LAN use.
- Whoever deploys it runs their own XELIS node. Miners connect to the LAN stratum service;
  public internet exposure is outside the v1 deployment model.
- Validated shares provide pool-quality worker and miner hashrate, share history, and
  time-to-block estimates. The service submits only solved blocks to its own daemon.
- Each found block pays the address authorized by its miner. The service does not split
  rewards, hold funds, track balances, operate a payout engine, or use a hot wallet.
- Each stratum connection can authorize with its own `xel:` address. The operator
  configures a default address for miners that don't send one.

**Non-goals (for v1):** proportional or shared-reward pool mining (PPLNS/PPS), fees, and
custodial wallets.

## 2. Architecture (Decided, per-service details Draft)

```
             LAN / Internet
                  │
         ┌────────▼────────┐        ┌──────────────┐
 miners ─►  stratum server  ├───────►  xelis_daemon │  (RPC, internal network only)
         │  (Node + addon) │        └──────────────┘
         └────────┬────────┘
                  │ shares, blocks, events
           ┌──────▼──────┐     ┌──────────────┐     ┌───────────┐
           │  PostgreSQL  ◄─────┤   API (Node) ◄─────┤  Web (React)│ ◄─ browser
           └─────────────┘     └──────────────┘     └───────────┘
```

| Service    | Responsibility | Exposed to host? |
|------------|----------------|------------------|
| `daemon`   | Official `xelis_daemon`; chain data on a volume | P2P loopback-only by default; RPC stays internal |
| `stratum`  | LAN miner connections, jobs, share validation, vardiff, block submission | LAN only |
| `api`      | Stats queries, WebSocket live updates, pool health | LAN-bound host port |
| `web`      | React + Vite + Tailwind dashboard, served as static files | LAN only |
| `postgres` | Persistent storage | No |

## 3. Mining protocols (Decided, compatibility details Open)

Questions to settle:

- **Stratum spec:** follow the [official XELIS Stratum protocol documentation](https://docs.xelis.io/developers-api/stratum).
  The implementation negotiates `xel/v3` and documented aliases; confirm behavior with
  real miner clients before release.
- **Getwork (decided, implemented):** a getwork WebSocket endpoint on port 8090 for miners
  that only speak getwork, such as the official xelis_miner. Verified with xelis_miner 1.21.3.
- **TLS stratum (decided, implemented):** optional `stratum+ssl` listener on port 3334,
  enabled with `STRATUM_TLS_ENABLED=true` and a cert/key in `docker/stratum-tls/`.
- **Miner compatibility matrix:** SRBMiner, lolMiner, OneZeroMiner, Rigel, xelis_miner, and
  others. Test each against the server.
- **Algorithm:** XELIS currently uses **Xelishash V3**. Plan how to handle future
  algorithm or hard-fork changes.

## 4. Daemon integration (Open, next to plan)

To confirm against the daemon's RPC documentation and a test run:

- Getting a block template for a specific miner address or public key.
- Submitting a solved block (template plus miner work).
- Detecting new jobs: subscribe to daemon events over WebSocket, or poll? Also how often to
  refresh the template when no new block arrives.
- Node sync state (implemented): a node is not usable while its peers' median topoheight is
  more than 16 ahead of it, or while it does not respond (two consecutive 5-second checks).
  No peers counts as ready (normal on devnet); the Health page warns about it.
- Multiple nodes (implemented): `XELIS_RPC_URLS` lists nodes in priority order. Stratum
  mines through the first usable node that is not more than 16 topoheights behind another
  of our nodes, fails over without disconnecting miners (fresh, clean jobs), and fails back
  when the preferred node recovers. Blocks go to the node that issued the job, then to the
  others if it is unreachable. When no node is usable, miners are disconnected and logins
  refused until one recovers. An optional `daemon2` Compose service (profile `redundant`)
  allows one-at-a-time upgrades.
- Final block status (decided): a block is final once its height is at or below the
  daemon's `stableheight`. The daemon's block type then maps Normal and Sync to
  `main-chain`, Side to `side`, and Orphaned (or unknown) to `orphaned`.
- Which network to run: `mainnet`, `testnet`, `devnet`, chosen through config.

## 5. Data model (Decided)

PostgreSQL, with plain SQL migrations applied in order by the one-shot `migrate` service.
The migrations in [`packages/db/migrations/`](../packages/db/migrations/) are the source of
truth for columns, types and constraints; this section only summarizes them.

| Table | Holds | Written by | Kept |
|-------|-------|-----------|------|
| `miners` | One row per mining address | Stratum (on authorize) | Forever |
| `workers` | Worker names per address, last IP | Stratum (on authorize) | Forever |
| `shares` | Every submission: difficulty, accepted or reject reason | Stratum | 7 days |
| `worker_stats_1m` | Per-worker, per-minute accepted/rejected counts and difficulty sum | Stratum, with each share | 90 days |
| `worker_stats_1h` | Hourly rollup of the minute stats (migration 003) | Stratum's hourly retention job | Forever |
| `blocks` | Block candidates with status, topoheight and miner reward | Stratum (submit and block tracker) | Forever |
| `bans` | Stratum IP bans with reason and expiry | Stratum | Forever |
| `service_events` | Blocks submitted/final, bans, Stratum starts | Stratum | Forever |

Notes:

- Hashrate is accepted share difficulty divided by elapsed seconds over completed buckets
  (section 6). The API reads the minute stats for ranges up to 30 days and the hourly
  rollups for one year.
- Block status moves from `submitted` to `main-chain`, `side` or `orphaned` at the daemon's
  stable height, or is `rejected` when the daemon refuses the block.
- Every `service_events` insert is announced on the `xeldash_live` channel (migration 002)
  for live dashboard updates.
- Retention: raw shares 7 days, minute stats 90 days, set with `RETENTION_*`. Stratum runs
  the rollup and deletes hourly, in batches. There is no partitioning at this size; revisit
  if raw-share volume grows a lot.
- There are no balance, payout or wallet tables: rewards go straight to each miner's address.

## 6. Difficulty and stats (Decided)

- Validate V3 hashes as unsigned big-endian U256 values against
  `floor((2^256 - 1) / difficulty)`, matching XELIS consensus.
- Each accepted share contributes its assigned share difficulty to the hashrate estimate;
  estimated H/s is accepted difficulty sum divided by completed window duration. Windows
  are 5 minutes, 1 hour, and 24 hours.
- Expected solo time-to-block is network difficulty divided by observed hashrate. It is an
  expectation, not a prediction; the API returns `null` when a window has no accepted shares.
- Vardiff per connection: start at 100,000 and aim for one share every 10 seconds.
  Retarget after 60 seconds or 20 accepted shares, by at most 2x up or down, skipping
  changes under 50%. Difficulty stays between 1,000 and the network difficulty. A retarget
  re-sends the current work under a new job id; earlier jobs keep their own difficulty.
- Shares are hashed before persistence; low difficulty and duplicates are recorded as
  rejected. Malformed and stale submissions are rejected before share accounting.
- Block lifecycle tracking: Stratum checks submitted blocks on every new block and every
  30 seconds, and records the final status, topoheight and miner reward.

## 7. LAN security (Draft)

- Miner stratum and dashboard access are restricted to the LAN by default. Daemon RPC and
  Postgres are never published to the host.
- Per-IP connection limits and message rate limits on the LAN stratum service
  (implemented: 64 connections per IP, 20 messages/s with a burst of 40 per connection).
- Automatic bans after too many invalid shares or malformed messages (implemented: a
  15-minute ban when 5 minutes hold at least 50 invalid submissions and they are over half
  of that IP's submissions; stale shares do not count). Bans are stored and survive restarts.
- Maximum message size and handshake timeouts.
- Dashboard: LAN-only by default; optional password or reverse-proxy auth when exposed.
- Optional built-in TLS for Stratum (implemented). HTTPS for the dashboard is left to a
  reverse proxy.

## 8. API and dashboard (Draft)

Alerts (implemented): the API sends block, mining-pause and worker-offline alerts to
Discord, Telegram or a JSON webhook; see [OPERATIONS.md](OPERATIONS.md#alerts).

Candidate views:

- **Overview:** observed hashrate, active miners and workers, node sync status, network
  difficulty, expected time-to-block, blocks found.
- **Miner page (by address):** workers, hashrate chart, shares, blocks.
- **Worker page:** hashrate, accepted/rejected shares, last seen.
- **Blocks:** list with status (submitted / main-chain / side / orphaned / rejected).
- **Health:** node status, stratum uptime, recent events.

Implemented: the Overview, Miner, Worker, Blocks and Health pages. The dashboard (React,
Vite, Tailwind, served by nginx) has no auth; it is LAN-only like the API.

Live updates: every `service_events` insert (migration 002) and every network block
(announced by Stratum) is sent on the Postgres channel `xeldash_live`. The API relays it to
dashboards over the WebSocket `/api/v1/live`, and they refetch the REST endpoints. While
live, dashboards also poll every 60 seconds for per-minute stats; without the socket they
poll every 15 seconds.

REST endpoints (all `GET`; `address` must be a valid `xel:`/`xet:` address; `worker` needs
`address`):

- `/api/v1/overview`: node, network, share totals, estimates, block status counts.
- `/api/v1/status`: node and sync state, database/daemon/Stratum health, active bans.
- `/api/v1/hashrate?range=6h|24h|7d[&address=[&worker=]]`: hashrate per completed bucket.
- `/api/v1/miners` and `/api/v1/miners/{address}`: per-miner and per-worker stats.
- `/api/v1/miners/{address}/workers/{name}`: one worker, with reject reasons.
- `/api/v1/blocks?limit=&address=&worker=`: recent blocks with status and reward.
- `/api/v1/events?limit=`: recent service events.

## 9. Deployment and ops (Draft)

- One `docker-compose.yml` and a `.env.example` (default miner address, network, ports,
  difficulty, retention, Postgres password, dashboard exposure).
- Images published to GHCR for amd64 and arm64 (implemented): `.github/workflows/release.yml`
  runs on `v*.*.*` tags. The Stratum image cross-compiles its Rust addon rather than
  building it under emulation.
- Healthchecks and `restart: unless-stopped` on every service.
- Postgres backups (implemented): an optional `backup` Compose profile with daily, rotated
  `pg_dump`s, plus manual backup and restore steps in [OPERATIONS.md](OPERATIONS.md).
- Upgrade guide (implemented) for xelDash, XELIS daemon releases, hard forks and algorithm
  changes, in [OPERATIONS.md](OPERATIONS.md).

## 10. Testing (Draft)

- Develop against XELIS **testnet or devnet** so blocks are found quickly.
- Unit tests for stratum message parsing, vardiff and hashrate math.
- Hash addon: test vectors checked against known-good XELIS hashes.
- Integration tests: a real miner against the full compose stack on devnet.
- A load test that simulates many connections with fake miners.

## 11. Open-source project setup (Open)

- License: MIT, Apache-2.0, or GPL-3.0.
- CI with GitHub Actions (implemented): typecheck, dashboard build, Compose validation and
  amd64 image builds on every push and pull request. Tests come later.
- Versioning with SemVer and a changelog (implemented: `CHANGELOG.md`).
- CONTRIBUTING.md, issue templates (bug, feature, miner compatibility), a pull request
  template and a code of conduct (implemented).
- JavaScript with JSDoc and TypeScript `checkJs` for service code; Rust for the native hash addon.
- Package manager and monorepo tooling: npm, pnpm or yarn workspaces.

---

## Proposed repo layout

```
xeldash/
├── docker-compose.yml
├── .env.example
├── services/
│   ├── stratum/          # Node.js stratum server
│   └── api/              # Node.js API + WebSocket
├── web/                  # React + Vite + Tailwind dashboard
├── packages/
│   ├── xelis-hash/       # napi-rs native addon (Rust → Node)
│   └── db/               # shared schema, migrations, queries
├── docker/
│   └── daemon/           # XELIS node image / config
└── docs/
    ├── PLAN.md
    └── DECISIONS.md
```

## Build phases

| # | Phase | Goal / done when |
|---|-------|------------------|
| 0 | **Planning** | Planning completed enough to begin the technical spike; some protocol and operations decisions remain open |
| 1 | **Spike** | Daemon syncs in Docker; a Node script fetches a template and submits a block on devnet; the hash addon matches real miner hashes |
| 2 | **Minimal stratum** | One real miner connects at fixed difficulty; shares are validated; found blocks reach the chain |
| 3 | **Multi-miner** | Vardiff, per-address work, shares/blocks stored in Postgres, reconnect handling |
| 4 | **Dashboard** (current) | API + React UI with live stats |
| 5 | **Open-ports hardening** | Limits, bans, optional TLS, dashboard auth |
| 6 | **Release** | Multi-arch images, docs, license, upgrade guide, v0.1.0 tag |

## Known technical risks

1. **Share validation in Node:** Xelishash V3 is too heavy for plain JavaScript, so it
   needs a native addon (napi-rs wrapping the official Rust hash implementation). The
   first addon boundary is in `packages/xelis-hash`; Phase 1 must verify its output against
   known-good miner hashes and prove the full native build works in supported containers.
2. **Per-miner block templates:** check that the daemon RPC supports building work for
   different miner addresses the way the per-address design assumes (Phase 1).
3. **Algorithm and hard-fork changes:** the pool, addon and node must be upgraded together.
