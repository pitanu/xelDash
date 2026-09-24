# xelDash *(working name)*

> Self-hosted, LAN-only XELIS solo mining statistics in Docker.

xelDash runs a local XELIS node, a LAN stratum endpoint that validates and records shares,
and a dashboard for worker hashrate, accepted/rejected shares, and time-to-block estimates.
It submits only solved blocks to the node. Rewards go directly to each miner's authorized
address; xelDash has no shared-reward accounting, balances, payout service, or hot wallet.

**Status:** early Phase 1 implementation. The daemon RPC spike and initial Stratum protocol/session layer exist. A live validated job pipeline, hash addon, and Stratum Compose service remain to be implemented.

## Local containers

Copy `.env.example` to `.env`, set a strong `POSTGRES_PASSWORD`, then start the daemon and
database with `docker compose up -d`. PostgreSQL migrations run automatically before the
API starts. The API is available at `http://localhost:8081`; `/health` reports dependency
health and `/api/v1/overview` returns node difficulty, recent share totals, and block
statuses. Share difficulty is reported as a raw measurement; hashrate and time-to-block
conversion are not yet enabled.

The daemon RPC stays private to Compose. For the host-run daemon template spike only, use
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d daemon`; this
development overlay binds RPC to `127.0.0.1:8080`.

To make the API reachable from your LAN, set `XELDASH_API_BIND_IP` to this machine's LAN
IP address in `.env`. Its default is `127.0.0.1`. The daemon RPC and PostgreSQL remain
private to the Compose network, and daemon P2P binds to localhost by default.

Compose also runs the versioned SQL migrations after PostgreSQL is healthy. The initial
schema tracks miners, workers, raw share outcomes, per-minute difficulty aggregates,
submitted blocks, bans, and service events; it contains no balance or payout tables.

The current folder layout follows the planned service boundaries:

```text
docker-compose.yml
docker/daemon/       daemon deployment notes
services/daemon-spike/ JSON-RPC spike client
services/stratum/    initial Stratum framing, session, and worker authorization layer
services/api/        LAN-bound REST API
web/                 dashboard (planned)
packages/db/         database migrations
packages/db/src/     migration runner and transactional share persistence
packages/xelis-hash/ native hash addon (planned)
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
