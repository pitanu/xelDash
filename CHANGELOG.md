# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may include
breaking changes; they are marked **Breaking**.

## [Unreleased]

First public version, planned as 0.1.0.

### Mining

- Fixed: a computer on your network that reset its connection while the getwork port was refusing it (a browser, a bad address) could stop the whole
  Stratum server. Found by a flaky test.
- Logins from miners that do not follow the Stratum specification to the letter are accepted: a session id or an algorithm name (or nothing) where the
  specification has the algorithm list in `mining.subscribe`, and a `solo:` before the address. Found with SRBMiner, which could not log in before.
- Mining no longer depends on the database. When it cannot be reached, miners stay connected and keep mining,
  and shares, blocks, events and bans are kept in a journal file and recorded, in order and with their original
  times, when it is back. A database outage no longer restarts the mining server or the API.
- Stratum server for XELIS (`xel/v3`) with per-address work: rewards go straight to each
  miner's address, and xelDash holds no funds.
- Share validation with the official XELIS Hash V3 code (native addon), hashed on a thread
  pool. Hashing, MinerWork layout, block hash and block submission are verified against the
  daemon on devnet.
- Per-connection vardiff (10 s per share by default), or a fixed difficulty the miner asks for
  in its password (`d=50000`).
- Works with classic Stratum miners that leave out `"jsonrpc"`; tested with Rigel 1.23.0.
- Shares on the previous job are accepted for 1.5 s after a new block (`STRATUM_STALE_GRACE_MS`),
  so GPUs finishing a batch are not rejected; later stale shares are counted as rejected.
- Getwork endpoint (port 8090) for the official `xelis_miner`, with the same stats and
  limits as Stratum.
- Optional TLS Stratum port (3334).
- Several nodes in priority order (`XELIS_RPC_URLS`), with an optional second node in
  Compose: mining fails over within seconds and moves back when the preferred node is in
  sync, so node upgrades do not stop mining.
- Work is paused while no node is in sync, and resumes on its own.
- Per-IP connection and message limits, and timed bans for invalid submissions.
- Block tracking: submitted blocks end as main chain, side or orphaned at the stable
  height, with their reward.

### Dashboard and API

- A "Dashboard offline" notice when the database or the server cannot be reached; it says mining continues when
  only the database is down, and goes away by itself.
- "Download all as CSV" on the Blocks and miner pages: every block with its time, height, hash, status,
  reward in XEL and the round's effort, for a spreadsheet or tax records. Spreadsheet formula characters in
  worker names are neutralised.
- Accessibility and phone pass: secondary text, status colours and buttons now meet 4.5:1 contrast in
  light and dark, text buttons and links are at least 24 px to tap, every page has a top-level
  heading for screen readers, and the daemon setting fields have names.
- A "Rewards over time" chart (running total found against what the work done should have found)
  and the rewards totals on the Blocks, miner and worker pages.
- A "Block found" notice at the top of the dashboard when your miners find a block, an optional
  chime (off by default, set per browser on the Settings page), and a flash on the new row. Motion
  is skipped when the system asks for less. Block alerts link to the block in the explorer.
- The Blocks page shows the total rewards found, split into main-chain and side blocks.
- Block heights link to the official block explorer.
- An alert (and event) when one of your blocks becomes a side block, before it is final.
- Alerts are set up on the Settings page, with a "Send a test message" button; changes apply
  without a restart.
- A Shares chart (accepted and rejected per bucket) under the hashrate chart, on the Overview, miner and worker pages. Stale shares are counted on their own (still part of the rejected total).
- A "Connection problems" card on Setup and Health explains, in plain words, why miners were
  turned away (wrong address, wrong network, not on your network, and so on).

- A "Page not found" page for unknown or malformed dashboard addresses, and clearer text on a
  new install before the first share arrives.
- The navigation fits on phones: all six pages, with the theme button beside the logo.

- Overview, Miner, Worker, Blocks and Health pages, in light and dark mode, with live
  updates over WebSocket.
- Hashrate charts from 6 hours to 1 year, estimated from accepted shares, next to the
  hashrate miners report.
- Expected earnings (blocks and XEL a day, and in money with the price on) on the Overview
  and each miner's page.
- A Miners tab (the address list with more than ten active addresses, else their workers).
  Workers without shares for 7 days drop off the lists, and can be removed sooner; history is
  kept and a worker that mines again comes back.
- The Overview shows the current round's effort and the median effort of found blocks.
- A beginner path: a launcher for Windows (`xeldash.cmd`) and macOS/Linux (`xeldash.sh`) that checks Docker,
  makes the passwords, chooses mainnet with the snapshot start, starts everything and opens the
  dashboard; commands to start, stop, update and to allow other computers (`lan on`). `.env.example`
  now defaults to mainnet with the snapshot.
