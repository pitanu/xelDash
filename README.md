# xelDash

> Self-hosted XELIS solo mining with pool-style statistics, in Docker, for your LAN.

xelDash runs your own XELIS node, a Stratum (and getwork) endpoint for your miners, and a
dashboard. Every share is validated, so you get per-worker hashrate, accepted and rejected
shares, and time-to-block estimates like a pool would show. Only solved blocks are submitted,
to your own node, and each block pays the miner's own address directly: xelDash holds no
funds and has no balances, payouts or wallet.

**Status:** feature-complete for a first release, verified end to end on a private devnet and
in a mainnet trial, and tested with Rigel 1.23.0 on a GPU. Before 0.1.0: tests with more
third-party miners (see [docs/ISSUES.md](docs/ISSUES.md)).

## What you get

- **Mining endpoints:** Stratum (`xel/v3`) on port 3333, optional Stratum over TLS on 3334,
  and getwork on 8090 for the official `xelis_miner`. Per-connection vardiff.
- **Dashboard** at port 8088: overview, per-miner and per-worker pages, blocks with their final
  status and reward, and node health, with live updates, in light and dark mode.
- **Reliability:** optional second node with automatic failover, so node upgrades do not stop
  mining; mining pauses by itself while no node is in sync.
- **Node management from the dashboard:** every daemon setting, and chain snapshots (the
  official daily mainnet snapshot, or a zip you drop onto the page).
- **Alerts** to Discord, Telegram or a webhook; optional daily database backups; optional
  HTTPS and login in front of the dashboard.

## Quick start

You need Docker with Compose.

```sh
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, XELIS_NETWORK (devnet, testnet or mainnet) and, for
# mainnet, XELIS_DAEMON_IMAGE=xelis/daemon:1.25.0 (mainnet needs 1.24.0 or newer).
docker compose up -d
```

Open the dashboard at `http://localhost:8088`. The node syncs the chain first; on mainnet,
set `XELIS_SNAPSHOT_AUTO=true` (or use the dashboard's Snapshots page) to start from the official
snapshot instead. Everything listens on `127.0.0.1` until you set the `*_BIND_IP` values in
`.env` to this machine's LAN address.

## Connecting miners

Use your own XELIS address as the user name; the worker name is optional.

| Miner type | Pool URL | User / worker |
|------------|----------|---------------|
| Stratum (Rigel, SRBMiner, lolMiner, ...) | `stratum+tcp://<host>:3333` | `<your xel: address>` / `<rig name>` |
| Stratum over TLS (if enabled) | `stratum+ssl://<host>:3334` | same |
| Official xelis_miner | `--daemon-address ws://<host>:8090 --miner-address <address> --worker <rig>` | |

Share difficulty adjusts to each rig automatically. To fix it instead, put `d=<difficulty>` in
the Stratum password (for example `-p d=50000`); it is never set below `STRATUM_MIN_DIFFICULTY`.

## Documentation

- [Operations](docs/OPERATIONS.md): daemon settings, snapshots, redundant nodes, alerts,
  backups, restores and upgrades
- [Security](docs/SECURITY.md): what is protected, the admin token, remaining risks
- [Devnet checks](docs/DEVNET.md): how the mining path is verified
- [Plan](docs/PLAN.md), [decisions](docs/DECISIONS.md), [open issues](docs/ISSUES.md)
- [Changelog](CHANGELOG.md), [contributing](CONTRIBUTING.md)

## How it is built

| Part | Tech |
|------|------|
| Node | Official XELIS daemon (Docker), under a small supervisor for settings and snapshots |
| Stratum, getwork | Node.js with the official XELIS Hash V3 code as a native addon (Rust, napi-rs) |
| API, node admin | Node.js |
| Dashboard | React, Vite, Tailwind, served by nginx |
| Database | PostgreSQL |
| Deployment | Docker Compose; multi-arch images (amd64, arm64) |

The daemon's RPC, PostgreSQL and node-admin stay on the internal Compose network. For
debugging, `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d daemon`
publishes the daemon's RPC on `127.0.0.1:8080`.

## License

[MIT](LICENSE). The XELIS Hash V3 code built into the Stratum image comes from
[xelis-project/xelis-hash](https://github.com/xelis-project/xelis-hash), also MIT.
