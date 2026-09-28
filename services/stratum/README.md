# Stratum service

The miner-facing side of xelDash: Stratum (port 3333, optional TLS on 3334) and getwork
(port 8090), share validation, vardiff, block submission, node failover, the block tracker,
and data retention. It listens on loopback by default; set `XELDASH_STRATUM_BIND_IP` to the
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
a 15-minute ban when 5 minutes hold at least 50 invalid submissions or failed logins that are
over half of its submissions. At most 32 workers per connection. Bans are stored in `bans`
and survive restarts. All limits are `STRATUM_*` settings in `.env.example`.

**Getwork.** Miners that only speak getwork, like the official `xelis_miner`, connect to
`ws://<host>:8090/getwork/<address>/<worker>`. Each connection is a normal session with vardiff,
stats and the same limits; jobs carry the share difficulty, so the miner's log says "block
found" for every share. `GETWORK_ENABLED=false` turns it off.

**TLS.** `STRATUM_TLS_ENABLED=true` with `cert.pem` and `key.pem` in `docker/stratum-tls/` adds
`stratum+ssl` on port 3334. A missing certificate stops Stratum from starting.

**Retention.** Raw shares are kept 7 days and per-minute stats 90 days; hourly rollups are
kept (`RETENTION_*`).
