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
| 2026-09    | Use npm workspaces and TypeScript for the initial implementation | Low setup cost; revisit if native addon packaging requires a different workspace tool |
| 2026-09    | Integrate with daemon JSON-RPC at `/json_rpc`; use daemon-provided templates and miner work | Confirmed by the official daemon API; runtime and network behavior still need a devnet spike |
| 2026-09    | Persist daemon state at `/root/.xelis` in a named Docker volume | Reuse the working prototype's daemon data path; keep a new xelDash volume so the old node volume is not touched |
| 2026-09    | Collect and validate shares for pool-quality statistics, while submitting only solved blocks | No shared rewards, balances, payout processing, or hot wallet; miner-authorized address receives the block reward |
| 2026-09    | Keep miner and dashboard services LAN-only by default | Public internet exposure is outside the v1 deployment model |
| 2026-09    | Use plain SQL migrations and start with indexed, unpartitioned raw shares | Keeps the first schema simple; add partitioning when retention and observed volume justify it |

## Proposed (confirm or reject)

| Proposal | Why |
|----------|-----|
| Write a custom Node stratum server instead of wrapping xelis-mining-proxy | The proxy runs with a single wallet address; per-address mining and share stats need a custom server |
| Native hash addon via napi-rs | Share validation is too slow in plain JavaScript |
| Separate services: daemon, stratum, api, web, postgres | Clear boundaries, and each can be scaled or restarted on its own |
| Develop against testnet/devnet | Finding blocks quickly makes testing practical |
| TypeScript instead of plain JS | Safer protocol code; shared DB types |

## Open

- [ ] Project name (working name: **xelDash**; alternative: xelsolo)
- [ ] Getwork endpoint in v1, or stratum only?
- [ ] TLS stratum in v1?
- [x] Migrations / query tool — plain SQL migrations
- [ ] Share partitioning and retention policy — defer until usage and retention limits are set
- [ ] Retention defaults for shares and stats
- [ ] Vardiff parameters and hashrate formula
- [ ] Dashboard auth model
- [ ] License
- [x] Package manager / monorepo tooling — npm workspaces + TypeScript (initial choice)
