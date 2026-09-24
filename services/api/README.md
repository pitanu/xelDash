# API service

The Node.js REST API connects to PostgreSQL and the XELIS daemon over the private Compose
network. It exposes `/health` and `/api/v1/overview`. The overview estimates hashrate from
accepted share difficulty over completed 5-minute, 1-hour, and 24-hour buckets. Expected
time-to-block is network difficulty divided by that observed hashrate; it is an expectation,
not a prediction. Estimates are `null` until the selected window has accepted shares.
