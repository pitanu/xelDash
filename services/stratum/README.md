# Stratum service

This directory contains the first protocol layer for the miner-facing XELIS Stratum
endpoint:

- newline-delimited JSON-RPC framing with a 64 KiB line limit;
- algorithm negotiation for current `xel/v3` and legacy algorithm aliases;
- session handling for subscribe, authorize, submit, and reported hashrate;
- daemon-backed address validation/public-key extraction and PostgreSQL worker registration;
- address-specific daemon templates, Stratum job refresh, V3 hash validation, fixed target
  difficulty, share persistence, and network-target block submission.

The service is available in Compose on port 3333, bound to loopback by default. Set
`XELDASH_STRATUM_BIND_IP` to the host's LAN address to accept miners from the LAN. The
share difficulty is set per connection by vardiff (`src/vardiff.js`): it starts at
100,000, aims for one share every 10 seconds, and is capped at the job's network difficulty. The service subscribes to the daemon's `new_block` WebSocket
event and pushes fresh work to every miner as soon as the chain tip changes; per-session
polling (`STRATUM_JOB_REFRESH_MS`) remains as a fallback and picks up template changes.
A tip change sends `clean_jobs` and drops earlier jobs, so late shares on them are rejected
as stale. New transactions at the same height update work without forcing a restart.

Only `xel/v3` jobs are currently accepted. A mining submission is hashed from the official
112-byte Stratum MinerWork layout, compared against both its share target and network
target, then recorded in PostgreSQL. Work at network difficulty is submitted to the local
daemon before any database write, then recorded in `blocks` (status `submitted` or
`rejected`) with a matching `service_events` row. Once the daemon's stable height passes
a submitted block, it moves to `main-chain`, `side` or `orphaned` with its topoheight and
miner reward, and a `block_final` event. The block hash is BLAKE3 of the 112-byte
MinerWork, matching the daemon's block hash. Hashing, block submission and block hashes
are verified on devnet (see [docs/DEVNET.md](../../docs/DEVNET.md)); a third-party miner
has not been tested yet. Abuse limits: at most 64 connections per IP and 20 messages per second per connection
(burst 40). An IP is banned for 15 minutes when 5 minutes hold at least 50 invalid
submissions that are over half of its submissions; stale shares do not count. Bans are
stored in `bans` and survive restarts. All limits are `STRATUM_*` settings in `.env.example`.

Optional TLS: set `STRATUM_TLS_ENABLED=true` and put `cert.pem` and `key.pem` in
`docker/stratum-tls/` (see its README). A second listener on port 3334 then serves
`stratum+ssl` with the same limits and sessions as the plain port. A missing certificate
stops Stratum from starting.

The wire format follows the
[XELIS Stratum protocol](https://docs.xelis.io/developers-api/stratum). The daemon methods
used for address checks are documented in the [Daemon API](https://docs.xelis.io/developers-api/daemon).
