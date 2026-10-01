# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may include
breaking changes; they are marked **Breaking**.

## [Unreleased]

First public version, planned as 0.1.0.

### Mining

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
