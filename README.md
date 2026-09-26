# xelDash *(working name)*

> Self-hosted, LAN-only XELIS solo mining statistics in Docker.

xelDash runs a local XELIS node, a LAN stratum endpoint that validates and records shares,
and a dashboard for worker hashrate, accepted/rejected shares, and time-to-block estimates.
It submits only solved blocks to the node. Rewards go directly to each miner's authorized
address; xelDash has no shared-reward accounting, balances, payout service, or hot wallet.

**Status:** early Phase 1 implementation. Compose now builds and runs the V3 hash addon and Stratum service, which fetches address-specific work, validates shares, records them, and submits network-target candidates. Known-good miner-vector and devnet verification remain outstanding.

## Local containers

Backups, restores and upgrades are covered in [docs/OPERATIONS.md](docs/OPERATIONS.md).

Copy `.env.example` to `.env`, set a strong `POSTGRES_PASSWORD`, then start the stack with
`docker compose up -d`. A one-shot `migrate` service applies PostgreSQL migrations; the API
and Stratum services start once it completes. The dashboard is at `http://localhost:8088`
(set `XELDASH_WEB_BIND_IP` to open it to your LAN). The API is available at `http://localhost:8081`; `/health` reports dependency
health and `/api/v1/overview` returns node difficulty, share totals, block statuses, and
estimated hashrates and expected time-to-block from completed share windows. Estimates are
`null` until their window contains accepted shares, then stabilize as the window fills.

The daemon RPC stays private to Compose. For the host-run daemon template spike only, use
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d daemon`; this
development overlay binds RPC to `127.0.0.1:8080`.

Stratum listens on host port 3333, bound to `127.0.0.1` by default. Set
`XELDASH_STRATUM_BIND_IP` to the host's LAN address in `.env` to allow miners on that LAN
to connect. Share difficulty adjusts per connection (vardiff) to about one share every 10
seconds and never exceeds the network difficulty. The `STRATUM_*` settings in `.env.example`
tune it.

To make the API reachable from your LAN, set `XELDASH_API_BIND_IP` to this machine's LAN
IP address in `.env`. Its default is `127.0.0.1`. The daemon RPC and PostgreSQL remain
private to the Compose network, and daemon P2P binds to localhost by default.

The `migrate` service runs the versioned SQL migrations after PostgreSQL is healthy. The initial
schema tracks miners, workers, raw share outcomes, per-minute difficulty aggregates,
submitted blocks, bans, and service events; it contains no balance or payout tables.

The current folder layout follows the planned service boundaries:

```text
docker-compose.yml
docker/daemon/       daemon deployment notes
services/daemon-spike/ JSON-RPC spike client
services/stratum/    initial Stratum framing, session, and worker authorization layer
services/api/        LAN-bound REST API
web/                 React dashboard, served by nginx
packages/db/         database migrations
packages/db/src/     migration runner and transactional share persistence
packages/xelis-hash/ native XELIS Hash V3 addon (initial implementation)
```

- [Project plan](docs/PLAN.md): scope, architecture, data model, phases
- [Decision log](docs/DECISIONS.md): what's decided and what's still open
- [Follow-up issues](docs/ISSUES.md): deferred items from the initial-commit review
- [Phase 1 spike notes](docs/PHASE-1-SPIKE.md): current implementation and validation gaps

## Planned stack

| Part            | Tech                                        |
|-----------------|---------------------------------------------|
| Node            | Official `xelis_daemon` (Docker)            |
| Stratum server  | Node.js + native Xelishash addon (napi-rs)  |
| API             | Node.js (Fastify or Express), REST + WebSocket |
| Dashboard       | React + Vite + Tailwind                     |
| Database        | PostgreSQL                                  |
| Deployment      | Docker Compose                              |

## License

TBD (see docs/DECISIONS.md).