- A Get started page and an Overview banner: four steps with progress and time left, the wallet
  address checked by your node (a link to the official web wallet for people without one), and
  copy-ready settings for Rigel, xelis_miner and other miners.
- Miners that send `address.worker` as the user name, or `[user, password]`, can log in.
- The dashboard no longer shows a 502 after the API or node admin is recreated.
- Mining luck: the current round's effort (work done against the work expected per block),
  luck as blocks found against blocks expected, and each block's round effort. Weighed
  against the network difficulty when each share arrived; tracked from this version on.
- Chart smoothing (raw, light or strong, remembered per browser) with the raw buckets kept
  as a faint line behind the smoothed one.
- REST API for all dashboard data.
- Optional XEL price in the header, in one of the largest currencies, and what found blocks are
  worth (mainnet only; off by default, chosen per browser under Settings). Fetched by the API
  from CoinGecko, so browsers never contact it; `XELDASH_PRICE=off` disables it.
- Alerts to Discord, Telegram or a JSON webhook: blocks found and final, mining paused and
  resumed, workers offline, and node version switches (started, done, failed).
- Node actions (version switches, stops, starts, restarts, chain copies) in Recent events.

### Security

- Review of the redundancy and outage code: a cluster code is validated field by field before use; the address manager checks its
  configuration values and writes a safe role file; every record sent to the ingest endpoint is checked (including a sequence
  number that could freeze later records); connection-problem events are shortened and rate-limited; the journal caps events and
  bans at twice its size limit (blocks are always kept); the standby's offline page has security headers; `.env` is owner-only
  on Linux and macOS.

- Miners and the dashboard accept only private networks by default
  (`XELDASH_ALLOWED_NETWORKS`); the Windows launcher can add firewall rules that allow the local
  subnet and block the internet.
- The database is on an internal network reachable only by the API, Stratum and jobs.

- Optional HTTPS and login in front of the dashboard (Compose profile `proxy`, Caddy), which
  only answers the configured host name.
- Malformed requests no longer crash Stratum, the API or node-admin.
- Failed logins count toward Stratum bans; at most 32 workers per connection; worker names
  may not contain control characters.
- Dashboard security headers on every response (Content-Security-Policy, no framing);
  browsers are refused on getwork and cross-site origins on the live WebSocket.
- Snapshot archives with links or special files are rejected; admin tokens must be at least
  20 characters; Discord alerts cannot mention everyone; backups are owner-only; the API and
  Stratum run as an unprivileged user. See `docs/SECURITY.md`.

### Operations

- Dependencies brought up to date, each tried first: the services run on Node 26 (images, CI and types), TypeScript 7, the hashing addon
  uses napi 3 (identical results, checked on twelve inputs, sync and async) and its build script `@napi-rs/cli` 3, and the base images
  (busybox 1.38, HAProxy 3.4, nginx 1.31) are newer.
- Releases install the ready-made images and update themselves: a downloaded release has its version in a `VERSION` file, the launcher uses it for
  `XELDASH_VERSION`, and `xeldash update` finds the newest release on GitHub, puts its files over the folder (keeping `.env`, backups and data) and
  restarts. The development branch (`VERSION` is `local`) still builds from source. `scripts/tag-release.sh` makes release tags; the release workflow
  checks `VERSION` matches the tag.
- End-to-end tests (`npm run e2e`): the real stack on a private devnet with real miners (Stratum and getwork), a database outage, a Stratum
  restart, and the front door through a failover and back. They run weekly and on demand in GitHub Actions.
