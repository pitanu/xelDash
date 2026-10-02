# Stratum service

The miner-facing side of xelDash: Stratum (port 3333, optional TLS on 3334) and getwork
(port 8090), share validation, vardiff, block submission, node failover, the block tracker,
data retention, and the durable store that keeps mining independent of the database. It listens on loopback by default; set `XELDASH_STRATUM_BIND_IP` to the
host's LAN address to accept miners from the LAN.

**Protocol.** Newline-delimited JSON-RPC (64 KiB line limit) following the
[XELIS Stratum protocol](https://docs.xelis.io/developers-api/stratum): `mining.subscribe`,
`mining.authorize` (address, worker, password), `mining.submit` and `mining.hashrate`. Classic
Stratum requests without `"jsonrpc"` are accepted, as GPU miners such as Rigel send them. Only
`xel/v3` work is issued. Tested with our devnet miner, Rigel 1.23.0 on mainnet, and the
official `xelis_miner` over getwork.

**Work and shares.** Each miner gets a template for its own address from the node
(`get_block_template`, `get_miner_work`); the reward key comes from the address, looked up on
our own node. New work is pushed on the node's `new_block` event, with polling
(`STRATUM_JOB_REFRESH_MS`) as the fallback. A share is hashed from the 112-byte MinerWork on a
thread pool, compared with its share and network targets, and recorded. Work at network
difficulty is submitted to the node before any database write and recorded in `blocks`; the
block tracker moves it to `main-chain`, `side` or `orphaned` at the stable height. Each
accepted share also adds its effort (share ÷ network difficulty) for the luck figures.

**Logins.** XELIS-aware miners (Rigel) send `[address, worker, password]`. Classic Stratum miners send
`[user, password]`, often with `address.worker` as the user: XELIS addresses contain no dot, so xelDash
splits there and remembers the full user name, under which those miners submit shares. A password
like `d=50000` is read as options even when it sits in the worker slot. A login that sends no address
mines to the address chosen on the dashboard's setup page (`src/default-address.js`, re-read every 5
seconds), else `XELIS_DEFAULT_ADDRESS`.

**Difficulty.** Vardiff per connection (`src/vardiff.js`): starts at 100,000, aims for one
share every 10 seconds, capped at the network difficulty. A miner can fix it with
`d=<difficulty>` (or `diff=`) in the password, never below `STRATUM_MIN_DIFFICULTY`.

**Late shares.** A new block replaces the job, but shares on the previous one are accepted for
`STRATUM_STALE_GRACE_MS` (1.5 s) since GPUs finish their current batch first. Later ones are
rejected and recorded as stale; they never count toward bans.

**Nodes.** `XELIS_RPC_URLS` lists nodes in priority order (`src/node-pool.js`). Work comes from
the first node in sync; if it goes down or falls behind, mining switches to the next without
disconnecting miners, and moves back when it recovers. The official public node is added as a
last resort while the dashboard's fallback switch is on (`src/fallback-config.js`). With no
usable node, miners are disconnected and logins refused until one recovers.

**Abuse limits.** Per IP: 64 connections, 20 messages per second per connection (burst 40), and
the allowed networks (`XELDASH_ALLOWED_NETWORKS`, default private networks only; refused connections
are recorded as `connection_refused` events, and logins that fail as `login_problem`, at most once every
10 minutes per cause, for the dashboard's connection help). Per-address limits are off for Docker's
gateway address, which hides real clients. A 15-minute ban when 5 minutes hold at least 50 invalid submissions or failed logins that are
over half of its submissions. At most 32 workers per connection. Bans are stored in `bans`
and survive restarts. All limits are `STRATUM_*` settings in `.env.example`.

**Getwork.** Miners that only speak getwork, like the official `xelis_miner`, connect to
`ws://<host>:8090/getwork/<address>/<worker>`. Each connection is a normal session with vardiff,
stats and the same limits; jobs carry the share difficulty, so the miner's log says "block
found" for every share. `GETWORK_ENABLED=false` turns it off.

**TLS.** `STRATUM_TLS_ENABLED=true` with `cert.pem` and `key.pem` in `docker/stratum-tls/` adds
`stratum+ssl` on port 3334. A missing certificate stops Stratum from starting.

**Records and outages** (`src/store.js`). Everything Stratum records (workers, shares, blocks, events, bans)
goes through one store. Normally a write goes straight to PostgreSQL. When the database cannot be reached the write is
appended to a JSON-lines journal on its own volume (`STRATUM_JOURNAL_DIR`, `/spool` in Compose), a circuit breaker
keeps miners from waiting on a dead database, and miners stay connected and keep mining. A background loop checks the
database every few seconds and injects the journal in order with the original timestamps, then deletes it. Workers are
named by address and name in the journal, since a worker first seen during an outage has no id yet; logins during an
outage use a cache of the workers seen before (also kept on disk), and a new worker gets a provisional identity that
is created when the database returns. The journal survives restarts, is capped at `STRATUM_JOURNAL_MAX_MB` (200; past
that, shares are dropped, never blocks, events or bans), and a repeated share during an outage is caught in memory.
Blocks are submitted to the node first, so a database outage never costs a block.

**Standby mode.** With `STRATUM_INGEST_URL` (and `XELDASH_CLUSTER_SECRET`) set, Stratum has no database at all: the store
journals every record and sends it, in numbered batches, to the main server's `/api/v1/ingest`, which applies each
record once. The block tracker, retention and live notifications, which need the database, are left to the main
server. This is the second server of a two-server cluster (`docker-compose.standby.yml`; see
[docs/OPERATIONS.md](../../docs/OPERATIONS.md#redundancy-two-servers)). `STRATUM_INSTANCE` names the sender. A standby also asks the main server's readiness endpoint every 30 seconds, and keeps the
default mining address it reports in `XELDASH_MINING_ADDRESS_FILE` (on its own volume), where the default-address watcher reads it.

**Health.** A small HTTP server on `STRATUM_HEALTH_PORT` (8096): `/healthz` answers 200 while a node is ready to issue work
and 503 with the reason otherwise (the cluster's address manager asks it, so the shared address leaves a server that
cannot mine); `/status` adds the instance, mode (`main` or `standby`), connected rigs and the journal's size, for the
standby's offline page. It is published on this computer's loopback only, and only when the cluster is set up.

**Retention.** Raw shares are kept 7 days and per-minute stats 90 days; hourly rollups are
kept (`RETENTION_*`).
