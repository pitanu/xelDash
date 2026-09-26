# API service

The Node.js REST API connects to PostgreSQL and the XELIS daemon over the private Compose
network. It exposes `/health`, `/api/v1/overview`, and the dashboard endpoints and the `/api/v1/live` WebSocket listed in
[docs/PLAN.md](../../docs/PLAN.md) section 8 (hashrate history, miners, blocks, events). The overview estimates hashrate from
accepted share difficulty over completed 5-minute, 1-hour, and 24-hour buckets. Expected
time-to-block is network difficulty divided by that observed hashrate; it is an expectation,
not a prediction. Estimates are `null` until the selected window has accepted shares.