- Fixed: records that arrive late (a journal replayed after an outage, or a standby server's batch) are now rolled into the hourly
  statistics. Before, hours more than an hour behind the latest were skipped, so that work would have vanished from the long-range
  charts and effort once the per-minute rows were deleted after 90 days.
- Events and old bans are now deleted after a year (`RETENTION_EVENT_DAYS`, default 365); they only ever grew before. Hourly stats and
  blocks are still kept.
- Faster: the effort figures no longer slow down with the number of workers; the live-update listener no longer leaks a database
  connection when a restart of the database interrupts it; version switches wait for a running snapshot or chain copy.
- A "Support xelDash" card on the Settings page (mainnet only) with the maintainer's wallet address, and a one-time dismissible note on the
  Overview after your miners find a block. Optional; nothing depends on it.
- A test suite (`npm test`, Node's built-in runner): Stratum, API, node-admin, database (with a throwaway PostgreSQL), dashboard formatting,
  the Linux launcher, the documentation and the Compose files; it runs in CI. It found and fixed two small bugs: an empty
  `STRATUM_BAN_EXEMPT_IPS` produced an exempt address named "unknown", and XEL amounts used a dot where the viewer's language uses a comma.
- In a two-server cluster the standby follows the main server's default wallet address, and sends the failover alert itself when the
  main server cannot be reached (it keeps a copy of the main server's alert settings).
- Pruning is documented with measured sizes (a mainnet node goes from about 10.6 GB to about 6 GB, whatever number of blocks is
  kept, and the space returns only after a restart), the Settings help for it says so, and on a pruned node a block the
  node no longer knows stays pending instead of being marked orphaned.
- The installer checks free disk space before the first download (mainnet): about 40 GB for the fast snapshot start, 25 GB
  for the slower start that syncs from other nodes. If only the slower start fits, it offers it; below that it stops.
- A system requirements page (minimum and recommended: disk, memory, processor, network, operating systems), with the
  figures measured on the running mainnet stack and what has not been measured yet marked.
- Redundancy between two Linux servers (`xeldash cluster setup` and `cluster join`): they share one address, held by
  whichever can mine, so mining carries on when one loses power or restarts. The second server has no database;
  it records through the main server (a new `/api/v1/ingest` endpoint, migration 008) and keeps a journal while it
  is away. Its page shows "Dashboard offline. Mining continues." when the main dashboard cannot be reached. New images
  `keepalived` and `standby-web`, and new settings `XELDASH_CLUSTER_SECRET`, `XELDASH_VIP`, `XELDASH_CLUSTER_ID` and
  `XELDASH_PRIMARY_URL` (written by the launcher). Docker Desktop (Windows, macOS) cannot be part of a cluster.
- A front door (`xeldash frontdoor setup` on the main server, `frontdoor join CODE` on a Linux box): the miners connect to the Linux
  box, which forwards them to the main server (Windows or macOS too) while that can mine, and to its own Stratum when it cannot.
  Uses HAProxy (new image `frontdoor`) and the PROXY protocol (`STRATUM_PROXY_FROM`), so miners' addresses, limits and bans
  stay right; the dashboard answers `/api/v1/mining-health` for the check. Protects against the main server stopping, not the
  front door. The Health page of the main server has a "Front door" card: how many rigs arrive through it, and a warning for rigs
  connected straight to the main server (which have no standby). The front door can also accept encrypted Stratum (port 3334) with the
  same `docker/stratum-tls` certificate files and `STRATUM_TLS_ENABLED=true`.
- Backups from the dashboard (Settings, "Download a backup") and from the launcher (`xeldash backup` and
  `xeldash restore FILE`), with no extra tools or services needed.
- A "Mining availability" card on the Health page: the share of the last day, week or month miners could be
  given work, and the pauses behind the rest.
- A notice when a newer xelDash is released, with how to update, and the running version at the foot
  of every page.
- Free disk space is read from your computer's drive under Docker Desktop, where a container otherwise sees
  the size of Docker's virtual disk, and is shown in the same units as the operating system.
- A low-disk warning on the Overview and Health pages, and a `disk_low` alert, when the nodes' disk has
  less free space than `XELDASH_DISK_WARN_GB` (default 20 GB).
- Docker Compose stack; the daemon runs XELIS 1.25.0, which mainnet requires (1.24.0 or
  newer).
- Daemon settings from the dashboard: every option of the installed XELIS daemon, checked by
  the daemon's own parser before a restart and rolled back if the node does not stay up.
  Options the daemon refuses together, such as fast sync with boost sync, are refused on save.
- A Settings page: the official node fallback, trusted peers and the most useful daemon
  options with plain-language explanations, and every other daemon option below them.
- Scheduled version switches at a block height, for network upgrades: the release is
  prepared on every node at once and switched in one node at a time at the height.
- Optional automatic node updates (off by default, two local nodes needed): new releases are
  installed one node at a time 24 hours after they come out.
- Daemon upgrades from the dashboard: official releases, checked against their checksums,
  switched one node at a time with the usual mining node last, each back in sync before the
  next; a node that does not stay up is switched back.
- Node management for both nodes on the dashboard: restart, stop and start each node, copy
  one node's chain data into the other (minutes instead of a full sync), and each node's
  snapshots and daemon settings. The Health page flags nodes older than the latest release.
- Trusted peers on the dashboard: a list of `IP:port` peers the node connects to first
  (priority) or exclusively.
- Official node fallback: an optional switch to keep mining through the XELIS team's public
  node while none of your own nodes can issue work. Off by default.
  Needs `XELDASH_ADMIN_TOKEN`.
- Snapshots: start or replace a node's chain data from the official daily mainnet snapshot
  (downloaded, resumable, checksum-verified) or a zip dropped onto the dashboard. Optional
  automatic download on a first start. Needs `XELDASH_ADMIN_TOKEN`.
- Share retention (raw 7 days, per-minute 90 days, hourly kept) with an hourly rollup.
- Optional daily database backups, and a guide for backups, restores and upgrades.
- Multi-arch images (amd64, arm64) published to GHCR on version tags; CI on every push.
