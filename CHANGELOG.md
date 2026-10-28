# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may include
breaking changes; they are marked **Breaking**.

## [Unreleased]

### Security

- Idle connections can no longer fill a server. When the per-IP or total connection limit is reached, the connection quiet the
  longest that has never had a share accepted (and has been quiet for at least 2 minutes) is closed to make room, rather than the
  new miner being refused. On a public server, a connection with no share for 30 minutes (15 if it never sent one) is closed
  (`STRATUM_IDLE_SECONDS`; off elsewhere unless set). Stratum connections use TCP keepalive, so a rig that vanished is noticed.
- Reconnecting in a loop no longer loads the database. A rig that logs in again within 5 minutes from the same IP address reuses its
  last login instead of a database write, and many connections of one worker logging in at once share one. On a public server, new
  connections from one IP address are limited to 20 a second after a burst of 1,000 (`STRATUM_CONNECTIONS_PER_IP_PER_SECOND`), so a
  farm can still reconnect at once after a restart; the Connection problems card explains the new refusal.

### Fixed

- Chart axes no longer show float noise in tick labels on Node 22 (`10 ** -5` is not exact there). CI now also runs on Node
  22.15.0, the oldest version that `engines` allows.

## [0.7.0] - 2026-10-24

A new look for the dashboard, with nothing taken away: colour themes and a colour of your own, a Connect page, an effort chart on
Blocks, a layout for phones and tablets, and installing it as an app. Updates now take a backup first. No database migration, so
going back to 0.6.1 still works.

### Operations

- `xeldash update` saves a backup of the statistics before it changes anything (`backups/xeldash-before-update-<time>.dump`; the
  newest three are kept), so an update that goes wrong can be undone with `xeldash restore`. If the backup cannot be taken, the
  update stops with nothing changed; `XELDASH_UPDATE_SKIP_BACKUP=1` updates without one.
