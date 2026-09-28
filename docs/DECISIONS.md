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
| 2026-09    | Offer a getwork proxy alongside Stratum in v1 | The official xelis_miner only speaks getwork; proxying it gives those users per-address stats too |
| 2026-09    | Optional built-in TLS Stratum port in v1 | Cert and key supplied through `.env`; plain Stratum stays the default |
| 2026-09    | Retention: raw shares 7 days, minute stats 90 days, hourly rollups, blocks and events kept | Bounded storage (~15 MB of raw shares per worker) with long-range charts from hourly rows; no partitioning needed at this size |
| 2026-09    | Snapshots from the official daily mainnet zip or a dashboard upload; automatic download is opt-in | Starting from a snapshot means trusting its publisher, and costs about 9 GB, so it is an explicit choice |
| 2026-09    | Snapshot actions need `XELDASH_ADMIN_TOKEN` | The dashboard has no login, and replacing a node's database is the most destructive action in xelDash |
| 2026-09    | The node container swaps snapshots in itself (busybox supervisor), coordinated through files on the data volume | No service needs the Docker socket; the swap happens only while the daemon is stopped |
| 2026-09    | Dashboard daemon settings are extra command-line flags, listed from the daemon's `--help` | A daemon config file would discard Compose's flags; the help output keeps the list exact for each daemon version |
| 2026-09    | Settings are checked with the daemon's parser before a restart and rolled back if it exits within 30 s | A bad setting must never leave the node down |
| 2026-09    | License: MIT | Simple and permissive; matches the XELIS hash crate xelDash builds on |
| 2026-09    | Name: xelDash | Already used for the repository, images and docs |
| 2026-09    | Official node fallback: optional, off by default, used only while none of our nodes can issue work | Keeps mining through syncs and outages; a third party then supplies templates, so it is an explicit choice. The reward key is looked up on our own node. |
| 2026-09    | Trusted peers as `IP:port` only; Compose service names resolved at each start | The daemon silently ignores host names in peer flags |
| 2026-09    | Accept classic Stratum without `"jsonrpc"` | Rigel and other GPU miners send it that way |
| 2026-09    | Accept shares on the replaced job for 1.5 s after a new block; record later stale shares | With ~5 s blocks, a GPU's in-flight batch made ~10% of shares stale; they are real work. Recording them keeps the dashboard's reject count honest. |
| 2026-09    | Fixed difficulty from the password (`d=`) | Common miner and pool convention; some GPUs prefer a fixed target |
| 2026-09    | Effort recorded per share against the network difficulty at the time | Difficulty changes every block, so luck cannot be recomputed later from current difficulty |
| 2026-09    | XEL price fetched by the server from CoinGecko, per-browser opt-in, mainnet only | Browsers never contact a third party and the CSP stays strict; test-network coins have no price |
| 2026-09    | Theme and price are per-browser choices | Display preferences, not node settings; no admin token needed |
| 2026-09    | Manage both local nodes from node-admin through files on each node's volume | Same model as settings and snapshots; still no Docker socket |
| 2026-09    | Daemon upgrades by downloading official release binaries onto the node's volume, not by changing images | A Docker socket would make the admin token root on the host. Releases are checked against checksums.txt, GitHub's digest and the inner checksum list; PGP is not possible until the signing key is published. |
| 2026-09    | Version switches one node at a time, the usual mining node last, each back in sync before the next; run by node-admin | Mining never stops with two nodes; closing the browser does not interrupt a switch |
| 2026-09    | Scheduled switches at a block height; the release is prepared on every node when scheduled | Hard forks name a version and height; preparing early surfaces problems long before the fork |
| 2026-09    | Automatic updates optional and off by default; need two local nodes; 24 h after a release; forward only; a failed version is not retried | Unattended updates are convenient but a new release carries risk; the delay and the second node limit it |
| 2026-09    | Calculate V3 share difficulty and pool estimates using XELIS U256 targets | Hash bytes are interpreted big-endian; valid target is `floor((2^256 - 1) / difficulty)`. Accepted assigned share difficulty divided by elapsed completed-window seconds estimates H/s; expected TTB is network difficulty divided by H/s. |

## Open

- [x] Project name: **xelDash**
- [x] Getwork endpoint in v1, or stratum only? Getwork proxy in v1
- [x] TLS stratum in v1? Optional built-in TLS port
- [x] Migrations / query tool — plain SQL migrations
- [x] Share partitioning and retention policy: time-based deletes, no partitioning for now
- [x] Retention defaults for shares and stats: 7 days raw, 90 days per-minute, hourly kept
- [x] Vardiff parameters and retarget interval: 10 s per share, 60 s / 20-share window
- [x] Dashboard auth model: none in v1; LAN-only
- [x] License: MIT
- [x] Package manager / monorepo tooling — npm workspaces, JavaScript with JSDoc and `checkJs`
- [x] Stratum wire protocol — official XELIS Stratum documentation and documented algorithm aliases
