# Getting started

This gets xelDash running on one machine, ready for miners on your LAN. It takes about ten
minutes, plus the time your node needs to get the chain (minutes with a snapshot, days
without).

## What you need

- **Docker with Compose** (Docker Desktop on Windows and macOS, or Docker Engine on Linux).
- **Disk space:** a mainnet node is about 11 GB, and starting from the official snapshot needs
  roughly twice that while it is unpacked. A second node doubles the chain data.
- **A XELIS address** to receive block rewards (`xel:...` on mainnet). xelDash never holds
  funds: every block pays the address of the miner that found it.
- A machine that stays on. It has been run on an ordinary x86-64 PC. Images are also built
  for arm64, but that has not been tested here.

## 1. Configure

```sh
git clone https://github.com/pitanu/xelDash.git
cd xelDash
cp .env.example .env
```

Open `.env` and set at least:

| Setting | Value |
|---------|-------|
| `POSTGRES_PASSWORD` | Any long random password. |
| `XELIS_NETWORK` | `mainnet` for real mining. `devnet` (the default) is for trying it out. |
| `XELIS_DEFAULT_ADDRESS` | Your address, for miners that do not send one. Optional. |
| `XELDASH_ADMIN_TOKEN` | A long random token (`openssl rand -hex 24`). Needed to change anything from the dashboard: node settings, snapshots, versions. Leave empty for a read-only dashboard. |
| `XELIS_SNAPSHOT_AUTO` | `true` on mainnet to start from the official snapshot (about 9 GB) instead of syncing for days. |

Every setting is explained in [`.env.example`](../.env.example).

## 2. Start

```sh
docker compose up -d
```

The first start builds the images, which takes a few minutes. Follow the node with
`docker compose logs -f daemon`. On mainnet with `XELIS_SNAPSHOT_AUTO=true`, the dashboard
shows the snapshot download and unpacking on the **Nodes** page; the node starts by itself
when it is ready.

## 3. Open the dashboard

Go to **http://localhost:8088**. Until the node has caught up, the Health page shows it
syncing and Stratum refuses miners; both fix themselves.

To use the dashboard and Stratum from other machines, set the bind addresses in `.env` to this
machine's LAN address, then run `docker compose up -d` again:

```
XELDASH_WEB_BIND_IP=192.168.1.10
XELDASH_STRATUM_BIND_IP=192.168.1.10
```

Everything listens on `127.0.0.1` by default. Read [Security](SECURITY.md) before opening
it further, and consider the optional [HTTPS and login](OPERATIONS.md#https-and-a-login).

## 4. Point your miners at it

See [Connecting miners](MINERS.md). The short version: pool `stratum+tcp://<host>:3333`, user
your `xel:` address, worker any name.

## Ports

| Port | What | Default bind |
|------|------|--------------|
| 8088 | Dashboard | `127.0.0.1` |
| 3333 | Stratum | `127.0.0.1` |
| 3334 | Stratum over TLS (optional) | `127.0.0.1` |
| 8090 | Getwork, for the official `xelis_miner` | `127.0.0.1` |
| 8081 | API | `127.0.0.1` |
| 2125 | XELIS P2P | `127.0.0.1` |

Your node connects out to other nodes without any setup. To also accept incoming peers, which
helps the network and your blocks' reach, forward P2P port 2125 on your router and set
`XELIS_P2P_BIND_IP=0.0.0.0`. The daemon's RPC, PostgreSQL and the admin service are never
published.

## Day to day

```sh
docker compose ps                  # what is running
docker compose logs -f stratum     # or daemon, api, node-admin, web
docker compose restart stratum
docker compose down                # stop everything; data volumes are kept
git pull && docker compose up -d --build   # update xelDash
```

Most maintenance (node restarts, versions, snapshots, settings) is on the dashboard's
**Nodes** and **Settings** pages. Backups, restores and upgrades are in
[Operations](OPERATIONS.md).

## Next steps

- A second node, so upgrades and restarts never stop mining:
  [Redundant nodes](OPERATIONS.md#redundant-nodes).
- Alerts to Discord or Telegram: [Alerts](OPERATIONS.md#alerts).
- Daily database backups: [Backups](OPERATIONS.md#backups).
- Trying it out without real coins: [Devnet](DEVNET.md).

## Debugging

To reach the daemon's RPC from the host while debugging (never on a machine others can reach):

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d daemon
```

This publishes the RPC on `127.0.0.1:8080`.
