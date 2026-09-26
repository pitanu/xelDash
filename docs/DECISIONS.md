# Decision log

Record each decision once it's made. Anything still under "Open" should be resolved before
the phase that depends on it.

## Decided

| Date       | Decision | Notes |
|------------|----------|-------|
| 2026-09    | Open-source, self-hosted XELIS solo mining stats service in Docker Compose | LAN miners; each block reward goes to its miner's address |
| 2026-09    | Each connection can mine to its own `xel:` address; operator sets a default | No custody, no payouts |
| 2026-09    | Custom code in JavaScript/Node, React, Tailwind | |
| 2026-09    | PostgreSQL from day one | Not SQLite |
| 2026-09    | Plan the whole project before writing code | |
| 2026-09    | Use npm workspaces for the monorepo | Low setup cost; revisit if native addon packaging requires a different workspace tool |
| 2026-09    | Use JavaScript with JSDoc and TypeScript `checkJs` for service code | Keep one runtime language while type-checking shared service contracts; use Rust for the native hash addon |
| 2026-09    | Follow the official XELIS Stratum protocol documentation | Support `xel/v3` and documented legacy algorithm aliases; verify compatibility with real miners |
| 2026-09    | Integrate with daemon JSON-RPC at `/json_rpc`; use daemon-provided templates and miner work | Confirmed by the official daemon API; runtime and network behavior still need a devnet spike |
| 2026-09    | Persist daemon state at `/root/.xelis` in a named Docker volume | Reuse the working prototype's daemon data path; keep a new xelDash volume so the old node volume is not touched |
| 2026-09    | Collect and validate shares for pool-quality statistics, while submitting only solved blocks | No shared rewards, balances, payout processing, or hot wallet; miner-authorized address receives the block reward |
| 2026-09    | Keep miner and dashboard services LAN-only by default | Public internet exposure is outside the v1 deployment model |
| 2026-09    | Use plain SQL migrations and start with indexed, unpartitioned raw shares | Keeps the first schema simple; add partitioning when retention and observed volume justify it |
| 2026-09    | Custom Node stratum server instead of wrapping xelis-mining-proxy | The proxy runs with a single wallet address; per-address mining and share stats need a custom server |
| 2026-09    | Native hash addon via napi-rs, wrapping the official Rust `xelis-hash` crate | Share validation is too slow in plain JavaScript |
| 2026-09    | Separate services: daemon, stratum, api, web, postgres, plus a one-shot `migrate` service | Clear boundaries; api and stratum depend on migrations, not on each other |
| 2026-09    | Develop against devnet | Finding blocks quickly makes testing practical |
| 2026-09    | Push new work on the daemon's `new_block` WebSocket event; keep polling as a fallback | Polling alone leaves miners on a stale tip for a large fraction of block time |
| 2026-09    | Record every submitted block candidate before trusting shares | Block hash is BLAKE3 of the 112-byte MinerWork (as in xelis_common); submission happens before any database write |
| 2026-09    | Block status is final at the daemon's stable height | `submitted` → `main-chain` (Normal/Sync), `side` or `orphaned`; `rejected` if the daemon refuses it. `reward` stores the miner reward, not the dev share. |
| 2026-09    | Vardiff: start 100,000, min 1,000, 10 s per share, retarget every 60 s or 20 shares, max 2x step | About 6 shares per window keeps estimates responsive; the 50% dead band stops noise-driven retargets |
| 2026-09    | Dashboard: React + Vite + Tailwind, built into an nginx container that proxies `/api` | Matches the planned stack; no Node runtime needed to serve it |
| 2026-09    | No dashboard auth in v1 | LAN-only and read-only, like the API; bound to loopback unless configured |
| 2026-09    | Stratum abuse limits: 64 connections per IP, 20 msg/s (burst 40), 15-min ban at 50+ invalid submissions over 50% in 5 min | Lenient enough for LAN rigs behind one IP; stale shares excluded because every miner sends some after a new block |
| 2026-09    | Calculate V3 share difficulty and pool estimates using XELIS U256 targets | Hash bytes are interpreted big-endian; valid target is `floor((2^256 - 1) / difficulty)`. Accepted assigned share difficulty divided by elapsed completed-window seconds estimates H/s; expected TTB is network difficulty divided by H/s. |

## Open

- [ ] Project name (working name: **xelDash**; alternative: xelsolo)
- [ ] Getwork endpoint in v1, or stratum only?
- [ ] TLS stratum in v1?
- [x] Migrations / query tool — plain SQL migrations
- [ ] Share partitioning and retention policy — defer until usage and retention limits are set
- [ ] Retention defaults for shares and stats
- [x] Vardiff parameters and retarget interval: 10 s per share, 60 s / 20-share window
- [x] Dashboard auth model: none in v1; LAN-only
- [ ] License
- [x] Package manager / monorepo tooling — npm workspaces, JavaScript with JSDoc and `checkJs`
- [x] Stratum wire protocol — official XELIS Stratum documentation and documented algorithm aliases
