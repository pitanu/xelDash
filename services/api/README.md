# API service

The Node.js REST API reads PostgreSQL and the XELIS nodes over the private Compose network.
It serves `/health` and the dashboard endpoints listed in
[docs/PLAN.md](../../docs/PLAN.md) section 8, the `/api/v1/live` WebSocket (PostgreSQL
LISTEN/NOTIFY relayed to browsers), and alerts (`src/alerts.js`).

- **Hashrate** is accepted share difficulty over completed 5-minute, 1-hour and 24-hour
  windows. Expected time-to-block is network difficulty divided by that hashrate; it is an
  expectation, not a prediction. Estimates are `null` until a window has accepted shares.
- **Effort and luck** (`src/luck.js`): each accepted share adds share difficulty ÷ network
  difficulty at the time, so the sum is the number of blocks the work was expected to find.
  Rounds run from one found block to the next, split on minute buckets.
- **Status** (`src/status.js`) checks each node, Stratum and the database separately, marks
  the node Stratum mines through, and flags nodes older than the latest XELIS release
  (`src/release.js`, from GitHub every 6 hours; `XELDASH_VERSION_CHECK=off`).
- **Price** (`src/price.js`): XEL in eleven currencies from CoinGecko, fetched by the server
  every 5 minutes while a viewer has it on, mainnet only; `XELDASH_PRICE=off` disables it.
- **Connect info** (`src/connect.js`, `/api/v1/connect`): the published Stratum, TLS and getwork ports, this
  computer's network address (from the launcher), whether other computers can reach it, and the
  mining address, for the dashboard's Get started page.
- **Nodes** come from `XELIS_RPC_URLS`, plus the official node while the fallback is on
  (read from the config volume).
