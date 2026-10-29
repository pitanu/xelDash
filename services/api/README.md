# API service

The Node.js REST API reads PostgreSQL and the XELIS nodes over the private Compose network.
It serves `/health` and the dashboard endpoints listed in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) section 8, the `/api/v1/live` WebSocket (PostgreSQL
LISTEN/NOTIFY relayed to browsers), and alerts (`src/alerts.js`).

- **Hashrate** is accepted share difficulty over completed 5-minute, 1-hour and 24-hour
  windows. Expected time-to-block is network difficulty divided by that hashrate; it is an
  expectation, not a prediction. Estimates are `null` until a window has accepted shares.
- **Best share** (`src/best-share.js`): `/api/v1/miners/:address` and the worker route have `bestShare: { round, day, ever }`
  (this round, the last 24 hours, ever), each a fraction of a block; `/api/v1/hashrate` has `best` per bucket when it is asked for one address.
  Per address only: nothing across everyone's rigs. The round starts after the minute of the address's last block, so that
  block is not the next round's best. All null with `XELDASH_BEST_SHARE=off`.
- **Effort and luck** (`src/luck.js`): each accepted share adds share difficulty ÷ network
  difficulty at the time, so the sum is the number of blocks the work was expected to find.
  Rounds run from one found block to the next, split on minute buckets.
- **Activity** (`src/activity.js`): `/api/v1/activity?address=…[&worker=…]&range=24h|7d|30d|90d` says when the address (or
  worker) was mining: minutes with a share, gaps of up to 3 minutes bridged, joined into stretches (UTC, for the browser to place
  in its own time zone). With it: time on and its share of the period, hashrate while on, blocks expected from that work, blocks
  found and luck. From the minute stats, so as far back as `RETENTION_MINUTE_STATS_DAYS` (90 by default); the period starts where
  they begin, so time before anything was tracked does not count as off. `/api/v1/activity.csv` (same parameters) is the same
  stretches as a spreadsheet file: `started_at_utc`, `ended_at_utc`, `minutes`, `hashrate_hs` (while on) and `expected_blocks`,
  for the latest 5,000 stretches in the range.
- **Status** (`src/status.js`) checks each node, Stratum and the database separately, marks
  the node Stratum mines through, and flags nodes older than the latest XELIS release
  (`src/release.js`, from GitHub every 6 hours; `XELDASH_VERSION_CHECK=off`).
- **Price** (`src/price.js`): XEL in eleven currencies from CoinGecko, fetched by the server
  every 5 minutes while a viewer has it on, mainnet only; `XELDASH_PRICE=off` disables it.
- **Alerts** (`src/alerts.js`): block, mining-state, worker-offline, node-update, disk and failover alerts to Discord,
  Telegram or a JSON webhook. The settings are the ones saved from the dashboard (`alerts.json` on the config volume,
  watched and applied within seconds), else the `ALERT_*` values from `.env`.
- **Ingest** (`src/ingest.js`, `POST /api/v1/ingest`, `GET /api/v1/ingest/ping`): where a standby server sends what it
  recorded, in batches, when the cluster has two servers. Needs `XELDASH_CLUSTER_SECRET` (the endpoints do not exist
  without it); each record is applied once, by per-sender sequence number (`ingest_progress`, migration 008), after its shape
  is checked. The readiness reply also carries the default mining address, and `GET /api/v1/ingest/alerts` the alert
  settings, for a standby to copy.
- **Updates** (`src/update.js`, `/api/v1/version`): the running version and the newest tagged release of xelDash on
  GitHub (every 6 hours; `XELDASH_VERSION_CHECK=off`; `XELDASH_UPDATE_REPO` for a fork).
- **Mining availability** (`/api/v1/uptime`, `src/uptime.js`): the share of a window in which work could be
  issued, from the recorded pause and resume events.
- **Blocks CSV** (`/api/v1/blocks.csv`, `src/csv.js`): every block as a spreadsheet file, optionally for one miner
  or worker; cells that would run as a formula are prefixed with an apostrophe.
- **Rewards history** (`/api/v1/rewards`, `src/luck.js`): rewards found per day beside the work done per day,
  for the rewards chart.
- **Connection problems** (`/api/v1/problems`): rejected connections and logins of the last 24 hours,
  grouped by cause, address and IP.
- **Connect info** (`src/connect.js`, `/api/v1/connect`): the published Stratum, TLS and getwork ports, this
  computer's network address (from the launcher), whether other computers can reach it, and the
  mining address, for the dashboard's Get started page.
- **Nodes** come from `XELIS_RPC_URLS`, plus the official node while the fallback is on
  (read from the config volume).
- **Public mode** (`XELDASH_PUBLIC_MODE=true`, `src/public-mode.js`): a request gets the public view unless it carries
  `X-Xeldash-View: admin`, which only the operator's `admin-web` sends (the public web server always overwrites the header).
  The public view has every IP address removed, no connection problems or recent events (`{ hidden: true }`) and no bans, and
  its answers are shared between visitors for 2 seconds (`src/public-cache.js`). Calls to the nodes are shared the same way, the
  official fallback node is never used, `/api/v1/connect` leaves out the server's mining address and says which view the
  request has (the "Mine here" page shows `XELDASH_CONNECT_HOST`, passed as `CONNECT_HOST`), the live socket takes
  up to 1,000 viewers, and alerts leave out worker alerts and the cluster's shared address. The readiness reply to a standby
  says the main server is public. A node that is not answering yet is a `503` with `{ "error": "node_unavailable" }`, in any mode.