- On Windows, a finished update no longer reports a failure left behind by an earlier command.
- `XELDASH_PUBLIC_HOST` is now `XELDASH_CONNECT_HOST`: the address miners are told to connect to (your home-network address, or a
  public server's domain), which had nothing to do with public mode. The old name keeps working through 1.x. The next time the launcher
  runs, it adds the new name to `.env` with the same value and keeps the old line, set alongside it by `lan on` and `lan off`,
  so going back to 0.6.1 or older still finds it.
- A miner that logs in with only a worker name (`rig1`) is told that the user name starts with the address
  (`address.worker`), and the Connection problems card says so too. A login with no address and no default one says to set a
  default payout address in Settings, not an environment variable.
- The Nodes page says when the official snapshot is missing from the XELIS team's server (404), not only that it cannot be
  reached.
- The webhook alert's fields are written down for each kind of alert (Operations, "Webhook alerts") and checked by a test, so they
  cannot change by accident; from 1.0.0 none of them is renamed or removed within 1.x. A failed chain copy now says so in the
  webhook too (`node_update` with `outcome: "copy_failed"`).

### Dashboard

- A new look, with nothing taken away: the pages are rebuilt as cards, with a top bar showing the mining status and, on phones
  and tablets (below 960 px wide), tabs along the bottom. The Overview leads with hashrate and its chart beside when the next
  block is expected, the round's effort and luck, then what you earned in 30 days and your share of the network. Blocks adds a
  chart of each block's effort (hover or the arrow keys for each block, or a table) and the orphan rate.
- Five colour themes, each with a light and a dark version: Classic (the colours from before, and the default), Ember, Glacier,
  Amethyst and Terminal; or a main colour of your own, with light and dark versions worked out so it stays readable. Per
  browser, under Settings, Appearance.
- A Connect page ("Mine here" on a public server) with your address in every setting and command, and your workers listed as
  they connect. It says when a pool address or a whole `address.worker` was pasted as the address, and that the dashboard's
  port is not the mining port.
- Settings is grouped into Appearance, Mining, and Notifications and display, with switches. A public server's visitors get a
  Settings page too, with Appearance, animations and the block sound only.
- The dashboard can be installed as an app from the browser ("Install app", "Add to Home Screen"), with its own icon. Nothing
  runs in the background.
- A link to support xelDash at the foot of every page.
- The numbers on the tiles count up when they first show, and move to their new value when a refresh changes it, in your
  browser's number format; screen readers get the final value. The charts' animations take about a second instead of half that.
  Both are skipped when your system asks for less motion, and Settings ("Animate charts and numbers") turns them off.

## [0.6.1] - 2026-10-22

Fixes found while testing the real release update from 0.5.0 to 0.6.0, and during a GitHub incident. No database migration.

### Fixed

- Updates keep working when GitHub's list of releases comes back empty, as it did during a GitHub incident on 2026-10-22: the
  launchers (`xeldash update`), the dashboard's update notice and the Nodes page's XELIS releases then use GitHub's newest release.
  Before, `xeldash update` blamed the internet connection, and the Nodes page showed no releases.
- The Nodes page no longer keeps an empty list of XELIS releases for an hour: it asks GitHub again the next time.
- Setting up xelDash where it already has a database (a second copy unzipped into another folder, or the same one after `.env` was
  removed) stops before anything is changed and says where the existing one is, how to use it, run a second copy, or start over.
  Before, the new setup took over the existing containers and failed with a database password error.
- On a private devnet, a node switch (from the Nodes page or at a block height) finishes once the node runs the new version: it no
  longer waits for peers that a private devnet does not have, which made it fail after 30 minutes.

## [0.6.0] - 2026-10-22

The dashboard: your own block sound, a block notice that stays and shows in the tab title, blocks found in the last 24 hours,
and chart animations. No database migration.

### Dashboard

- A block sound of your own: in Settings, choose an audio file (at most 1 MB and 10 seconds) to play instead of the chime when a
  block is found. It stays in your browser and is never sent to the server, so it is safe on a public server too.
- The "Block found" notice stays until you close it, or for an hour, instead of 12 seconds, so it is not missed.
- The Overview's "Blocks found" says how many of them were found in the last 24 hours ("1 in 24 h"), and the number pending
  only while there is one, so it fits on one line.
- A block found while the dashboard is on another tab shows in the tab title, "(1) Block found · xelDash", until you look
  at it again.
- Charts animate: lines draw in, bars grow and dots appear when a chart loads or changes range, and each new bar or dot as
  it arrives. They run once, never loop, and are skipped when your system asks for less motion; Settings can turn them off.
- New README screenshots, and one of the best share chart.

### Development

- The tests no longer fail or hang now and then when they run in parallel (on Windows especially): test servers listen on a
  port the system picks, every test connection ends, and a test that hangs fails after a minute.
- Node.js 22.15 or newer is needed for the tests (`engines` in package.json); CI uses 26.

## [0.5.0] - 2026-10-19

Best share: how close each address came to a block. Includes a database migration (010), which only adds a column; going back
to 0.4.x still works.

### Dashboard

- **Best share** on the miner and worker pages: how close each address's best share came to a block, as a percentage of one
  (100% is a block), for this round, the last 24 hours and ever, with a chart of the best share per bucket. Per address only, in
  LAN and public mode alike; nothing is shown across everyone's rigs. Worked out from the hash Stratum checks anyway and kept per
  worker and minute (migration 010). `XELDASH_BEST_SHARE=off` turns it off. See docs/OPERATIONS.md#best-share.

## [0.4.2] - 2026-10-18

daemon2 follows each release, alerts in plain text, and a test of updating from the last release.

### Fixed

- With two nodes, a release install never updated daemon2's container: it was built once, the first time, and kept through every
  later update, so a fix to the node container reached daemon only. daemon2 is now built from each release's own files (never
  pulled), and an unchanged build keeps its id, so the node is not restarted for nothing.

### Development

- A second end-to-end job updates the newest published release to the commit under test, with data in its database and two
  nodes, and checks the migrations, the data and daemon2 afterwards (`npm run e2e:upgrade`). Releases wait for it too: the first
  job only ever starts from nothing, and updates are the path every existing install takes.

### Changed

- Alerts are plain text: they no longer start with an emoji (they already say what happened in words). A webhook that matched on
  the text should match on its `event` field instead. The dashboard uses its own warning icon where it showed a warning sign, and the block
  banner no longer has one.

## [0.4.1] - 2026-10-16

Updates no longer fail when the database is slow to start.

### Fixed

- An update could fail with "xelDash could not start" because the database migration ran before PostgreSQL accepted connections
  (seen on a user's server; `xeldash start` afterwards worked). The migration now waits for the database, up to 90 seconds, and says
  so in its log; a wrong password or another real error still fails at once.

## [0.4.0] - 2026-10-16

Prometheus metrics from Stratum, opt in and naming no miner.

### Operations

- Prometheus metrics from Stratum, for Grafana or any other monitoring, off by default: add `metrics` to `COMPOSE_PROFILES`. Shares
  by result and the hashrate they prove, answer times, blocks, the share queue and journal, each node's state, height and peers,
  bans, and Stratum's own processor time and memory. Totals only, naming no miner; per-worker metrics are their own choice
  (`XELDASH_METRICS_PER_WORKER`) and never served in public mode. The port is on 127.0.0.1 unless you choose otherwise, can require
  a token, and on a public server published beyond this computer without one, every scrape is refused. Off, nothing listens and
  nothing is counted; on, the capacity test at up to 2,000 shares a second showed no difference in answer times or processor use.
  See docs/OPERATIONS.md#metrics.

## [0.3.0] - 2026-10-15

Shares written in batches and counted instead of stored one by one, updates that keep mining with two nodes, a dashboard and
health checks that use far less processor time, and an alert for a node without peers. Includes a database migration (009); see
Mining below for what it changes and how to go back.

### Mining

- While the database cannot be reached, Stratum keeps answering shares quickly at a high share rate. Each share was written to the
  journal file in turn, behind the share hashes, and its answer waited for that: on a 4-core computer the time to answer grew to 4 s at
  800 shares a second, with late shares counted stale. Shares that arrive together are now written together; the same test answers in
  12 ms. See docs/REQUIREMENTS.md.
- Shares are written to the database in batches (every 200 ms or 500 shares, one statement each) instead of one transaction each,
  and a miner's answer no longer waits for the database. At 2,000 shares a second the database used 0.12 of a core instead of 1.6,
  and the slowest 5% of answers came in 2 ms instead of 22. See docs/REQUIREMENTS.md.
- Shares are no longer stored one by one. They are counted in the per-minute stats as before, and rejected ones by reason in a new
  per-minute table, which the worker page's "Rejected shares by reason" reads. The upgrade (migration 009) counts the rejected shares
  still on record, so the last day stays visible. The old `shares` table is left in place, so going back to 0.2.x still works:
  nothing writes to it, and retention empties it within `RETENTION_RAW_SHARE_DAYS` (7 days, 1 on a public server).
- After a database outage, the shares kept meanwhile are recorded in batches as well: about 56,000 a second instead of 540. A
  standby server's batches are recorded the same way. Before, a busy server (more than about 540 shares a second) could fall further behind while catching up,
  since new shares wait in the journal until it is empty.
- Duplicate shares are caught by their connection, from the work each accepted share proved. The same nonce sent under a job id
  reissued at a new difficulty (the same work) was counted twice before; it is now a duplicate.

### Operations

- A new alert, `node_peers`: one of your nodes has had no peers for two minutes, and again when it has them back. Such a node
  cannot tell whether it is behind, and a block found on it would reach no one (seen right after a restart, when both nodes
  briefly had none). Mainnet and testnet only; on a private devnet the Health page now shows no peers as normal instead of a
  warning. Mining is not paused for it. It is on by default; if you picked your alerts on the Settings page before, tick it there.

- Updates no longer restart both nodes at once. With two nodes, `xeldash update` (and `xeldash start`) updates everything else
  first, then the nodes one at a time, the second only once the first has caught up, so mining does not pause; tested with a
  simulated release on both launchers, with a node always healthy. Before, every update restarted every service, both nodes
  included, even ones that had not changed: on Docker Desktop each build gave every image a new id, and the `migrate` and `api`
  services built the same image twice. Now only what changed is restarted.
- Less processor time while idle. The health checks of node-admin (every 5 s), the API and Stratum started a Node.js process each
  time, about 0.1 s of processor time; they use `wget` and a plain TCP check now, which cost next to nothing.
- An open dashboard asks for much less. A new block of the network (every few seconds on mainnet) refetched every panel on the
  page, the database queries behind them included; now it refetches only the chain tip (the Overview's figures and the Health
  page's node status), at most every 10 s, and the API keeps the overview's statistics for 10 s (they change by the minute), so
  each of those asks only the node; the rest follows events (our blocks, node changes) and the usual polling. Panels that ask for the same
  thing at the same moment share one request. The checks on every page poll quickly only while there is something to watch: the
  setup guide until setup is done, the cluster banner on a server in a cluster, and the offline notice once a check fails (every
  30 s otherwise, and at once when the live connection drops).

### Development

- Releases wait for the end-to-end check on a devnet and for the dashboard's typecheck, build and component tests before any
  image is published.
- The dashboard is typechecked in CI (`npm run typecheck` in `web/`), and its tests pass whatever the computer's language.

## [0.2.0] - 2026-10-13

Public mode (a solo mining server anyone may use), work shared between all miners, a share every 5 seconds, and hardening for a
server on the internet.

### Mining

- Vardiff now aims for one share every 5 seconds, XELIS's block time (it was 10). `xeldash update` changes the old default in an
  existing `.env` (`STRATUM_TARGET_SHARE_SECONDS=10`) to 5 and says so; any other value you set is kept.
- When the node accepts a block found by one of our rigs, every rig gets new work at once instead of waiting for the node's
  new-block event.
- Rigs share the node's work between all addresses (one template per block for every miner), once the node is seen to give
  the same work to each address; a devnet test checks every block pays the rig that found it. The node's load no longer grows
  with the number of miners: 4,000 rigs on 200 different addresses used about 1% of a core on the node.
- Rigs mining to the same address share their work from the node: two calls to the node per block for each address instead of
  for each rig. On the capacity test (one address) 2,000 rigs went from overloaded (answers up to 16 s) to smooth (3 ms typical),
  and 4,000 rigs now work; see docs/REQUIREMENTS.md.

### Dashboard and API

- While the XELIS node is not answering yet (a first start: downloading and catching up), the Overview says so instead of
  "Unable to reach the xelDash API".
- **Public mode** (`XELDASH_PUBLIC_MODE=true`), for a server anyone may solo mine on, each to their own address: visitors get
  no IP addresses, no connection problems and no node administration, a "Mine here" page shows how to connect, and a login
  without an address is refused. The operator's full dashboard is on 127.0.0.1 only (Compose profile `public`), and the
  `public-https` profile adds HTTPS with a Let's Encrypt certificate. Recent events are the operator's only; there are no
  alerts about individual workers, and cluster alerts leave out the shared address. A standby server or front door follows the
  main server's public mode by itself. Automatic node updates on a public server run only while `.env` allows them
  (`XELIS_AUTO_UPDATE=true`) and wait at least 36 hours. Everything reachable from the internet is limited: Stratum asks the
  XELIS node at most 100 times a second whatever miners do, allows 1,000 connections and 32 addresses per IP address and 5,000 in
  all; the API asks the node at most once every 2 seconds per question; the dashboard limits each visitor and all visitors
  together; the official node fallback is never used; and per IP address at most 300 shares are checked a second and 1,000
  new worker names are taken an hour. A `d=` difficulty in the password is where a rig starts there, and vardiff can still raise
  it; raw shares are kept one day. See docs/OPERATIONS.md#public-mode.

### Security

- A share for a job the connection was never given counts as invalid (towards a ban) and is not recorded; late shares are
  recorded at most 30 a minute per connection. Before, made-up job ids were recorded as stale shares without limit.
- Workers that never had a share accepted are deleted after a day unused (`RETENTION_UNUSED_WORKER_DAYS`), with their address if
  nothing else uses it.
- A login whose address is not shaped like a XELIS address (`xel:` or `xet:` and 10 to 120 letters and digits) is refused before
  it reaches the node or any cache; before, an address could be as long as a message (64 KiB).
- Getwork and Stratum TLS turn away banned addresses, and more connections from one address than its limit allows, as soon as they
  connect, and close a connection that has not finished its upgrade or handshake within 10 seconds. Before, a connection was only
  counted once it was set up, so idle ones could be held open for a minute or two without limit.
- Public mode: Stratum warns when miners arrive from Docker's gateway address, which hides their real addresses (Docker Desktop, or
  IPv6 through Docker's proxy), so per-IP limits cannot work; the API warns when its own port is published beyond this computer.
  Live updates to visitors carry only new blocks, not the operator's other events. The public answer cache reads request paths
  the way the API's router does, and `range` parameters accept only the listed ranges.

### Operations

- Every container's log is rotated (`XELDASH_LOG_MAX_SIZE`, `XELDASH_LOG_FILES`; 50 MB per container by default).
- Stratum TLS takes a renewed certificate without a restart, and waits for a certificate that is not there yet instead of failing
  to start. A public server can use its domain's Let's Encrypt certificate for Stratum TLS (docs/OPERATIONS.md#public-mode).

### Documentation

- A community tester on Lubuntu reports SRBMiner, Rigel, OneZeroMiner and ForgeMiner working through xelDash (docs/MINERS.md).
- Getting started: what to do when the node does not start, or stops, on the first run (seen on Lubuntu).
- Public mode wherever the documentation said xelDash is for a local network only; a community-testing section for a public server.

## [0.1.0] - 2026-10-07

First public version.

### Mining

- Side blocks are no longer described as paid "at a reduced reward". The first side block seen on mainnet was credited in full (checked in the node's account
  history), so the dashboard, the alert and the docs now say it is paid in the amount the node credits.
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

- On a test network (testnet or devnet) amounts are shown in XET, the name of the coin there, instead of XEL: the Blocks and miner pages,
  the expected earnings, and the alert messages. The CSV's reward column is named `reward_xet` there (it stays `reward_xel` on mainnet).
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

- A capacity test (`npm run load`), and a measured answer to "how many rigs": comfortable to a few hundred, about a thousand on a fast desktop,
  overloaded from two thousand (see the requirements page).
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
