# Operations

## Alerts

The API can send alerts to Discord, Telegram and/or any JSON webhook.

The easy way: open **Settings**, unlock with the admin token, fill in one or more places under
"Where to send alerts", pick which alerts you want, save, and press **Send a test message**. Changes
apply within seconds, without restarting anything. The saved settings replace the `.env` values; the
dashboard only ever shows the last four characters of a saved address or token.

The `.env` way, which gives the starting values (restart the API with `docker compose up -d api`):

| Setting | Use |
|---------|-----|
| `ALERT_DISCORD_WEBHOOK_URL` | A Discord channel webhook URL |
| `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` | A bot token from @BotFather and the chat to post in |
| `ALERT_WEBHOOK_URL` | Receives `{ event, text, ...details, sentAt }` as a JSON POST (see [Webhook alerts](#webhook-alerts)) |
| `ALERT_EVENTS` | Which alerts to send (default: all but `worker_unusual`, see below) |
| `ALERT_WORKER_OFFLINE_MINUTES` | Minutes without an accepted share before a worker counts as offline (10) |
| `ALERT_DASHBOARD_URL` | Adds dashboard links, for example `http://192.168.1.10:8088` |

Events:

- `block_found`: a block candidate was accepted by the node.
- `block_rejected`: the node refused a block candidate.
- `node_peers`: one of your nodes has had no peers for two minutes (mainnet and testnet only; a private devnet has
  none to find), and again when it has peers back. Such a node cannot tell whether it is behind, and a block found on it
  would reach no one. Mining is not paused for it.
- `disk_low`: the disk the nodes use has less free space than `XELDASH_DISK_WARN_GB` (default 20 GB), or
  less than 5 GB. Sizes are counted the way Windows Explorer, Finder and `df` count them. Under Docker Desktop
  the nodes' data sits in a virtual disk that reports its own size, so xelDash also reads the free space of your
  computer's drive (through a read-only folder, `docker/hostdisk`, on the same drive as the xelDash folder) and
  uses the smaller of the two. If Docker's data is on a different drive from the xelDash folder, check that
  drive yourself. A full disk stops a node and can force a long resync. The dashboard shows the same warning
  on the Overview and Health pages. Checked every 10 minutes, repeated at most once a day.
- `cluster`: in a two-server cluster, this server took over the shared address, cannot mine and gave it up, or is
  standing by again (see [Redundancy](#redundancy-two-servers)).
- `block_side`: one of your blocks lost the race for its height and is a side block for now. Side
  blocks are paid too once final, in the amount the node credits, which is shown on the Blocks page; this comes well before that. (The first
  one seen on mainnet was credited in full, the same as a main-chain block, so do not expect a smaller amount: the daemon's account history is
  the authority on what was paid.)
- `block_final`: a block reached the stable height, as main chain, side or orphaned, with its
  reward. Blocks that become final within 5 seconds of each other arrive as one summary.
- `mining_paused`: Stratum paused work because no node is usable, when it resumes, and
  when mining switches to another node.
- `worker_offline`: a worker stopped sending accepted shares, and when it comes back. Only
  workers with shares in the last 24 hours are watched. After an API restart the first check
  only records state, so workers that were already offline are not announced again.
- `worker_unusual` (off unless chosen): the same silence, said only when the rig usually mines at this time of day. That is,
  it was mining through the same stretch (from its last share until now, at the same clock time) on at least 5 of the last 7
  days, where a day counts when it had shares in at least half of that stretch's minutes. A rig that runs on a schedule, such
  as at night only, stays quiet when it stops on time. A rig needs 5 days of history first, and its return is announced with
  `worker_online`. Choose it instead of `worker_offline`: with both, a rig that stops at its usual time gets both messages.
  Days are 24 hours, so for a week after a daylight-saving change the stretch is an hour off.
- `node_update`: a node version switch started, finished or failed (including automatic and
  scheduled ones), and a failed chain copy.

Node stops, starts, restarts and chain copies also show under Recent events on the
dashboard.

Each channel sends at most one message per second. If alerts pile up, extra ones are skipped
and the next message says how many.

The API log lists the enabled channels at startup ("Alerts enabled: ..."). Failed deliveries
are logged and not retried.

### Webhook alerts

A webhook receives each alert as a JSON POST: `event` (below), `text` (the same message Discord and Telegram get), the alert's
fields, and `sentAt` (when it was sent, as an ISO time). From 1.0.0 these field names stay: new fields may be added, and none listed
here is renamed or removed within 1.x (`services/api/test/alerts-webhook.test.js` checks them). Block heights and rewards are
numbers or strings of digits; rewards are in atomic units (100,000,000 to a XEL).

| `event` | Fields |
|---------|--------|
| `block_found` | `hash`, `height`, `jobId`, `workerName`, `address` (the miner's) |
| `block_rejected` | `hash`, `height`, `jobId`, `workerName`, `error` (the node's reason) |
| `block_side` | `hash`, `height` |
| `block_final` | `hash`, `height`, `topoheight`, `status` (`main-chain`, `side` or `orphaned`), `reward`; several within 5 seconds: `blocks`, a list of those |
| `mining_paused` | `reason` (`syncing` or `unreachable`), `nodes` (each node's state); while syncing also `topoheight`, `networkTopoheight`, `peers` |
| `mining_resumed` | `node` (the one mining now), `nodes` |
| `node_switched` | `from`, `to`, `nodes` |
| `node_update` | `outcome`: `started` (`target`, `trigger`, `nodes`), `done` (also `switched`), `failed` (also `node`, `error`), or `copy_failed` (`from`, `to`, `error`) |
| `disk_low` | `level` (`low` or `critical`), `freeBytes`, `totalBytes`, `nodes`, `source` |
| `node_no_peers`, `node_peers_back` | `node`, `network`, `topoheight`, `peerlessSince` |
| `cluster_active`, `cluster_standby`, `cluster_fault` | `server`, `vip` (the shared address; left out on a public server) |
| `worker_offline` | `address`, `worker`, `lastShare` |
| `worker_unusual` | `address`, `worker`, `lastShare`, `daysOn` (days it was mining at this time), `days` (7, the days looked at) |
| `worker_online` | `address`, `worker` |

`ALERT_EVENTS` selects by kind: `node_peers` sends `node_no_peers` and `node_peers_back`, `cluster` the three `cluster_` events,
`mining_paused` also `mining_resumed` and `node_switched`, and `worker_offline` and `worker_unusual` also `worker_online`.

## Best share

The miner and worker pages show each address's **best share**: how close its best accepted share came to a block, as a percentage
of one (100% is a block), with a chart of the best share in each time bucket. Hover the title for "Closest to a block". It is worked
out from the hash Stratum checks anyway (the share's achieved difficulty, divided by the network difficulty when it was found), kept
per worker and minute, and shown for this round (since the address's last block), the last 24 hours and ever.

It is per address only: there is no figure across everyone's rigs, on the Overview or anywhere else. On a public server a visitor
sees an address's best share as they already see its hashrate and blocks, and nothing about IP addresses. It cannot be made up: the
value comes from the hash Stratum verified, and a share sent twice is caught as a duplicate.

A share that came close does not make the next block more likely; each hash is a fresh draw. Round effort and luck are the measure
of how mining is going.

It costs nothing measurable (see [System requirements](REQUIREMENTS.md)). To turn it off anyway, set `XELDASH_BEST_SHARE=off` and
restart: Stratum then neither works it out nor stores it, and the dashboard hides it.

## Metrics

Stratum can serve [Prometheus](https://prometheus.io/) metrics, for Grafana or whatever you already monitor with. They are
**off by default**: then nothing listens and nothing is counted, so a server that does not use them pays nothing. To turn them on,
add `metrics` to `COMPOSE_PROFILES` in `.env` (for example `COMPOSE_PROFILES=redundant,metrics`) and restart
(`xeldash start`). The profile starts a small forwarder that publishes Stratum's metrics port on this computer:
`http://127.0.0.1:9464/metrics`.

| Setting | Default | |
|---|---|---|
| `XELDASH_METRICS_BIND_IP` | `127.0.0.1` | Where the port is published. `0.0.0.0` lets another machine scrape it |
| `XELDASH_METRICS_PORT` | `9464` | The port on this computer |
| `XELDASH_METRICS_TOKEN` | empty | If set (16 characters or more), a scrape must send it: `Authorization: Bearer <token>` |
| `XELDASH_METRICS_PER_WORKER` | off | `on` adds shares and difficulty per worker, named by address and worker (not in public mode) |

What they show: miner connections and logged-in workers; shares by result (accepted, low difficulty, duplicate, stale) and the sum
of accepted difficulty, whose rate per second is the hashrate the shares prove; how long a share takes to check and record; blocks
found; the share queue, batch writes and the journal (`xeldash_store_*`, so a database outage shows); each node's state, height
and peers (`xeldash_node_*`); bans; and Stratum's own processor time, memory and event-loop delay.

**Nobody is named by default.** The metrics are totals: no address, worker name or IP address is a label. Per-worker metrics are
their own choice, for a home server, and are never served while public mode is on, whatever `.env` says.

**Public mode.** Keep the port on `127.0.0.1` and scrape it from this computer, or through an SSH tunnel. If you publish it
beyond this computer (`XELDASH_METRICS_BIND_IP`) on a public server, set `XELDASH_METRICS_TOKEN` as well: without it Stratum
refuses every scrape (HTTP 503) and says why in its log.

A Prometheus job for it:

```yaml
scrape_configs:
  - job_name: xeldash
    static_configs:
      - targets: ["127.0.0.1:9464"]
    # With XELDASH_METRICS_TOKEN:
    # authorization:
    #   credentials: <the token>
```

Useful queries: `rate(xeldash_share_difficulty_total[5m])` (hashrate), `rate(xeldash_shares_total[5m])` by `result`,
`histogram_quantile(0.99, rate(xeldash_share_seconds_bucket[5m]))` (the slowest answers), `xeldash_store_online` and
`xeldash_node_peers`.

Backups, restores and upgrades for a running xelDash stack. Commands run from the repository
directory. The PostgreSQL database holds everything xelDash knows about your miners, shares
and blocks. The daemon's chain data is in the `xelis-data` volume and can always be synced
again, so it needs no backup.

## Backups

### Automatic (optional service)

```sh
docker compose --profile backup up -d
```

This starts a `backup` service that runs `pg_dump` every `BACKUP_INTERVAL_HOURS` (24) and
keeps the newest `BACKUP_KEEP` (7) dumps in `./backups` (or `XELDASH_BACKUP_DIR`). Each dump is
written under a temporary name and only renamed when `pg_dump` succeeds, so a failed run
never replaces a good backup. Watch it with `docker compose logs backup`.

Copy the dumps somewhere off the machine. Backups on the same disk do not survive a disk
failure.

### From the dashboard or the launcher

On **Settings**, unlock with the admin token and press **Download a backup**: the browser saves a dump of the
statistics (miners, workers, blocks, events). Or, on the computer running xelDash:

```sh
xeldash backup                      # Windows: xeldash backup   Linux/macOS: ./xeldash.sh backup
```

which writes `xeldash-<time>.dump` into `./backups` (or `XELDASH_BACKUP_DIR`). A backup holds miner
addresses and IP addresses: keep it private. It does not include the blockchain (any node can download that
again) or any wallet, and it does not need the `backup` service.

### Manual

```sh
docker compose exec -T postgres pg_dump -U xeldash --format=custom xeldash > xeldash.dump
```

Use your `POSTGRES_USER` and `POSTGRES_DB` if you changed them.

### Size

Per-minute stats are kept 90 days and events (node changes, problems, failovers) a year (see `RETENTION_*`); shares are counted in
those stats, not stored one by one. Dumps stay small: the minute stats, plus the hourly stats and blocks, which grow slowly.

## Restore

The easy way, on the computer running xelDash (it asks you to type `yes`, because it replaces the current
statistics):

```sh
xeldash restore backups/xeldash-20261001T190812Z.dump
```

It stops Stratum and the API, restores the file, and starts everything again; `migrate` then applies any
migrations newer than the backup. By hand, it is the same steps. Restoring replaces the current database, so
stop the services that write to it first:

```sh
docker compose stop stratum api
docker compose cp xeldash.dump postgres:/tmp/restore.dump
docker compose exec -T postgres pg_restore -U xeldash -d xeldash --clean --if-exists /tmp/restore.dump
docker compose exec -T postgres rm /tmp/restore.dump
docker compose up -d
```

`migrate` runs on start and applies any migrations newer than the backup. To check a backup
without touching the live data, restore it into a scratch database instead:

```sh
docker compose exec -T postgres createdb -U xeldash restore_test
docker compose exec -T postgres pg_restore -U xeldash -d restore_test /tmp/restore.dump
docker compose exec -T postgres dropdb -U xeldash restore_test
```

## If the database goes down

Mining does not depend on the database. Tested by stopping PostgreSQL while a miner kept mining, and by
restarting the mining server in the middle of the outage:

- **Miners are not disconnected.** Rigs keep mining, and a block found during the outage is submitted to your
  node first, as always, so its reward is safe.
- **Nothing is lost.** The mining server keeps what it cannot record in a journal file (a JSON-lines file on its
  own Docker volume, `xeldash-spool`) and, as soon as the database answers, records it in order and with the
  original times: shares, blocks, events and bans. It checks every few seconds and needs no action from you.
  The journal survives a restart of the mining server and of the computer.
- **Logins keep working** for rigs seen before (the mining server remembers them, also on disk). A rig seen for
  the first time during an outage is created in the database when it returns.
- **The dashboard says so.** While the database is unreachable the dashboard shows "Dashboard offline: the
  database is not reachable. Mining continues." and catches up by itself.

Limits: the journal is capped at `STRATUM_JOURNAL_MAX_MB` (200 MB by default, many days of shares even for a large
farm). Past that, shares (statistics only) are dropped, never blocks or events. The
journal holds miner addresses and IP addresses; it is readable only by the mining server.

## Mining availability

The Health page shows how much of the last day, week or month your miners could be given work. A pause is a
time when no node was ready (syncing or not responding), recorded as `node_syncing` or `node_unreachable`
events and ended by `node_ready`; switching to your other node is not a pause. The count starts when xelDash
first recorded anything, and the few seconds a restart of the mining server takes are not counted.

## Updating xelDash

The dashboard shows a notice under the header when a newer xelDash has been released (it asks GitHub for the
project's published releases every six hours; `XELDASH_VERSION_CHECK=off` stops that). To update, run `xeldash update`
(`./xeldash.sh update`) in the xelDash folder. On a release install it finds the newest release on GitHub (a pre-release install follows pre-releases
too, a final release only final ones), downloads it, puts its files over the folder, and restarts on its images; on a development copy it runs
`git pull` and rebuilds. Your `.env`, backups and data are kept either way, and a failed download or a wrong archive changes nothing. Pre-releases do not trigger the notice.

Before it changes anything, `xeldash update` saves a backup of the statistics in the backups folder
(`xeldash-before-update-<time>.dump`, starting the database for it if xelDash is stopped), so an update that goes wrong can be undone
with `xeldash restore`. The newest three of these are kept; backups you make with `xeldash backup` are never removed. If the backup
cannot be taken, the update stops and nothing is changed; to update without one on purpose, run it with `XELDASH_UPDATE_SKIP_BACKUP=1`
set. A standby server or a front door has no database of its own, so there is nothing to save there. If you run a fork, set `XELDASH_UPDATE_REPO`
to `owner/name`. The running version is shown at the foot of every page.

## Which networks may connect

`XELDASH_ALLOWED_NETWORKS` in `.env` decides who may use Stratum, getwork and the dashboard:
`private` (default: home-network addresses and this computer), `tailscale`, `any`, or a comma
separated list such as `192.168.1.0/24`. Docker Desktop hides the real address of a connecting
computer, so on Windows and macOS this cannot block the internet by itself: run
`xeldash firewall` (Windows, asks for administrator rights) and never forward the ports on your
router. See [SECURITY.md](SECURITY.md). For a server open to everyone, see [Public mode](#public-mode).

The dashboard also checks the name it is opened under, so another website cannot point its own domain at your dashboard and read
it through your browser (DNS rebinding): it answers addresses (`http://192.168.1.20:8088`), names without a dot (`localhost`, the
computer's own name), local names (`.local`, `.lan`, `.home`, `.home.arpa`, `.internal`, `.localhost`, `.ts.net`), and
`XELDASH_CONNECT_HOST`, `XELDASH_PUBLIC_DOMAIN` and `XELDASH_PROXY_HOST`. Opened under any other name, it answers "421
Misdirected Request". To use another name of your own, add it to `XELDASH_ALLOWED_HOSTS` (comma separated; `*.example.org` for
every name under it; `any` turns the check off).

## HTTPS and a login

By default the dashboard has no login and no HTTPS, which is fine on a trusted LAN or when you
only open it on the xelDash machine itself. Otherwise, turn on the optional `proxy` service:
Caddy in front of the dashboard with HTTPS, a username and password, and a check that only
answers your chosen host name.

1. Make a password hash:
   `docker run --rm caddy:2.11-alpine caddy hash-password --plaintext 'your-password'`
2. Add to `.env`, keeping the single quotes around the hash (it contains `$` signs):

   ```sh
   COMPOSE_PROFILES=proxy
   XELDASH_PROXY_HOST=192.168.1.10      # the address or name you will type in the browser
   XELDASH_PROXY_USER=admin
   XELDASH_PROXY_PASSWORD_HASH='$2a$14$...'
   XELDASH_PROXY_BIND_IP=192.168.1.10   # this machine's LAN address
   ```

   Leave `XELDASH_WEB_BIND_IP` and `XELDASH_API_BIND_IP` at `127.0.0.1`, so the proxy is the
   only way in from the LAN.
3. `docker compose up -d`, then open `https://192.168.1.10:8443`.

The certificate comes from Caddy's own local certificate authority, so browsers warn until
you trust it. Copy it out with
`docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./xeldash-root.crt` and
install it as a trusted root on each device that opens the dashboard. It is kept in the
`proxy-data` volume, so this is needed once.

The proxy's login is separate from the admin token: after logging in, node changes still need
`XELDASH_ADMIN_TOKEN`. If the host name or the password hash is not set, the proxy refuses to start rather than run
without a login.

## Public mode

Public mode is for a server that anyone on the internet may mine on, solo, each to their own address: the dashboard is open to
everyone, like a pool's statistics page, but without a pool: every block pays the rig that found it, and the server holds no coins.
It is off by default; xelDash is otherwise meant for your own network.

With `XELDASH_PUBLIC_MODE=true`:

- **No IP addresses for visitors.** The API leaves every IP address out of what it sends to the public dashboard (workers' last
  address, bans), and the connection problems card is not shown. The operator's own dashboard (below) still has them.
- **Recent events are the operator's.** Node updates, backups, disk and cluster changes are not shown to visitors (the Overview
  and Health pages leave the list out); the operator's dashboard has them as usual.
- **Every miner must use its own address.** A login without an address is refused with a message saying so; the default address
  (`XELIS_DEFAULT_ADDRESS` or the one chosen on the setup page) is never used, so a misconfigured rig cannot mine for the server.
- **No node administration from the public site.** The public dashboard has no Nodes or setup pages, and its web server answers
  404 for node administration. Visitors get a **Mine here** page with the settings for each miner instead, and a Settings page
  with only how the dashboard looks and sounds for them (mode, colour theme, animations, block sound), kept in their browser.
- **Warnings, not refusals.** At startup the API logs a warning if `XELDASH_ALLOWED_NETWORKS` is still `private`, if
  `XELDASH_PUBLIC_DOMAIN` is empty (no built-in HTTPS), or if a default address is set (it is ignored). It starts anyway, for
  setups with their own reverse proxy.

Use a Linux server with Docker Engine. Docker Desktop (Windows, macOS) shows every computer from the internet as one address, so the
per-address connection limits and bans cannot work there (see [SECURITY.md](SECURITY.md)).

1. Point a domain at the server, for example `solo.example.org`.
2. In `.env`:

   ```sh
   XELDASH_PUBLIC_MODE=true
   COMPOSE_PROFILES=public,public-https
   XELDASH_PUBLIC_DOMAIN=solo.example.org   # HTTPS with a Let's Encrypt certificate (ports 80 and 443)
   XELDASH_CONNECT_HOST=solo.example.org    # what the Mine here page tells miners to connect to
   XELDASH_ALLOWED_NETWORKS=any
   XELDASH_STRATUM_BIND_IP=0.0.0.0
   ```

   Leave `XELDASH_WEB_BIND_IP` and `XELDASH_API_BIND_IP` at `127.0.0.1`: visitors come in through HTTPS only. The API warns at
   start when either is published wider.
3. `docker compose up -d`, then open `https://solo.example.org`.
4. Open to the internet only ports 80 and 443 (HTTPS), 3333 (Stratum), 8090 (getwork) and, if you set up Stratum TLS, 3334.

**Stratum TLS with the domain's certificate.** The `public-https` profile keeps a copy of its Let's Encrypt certificate for Stratum
(refreshed within five minutes of each renewal). To use it, add to `.env`:

```sh
STRATUM_TLS_ENABLED=true
STRATUM_TLS_CERT_FILE=/public-tls/cert.pem
STRATUM_TLS_KEY_FILE=/public-tls/key.pem
```

and `docker compose up -d`. On the first start the certificate is requested only after HTTPS is up, so the TLS port opens a minute
or so later (plain Stratum runs meanwhile, and Stratum's log says it is waiting). A renewed certificate is taken without a restart.
Miners then connect with `stratum+ssl://solo.example.org:3334` and need no certificate of their own.

**The operator's dashboard.** The `public` profile adds `admin-web`: the full dashboard, with Nodes, Settings, connection problems
and IP addresses, published on the server's loopback only (`127.0.0.1:8089`, `XELDASH_ADMIN_WEB_PORT` to change the port). From
your own computer, tunnel to it with `ssh -L 8089:127.0.0.1:8089 you@solo.example.org` and open `http://localhost:8089`. Node changes
there still need `XELDASH_ADMIN_TOKEN`.

**Still public, as on any pool:** miner addresses (they are on the chain anyway), worker names, hashrates and blocks. The Health page
names your nodes as written in `XELIS_RPC_URLS`, so use host names there rather than private IP addresses.

**Kept on the server:** the database still records miners' IP addresses, because the per-address limits and bans need them; they are
in backups too. Treat backups and the operator's dashboard as private.

**Alerts** go only where the operator sends them (set up on the operator's dashboard). On a public server there are no alerts about
individual workers ("a worker stops sending shares" would be about other people's rigs), whatever is selected, and cluster alerts
leave out the shared address. Block, mining, node, disk and cluster alerts work as usual; none of them ever contains a miner's IP
address.

**A redundancy cluster or a front door** works with public mode. The standby server and the front door learn from the main server
(over the cluster's own connection, with the cluster secret) that it is a public server, and keep that across restarts: their
Stratum refuses logins without an address, their status page leaves out the front door's addresses, and the standby's failover
alert leaves out the shared address, even if their own `.env` does not say `XELDASH_PUBLIC_MODE=true` (it may, too). Set
`XELDASH_ALLOWED_NETWORKS=any` in their `.env` as well: otherwise, after a failover, miners on the internet are turned away (they
warn about it in their log). Their page shows the main server's public dashboard while it is up, and the "mining continues" page
while it is away. The HTTPS of the `public-https` profile runs on the main server only, so while it is away visitors reach the
backup's page over plain HTTP only.

**Updates.** xelDash itself never updates by itself: only `xeldash update`, run on the server, changes its version (pinned by
`XELDASH_VERSION`), so update deliberately. XELIS node upgrades from the operator's dashboard are a deliberate action too.
**Automatic node updates** install new XELIS releases from GitHub by themselves, which trusts the XELIS release process (the
checksums come with the release; there is no signature to check). On a public server they run only while `.env` says
`XELIS_AUTO_UPDATE=true` (the Nodes page can switch them off, and back on only then; a choice saved there earlier does not count),
and a release waits at least 36 hours (`XELIS_AUTO_UPDATE_DELAY_HOURS` can make that longer, not shorter), time for the XELIS
community to notice a bad or tampered release. node-admin logs a warning at startup while they are on.

**Limits against overload and abuse.** Everything reachable from the internet is limited, and the XELIS node behind a public server
(possibly one the network depends on) can never be asked for more than a set amount, whatever miners or visitors do:

- **Calls to the node:** at most 100 a second from Stratum (`STRATUM_NODE_CALLS_PER_SECOND`); found blocks never wait. Rigs on the
  same address share their work, so a farm of hundreds of rigs on one address costs two calls per block. A checked address is
  remembered, so rigs reconnecting cost nothing. Over the limit, rigs keep their current work a little longer and new logins are
  told the server is busy. The dashboard's API asks the node at most once every 2 seconds per kind of question, and its public
  answers are each worked out at most once every 2 seconds, whatever the number of visitors.
- **Miners:** up to 1,000 connections per IP address (a farm behind one address fits; `STRATUM_MAX_CONNECTIONS_PER_IP`), 5,000
  in all (`STRATUM_MAX_CONNECTIONS`), and at most 32 different addresses per IP address (`STRATUM_MAX_ADDRESSES_PER_IP`): made-up
  addresses are what an attack on the node would need, and a connection that keeps trying them is banned like one sending bad shares.
  The usual per-connection message limits and bans apply as well. New connections from one IP address are limited to 20 a second
  after a burst of 1,000 (`STRATUM_CONNECTIONS_PER_IP_PER_SECOND`), so a whole farm can reconnect at once after a restart but a
  client reconnecting in a loop cannot. A rig logging in again within 5 minutes from the same address costs no database write.
- **Idle connections:** a connection that sends no share for 30 minutes is closed, and one that has never sent a share after 15
  (`STRATUM_IDLE_SECONDS`, 1800 on a public server, off otherwise; 0 turns it off), so logins that only sit there cannot hold the
  places real miners need. On every server, when the per-IP or total limit is reached, the connection quiet the longest that has
  never had a share accepted, and has been quiet for at least 2 minutes, is closed to make room for the new one; a connection that
  has mined is never closed for it, and nor is a rig still finding its first share.
- **Shares:** at most 300 shares checked a second per IP address (`STRATUM_SHARES_PER_IP_PER_SECOND`; a farm of 600 rigs sends about
  120). A share over the limit is answered "too many shares" without being checked. A difficulty a miner asks for in its password
  (`d=...`) is where its difficulty starts and the lowest it goes, but the server still raises it for a rig that sends shares too fast.
  Until an IP address has had a share accepted (in the current 5-minute window), its shares are checked at most 30 a minute across all
  its connections (`STRATUM_UNPROVEN_CHECKS_PER_MINUTE`): each check is a hash, and connections that never mine could otherwise keep
  the hash threads busy. A real rig's first share is normally accepted, which lifts the limit at once.
  On every server, a share for a job the connection was never given counts as invalid (towards a ban), and late shares are
  recorded at most 30 a minute per connection.
- **The database:** at most 1,000 new worker names an hour per IP address (`STRATUM_NEW_WORKERS_PER_IP_PER_HOUR`; rigs logging in
  again under their own names do not count). On every
  server, workers that never had a share accepted are deleted after a day unused (`RETENTION_UNUSED_WORKER_DAYS`; they come back
  when they log in), and every container's log is rotated (`XELDASH_LOG_MAX_SIZE`, `XELDASH_LOG_FILES`: 50 MB each by default).
- **Visitors of the dashboard:** per visitor, 10 API requests a second (bursts of 20), 6 CSV exports a minute, 20 open connections
  and 4 live-update connections; 200 API requests a second from all visitors together. Over a limit the answer is `429`. Slow or
  idle connections are closed soon (the HTTPS proxy and the web server both have short timeouts).
- **The official node fallback is never used** by a public server, so its miners' load cannot reach node.xelis.io.

The per-IP limits and bans need each miner's real address. Run a public server on Linux with Docker Engine and keep
`XELDASH_STRATUM_BIND_IP` an IPv4 address (`0.0.0.0`): Docker Desktop, and IPv6 connections that go through Docker's own proxy,
show every miner as Docker's gateway address, which cannot be limited without stopping everyone. Stratum's log warns about it
when it happens.

Leave a limit empty in `.env` to get its public default (`.env.example` explains each); a value you set is kept (a server
warns if `STRATUM_MAX_CONNECTIONS_PER_IP` is set below what a farm needs). Floods large enough to fill the server's network
connection itself are for the hosting provider to stop. `npm run load` with `LOAD_PUBLIC=1` measures a public server's limits
under load.

## Daemon settings

Every option of the XELIS daemon can be changed from the dashboard: open **Settings** in the
navigation and enter the admin token (`XELDASH_ADMIN_TOKEN`, see below). The options most
setups need come first, grouped by purpose (syncing, peers, disk and logs), each with a
plain-language explanation. **All daemon options** below them lists every option of the
installed daemon, from its own `--help`, so it always matches its version, with each
option's description, default and allowed values. Options that change how the node stores or
checks the chain are marked **Use with care**.

**Save and restart node** restarts the node with the new settings. Before they take effect,
the daemon's own parser checks them; a mistake is rejected with the daemon's error message
and the node keeps its previous settings. If the node exits within 30 seconds of starting
with new settings, the previous ones are put back automatically. The result of the last
change is shown on the page. Some mistakes do not stop the daemon (for example, an invalid
P2P bind address leaves the node running without P2P), so check the Health page after a
change.

xelDash sets `--network`, `--rpc-bind-address` and `--dir-path` itself (from `.env`), and
depends on RPC being on, so those cannot be changed here. Settings are saved on the node's
data volume (`.xeldash/daemon-args`) and survive restarts and upgrades. With two nodes,
pick the node at the top of the section; change one node at a time so the other keeps mining.

### Pruning old blocks (saving disk space)

**Settings, Disk and logs, Prune old blocks** makes the node delete old blocks and keep only the number you give. On mainnet
today it reduces a node's data from about 10.6 GB to about 6 GB, whatever number you choose between a thousand and a hundred
thousand, so keep a generous one: **we recommend 120,000 blocks, about seven days**. How it behaves, measured on a copy of the
mainnet chain (details in [System requirements](REQUIREMENTS.md#pruning-old-blocks-what-it-saves)):

1. Set the number and apply; the node restarts with pruning on.
2. The node prunes only when the chain height is an exact multiple of your number. With 120,000 the first prune can be up to
   about a week away, and after that it prunes about once a week (each prune is about 11 minutes of work, with roughly 1.6 GB of
   memory and up to 2 GB of extra space while it runs). The node's log says "Auto pruning chain until topoheight ..." and
   "Auto pruning done". To watch it happen quickly, try 1,000 first.
3. **Restart the node once more (Nodes page) after it has pruned.** The space is given back only then.

Pruning cannot be undone without a new snapshot (Nodes page, Snapshots), and a pruned node cannot help other nodes sync old
blocks. Mining and the dashboard work as normal. One difference: a block your miners found that the node has already pruned
away is shown as pending rather than orphaned, because a pruned node cannot say what became of it; keeping about a week of
blocks makes that practically impossible unless xelDash was stopped for longer.

### Trusted peers

**Trusted peers**, at the top of the daemon settings, lists nodes you trust: your other XELIS
nodes, or a friend's. Enter one `IP:port` per line (for example `203.0.113.5:2125`); the
daemon does not accept host names. Choose how the node uses them:

- **Priority** (`--priority-nodes`): connect to these first, and still find other peers as
  usual. The safe choice.
- **Exclusive** (`--exclusive-nodes`): only ever talk to these peers; seed nodes and other
  peers are refused. If they all go down, the node stops syncing, and mining pauses unless
  another node can take over.

Like every daemon setting, the list applies on **Save and restart node**.

## Snapshots

A snapshot is a zip of a node's database. Starting from one takes minutes instead of syncing
the chain from the network. The XELIS team publishes a mainnet snapshot every day at
`https://node.xelis.io/files/mainnet.zip` (about 9 GB) with a SHA-256 checksum next to it.
Using a snapshot means trusting whoever made it instead of verifying the chain yourself.

Snapshot actions replace the node's data and settings change how it runs, so both need an
admin token (see [SECURITY.md](SECURITY.md): the token is full control of the node). Set a long random
`XELDASH_ADMIN_TOKEN` in `.env` (for example the output of `openssl rand -hex 24`) and restart
xelDash. Without it, the dashboard only shows status.

### From the dashboard

Open the **Nodes** page, pick the node, and enter the admin token. Then either:

- drop a snapshot `.zip` onto the page: the official `mainnet.zip` downloaded elsewhere, or a
  zip of another node's `<network>` data directory; or
- click **Download and check** to fetch today's official mainnet snapshot. A stopped download
  resumes; if the XELIS team publishes a newer file meanwhile, it starts over.

xelDash checks the file (the official checksum when it applies, the zip's own CRCs, safe
paths, and a RocksDB database inside), unpacks it next to the node's data, and shows
**Ready to switch**. Nothing changes until you click **Restart node now**: the node stops,
the current data is moved to `<network>.previous`, the snapshot takes its place, and the node
starts again. Delete the previous data from the same page once the node runs well.

Disk space: the zip plus its unpacked copy (about 2 × 9 GB for mainnet), plus the previous
data until you delete it. The page shows free space and refuses to start without enough.

### Automatic on first start

With `XELIS_SNAPSHOT_AUTO=true` on mainnet, a node with no chain data waits while the official
snapshot downloads and unpacks, then starts on it. If the download fails, the node syncs from
the network as usual. The dashboard shows the progress. `XELIS_SNAPSHOT_URL` and
`XELIS_SNAPSHOT_CHECKSUM_URL` point at another source (then used on any network).

**The trade-off.** The snapshot start is much faster, but it needs about twice the chain's size in free space while it
runs (about 21 GB at the peak, because the download and the unpacked chain exist together for a while). Without it
(`XELIS_SNAPSHOT_AUTO=false`) the node syncs from other nodes: slower, often by a wide margin, but it uses less space,
since there is no download and no second copy. The launcher compares the free space with these needs before the first
start and offers the slower start when only that fits (`XELDASH_SKIP_DISK_CHECK=1` turns the check off).

Automatic snapshots are for `daemon` only. A second node is quickest to start with **Copy from
daemon** (see [Redundant nodes](#redundant-nodes)), or it can take a snapshot from the same
page.

## Upgrading xelDash

1. Back up the database.
2. Pull the new version and read the changelog for anything marked as breaking.
3. A release: `xeldash update` does all of this (it also keeps your `.env`). By hand: set `XELDASH_VERSION` (for example `0.1.0`) in `.env`, then run
   `docker compose pull && docker compose up -d`. A development copy: `docker compose up -d --build`. Images are at
   `ghcr.io/pitanu/xeldash/{api,stratum,web,node-admin,daemon}` (`XELDASH_IMAGE_REGISTRY` overrides the
   prefix), for amd64 and arm64.

**What an update restarts.** The launcher (`xeldash update`, `xeldash start`) restarts only the services whose image or settings
changed. With two nodes running, it updates everything else first and then the nodes one at a time, `daemon2` before `daemon`, and
restarts the second only once the first has caught up with it again (it waits up to ten minutes, and otherwise leaves the second on
its old version and says so), so there is always a node to give work and mining does not pause. What remains is Stratum's own
restart when it changed: rigs reconnect within a few seconds (with a front door or a second server, they mine elsewhere meanwhile).
With one node, a release update restarts it, and mining pauses until it is back and caught up. Running `docker compose up -d`
by hand restarts every changed service at once, both nodes included; on Docker Desktop, set `BUILDX_NO_DEFAULT_ATTESTATIONS=1`
when building by hand, or every build looks changed.

The one-shot `migrate` service applies new migrations before the API and Stratum start.
Migrations only move forward. To go back to an older version, restore the backup you took in
step 1 as well as checking out the older code.

Miners reconnect by themselves after the Stratum restart. Shares sent during the restart are
lost, which only affects the statistics.

## Upgrading the XELIS daemon

### From the dashboard

**Nodes → Daemon version** lists each node's version and the latest XELIS
release, and switches nodes to a release (or back to the image's own daemon) one at a time:
every other node first, `daemon` last. Each node restarts on the new version and must catch
up with the network before the next one starts, so with two nodes mining never stops. The
progress shows step by step, and the switch carries on if the page is closed.

- Releases come from the XELIS project's GitHub releases only. Each download must match the
  release's `checksums.txt` and GitHub's own digest for the file, and `xelis_daemon` inside
  it the archive's `checksums.txt`. The release signing key is not published yet, so the
  PGP signature is not checked; this is the same trust as the official Docker images.
- A node that does not stay up on the new version for 30 seconds is switched back
  automatically, and the switch stops before touching the next node. (Tested: 1.25.0 on a
  database written by 1.21.3 exits with "Invalid size" and was switched back.)
- A downloaded release takes precedence over the image. After raising `XELIS_DAEMON_IMAGE`,
  choose **Back to the image's version** to run the image's daemon again.
- Going back to an older version may fail if the newer one changed the database. Keep a
  snapshot or the other node's copy at hand.

**Switch at a block height**, for network upgrades (hard forks) announced as "version X
required from height H": choose the version and a height under **Daemon version**. The
release is downloaded and checked on every node right away, so a problem shows long before
the height. When the chain reaches the height (checked every 10 seconds), the nodes switch
one at a time as above. Pick a height a few hundred blocks before the activation height:
with 5-second blocks, 100 blocks is about 8 minutes, and switching two nodes takes a few.
The schedule is kept on the config volume, so restarts do not lose it, and it can be
cancelled until it starts. Automatic updates wait while a switch is scheduled.

**Automatic updates** (optional, off by default) do the same by themselves: with two local
nodes, switch them on under **Daemon version** (or `XELIS_AUTO_UPDATE=true` in `.env` for
the first start). Every 15 minutes xelDash compares the nodes with the latest release; a
release is installed once it has been out for `XELIS_AUTO_UPDATE_DELAY_HOURS` (24 by
default), only when every node runs and is in sync, and only upward. A version that fails on
a node is not tried again until a newer release is out. With one node they cannot be turned
on, since mining would stop during each update. Keep an eye on hard-fork announcements
anyway: a mandatory release may need installing sooner than the delay allows. On a public server they run only while `.env`
says `XELIS_AUTO_UPDATE=true`, and wait at least 36 hours (see [Public mode](#public-mode)).

### By image

The daemon release is pinned with `XELIS_DAEMON_IMAGE` (see
[docker/daemon/README.md](../docker/daemon/README.md) for why the image is re-based):

1. Build the new tag and check that it starts:
   `XELIS_DAEMON_IMAGE=xelis/daemon:<tag> docker compose build daemon`, then
   `docker compose run --rm daemon --version`.
2. Run the devnet check in [DEVNET.md](DEVNET.md) against it.
3. Set the tag in `.env` and run `docker compose up -d --build daemon`.

With a single node, Stratum pauses work and disconnects miners while the new daemon starts
and catches up, and resumes on its own once it is in sync. The Health page shows "Paused"
meanwhile. To upgrade without stopping mining, run two nodes (next section).

## Redundancy: two servers

Two computers can share one address, so that mining carries on if one of them loses power, is switched off, or
restarts to update. Your miners connect to the shared address only, and it is always held by a server that can
mine. **Both servers must run Linux with Docker Engine** (a Raspberry Pi is fine) on the same home network.
Docker Desktop on Windows and macOS runs containers in a virtual machine that cannot hold an address on your
network, so a Windows or macOS computer can be your single server but not part of a cluster.

| | Main server | Second server (standby) |
|---|---|---|
| Runs | everything: database, API, dashboard, node, Stratum | its own node, Stratum and the address manager; no database, no dashboard of its own |
| Records | the one database | nothing locally: it sends what it records to the main server |
| Dashboard | the real one | the main server's, or an "offline" page |

**Set up**

1. On your existing server: `./xeldash.sh cluster setup`. It suggests an unused address on your network for sharing,
   starts the address manager, and prints a code.
2. On the second Linux computer (xelDash downloaded, nothing else needed): `./xeldash.sh cluster join CODE`. It copies
   the network and mining address from the code, starts its own node (the first time it downloads the blockchain,
   about 10 GB), and stands by.
3. Point **every miner at the shared address** (port 3333), once. That is the only address any miner needs.

`./xeldash.sh cluster status` shows which server holds the address, and the Health page has a Redundancy card.

**What happens when a server stops.** The other server claims the shared address within a few seconds (about 3 to 8 in
tests) and your rigs reconnect to it by themselves, with rewards going to the same wallet address as before. A server
whose node is not ready, or whose mining server is down, gives the address up in the same way even while powered on.
A server that comes back stands by; it does not take the address back, so there is no second interruption.

**While the main server is away**, the second server keeps mining and keeps a journal file of everything it
records (shares, blocks, events), and sends it to the main server when it returns; nothing is lost and the
statistics catch up. Its page at its own address (or the shared address) shows a "Dashboard offline" notice saying
mining continues, with how many rigs are connected and how many records are waiting. When the main server is back
that page shows its dashboard again by itself. The standby has no database, so **no statistics are available while the main
server is down**; they resume when it returns.

**Alerts.** The standby keeps a copy of the main server's alert settings (it asks for them every minute, with the cluster
secret). If it takes over the shared address while the main server cannot be reached, it sends the failover alert itself
(type "A server takes over the shared address"): "Failover: the main server is not answering, so the standby server now holds
the shared address", or "the standby cannot mine and the main server is not answering". When the main server is reachable the
standby stays quiet, because the main server reports its own changes (that it cannot mine and gave the address up, or that it is
back and standing by); so you hear about each failover once. Only the failover and "cannot mine" alerts are sent from the standby:
block alerts and the rest need the database and resume with the main server.

**Limits to know**

- Both servers need to reach each other over the network; the standby sends its records to the main server's
  dashboard address, so keep the main server's address stable (give it a fixed address in your router).
- The standby follows the main server's default wallet address (the one for rigs that send none): it asks for it every
  30 seconds and keeps a copy on its own volume, so changing it on the dashboard needs nothing on the second server. If the
  main server has never been reachable since the standby started, it uses the address from the cluster code.
- This is protection against one server failing, not against both, or against the router or the network.
- Each server runs and syncs its own node. The standby's node needs the same disk space as the main one.
- Remove a cluster with `./xeldash.sh cluster off` on the main server, and delete the standby.
- A Windows computer as the main server cannot share an address with a Linux computer. For that, use the front door below.

## Front door: a box miners connect to

For a main server on **Windows or macOS** (Docker Desktop), or any main server you would rather not move miners away from, the
backup is a small **Linux box that miners connect to instead**. It forwards every miner to the main server while that can mine,
and to its own Stratum when it cannot, so the main server can lose power, be switched off or restart for an update without
the miners noticing more than a reconnect. Unlike the shared address above, nothing needs to hold an address on your network,
so the main server can be a Windows PC.

| | Main server (any computer) | Front door (Linux with Docker Engine) |
|---|---|---|
| Runs | everything, as usual | HAProxy, its own node and Stratum, a status page; no database |
| Miners connect to | nothing (they use the front door) | **this one**, port 3333 (and 8090 for getwork) |
| Records | the one database | nothing locally: it sends what it records to the main server, and keeps a journal file while that is away |

**Set up**

1. On the main server: `./xeldash.sh frontdoor setup` (Windows: `.\xeldash.cmd frontdoor setup`). It asks for the Linux box's
   address on your network, lets the main server's Stratum believe that box, restarts, and prints a code.
2. On the Linux box (xelDash downloaded, nothing else needed): `./xeldash.sh frontdoor join CODE`. It starts its own node (the
   first time it downloads the blockchain, about 10 GB) and HAProxy.
3. Point **every miner at the front door** (its address, port 3333), once. Miners should not connect to the main server directly
   any more: it now expects every connection to arrive through the front door, and refuses others.

`./xeldash.sh frontdoor status` on either computer says which side miners are on, and the main server's Health page has a Front door card with the number of rigs that arrive through it (plain Stratum port) and a warning for rigs connected straight to the main server.

**How it decides.** HAProxy asks the main server every 2 seconds whether it can mine (the same check the address manager uses: its
node is ready and Stratum answers). After 3 failed answers (about 6 seconds) it sends new connections to the front door's own
Stratum and closes the connections still on the main server, so the miners reconnect there; after 2 good answers they go back to
the main server (the miners reconnect again, once). In devnet tests a stopped main Stratum was replaced within about 10 seconds. Rewards go to the same wallet address on both sides, and the front door keeps its own copy of the main
server's default address, as the standby of the cluster does. Alerts, the offline page and the journal work as described under
"Redundancy: two servers".

**Limits to know**

- It protects against the **main server** stopping, **not against the front door itself** stopping: if that box loses power, the
  miners have nowhere to connect.
- The miners' addresses are passed on with the PROXY protocol, so per-address limits and bans keep working. Only the front door
  can send it (see [Security](SECURITY.md)). Connect miners through the front door only.
- Encrypted Stratum (port 3334) is optional: put `cert.pem` and `key.pem` in `docker/stratum-tls` on the front door (the same as
  [on a single server](../docker/stratum-tls/README.md)), set `STRATUM_TLS_ENABLED=true` in its `.env` and run `docker compose up -d`.
  The front door decrypts it, so miners always see the one certificate whichever server they end up on; the step from the front
  door to the main server is plain, on your network, like the rest of the front door traffic.
- The Linux box must be Linux with Docker Engine, not Docker Desktop, or it cannot see the miners' real addresses.
- Remove it with `./xeldash.sh frontdoor off` on the main server, then point the miners back at the main server and delete
  the front door.
- Not yet run on real hardware: see the [community testing list](COMMUNITY-TESTING.md).

## Redundant nodes

Stratum can mine through several XELIS nodes. It uses the first node in the list that is in
sync, and switches to the next one within seconds if that node stops responding, starts
syncing, or falls more than 16 topoheights behind another of your nodes. Miners get fresh
work from the new node and keep mining; nobody is disconnected. When the preferred node is
ready again, mining moves back to it. A block found on a job from a node that just went away
is submitted through another node. Mining only pauses when no node is usable.

### A second node in this stack

Add to `.env`:

```sh
COMPOSE_PROFILES=redundant
XELIS_RPC_URLS=http://daemon:8080/json_rpc,http://daemon2:8080/json_rpc
```

then `docker compose up -d`. The `daemon2` service has its own chain data (the
`xelis-data-2` volume) and connects to `daemon` directly as a priority peer. It needs the
chain before it can take over; the Health page lists both nodes and marks the one in use.
Two nodes on one machine protect against node restarts, upgrades and crashes, not against the
machine failing.

**Start daemon2 from daemon's chain data** instead of syncing from scratch (days on
mainnet): on the **Nodes** page, pick `daemon2` and use **Copy from daemon**.
`daemon` stops while its database is copied (about a minute per 10 GB) and starts again;
mining continues on `daemon2` or through the official node fallback meanwhile. `daemon2`
then restarts on the copy and keeps its previous data as a backup, which **Previous chain
data** on the same page deletes. The same works the other way round.

The same page restarts, stops and starts each node and handles each node's snapshots; the
**Settings** page has a node picker for each node's daemon settings. A node stopped there
stays stopped, across restarts of the stack, until it is started again.

By hand, the copy is (volume names start with the Compose project name, the folder name,
`xeldash` by default; `mainnet` is the network):

```sh
docker compose stop daemon
docker volume create xeldash_xelis-data-2
docker run --rm -v xeldash_xelis-data:/from:ro -v xeldash_xelis-data-2:/to busybox   cp -a /from/mainnet /to/
docker compose start daemon
docker compose up -d
```

daemon2 then catches up the few blocks it missed within seconds. (On mainnet, about 10 GB
copied in about a minute on an SSD.)

### A node on another machine

Any XELIS node whose RPC Stratum can reach works. Add its URL to `XELIS_RPC_URLS` in
priority order, for example
`XELIS_RPC_URLS=http://daemon:8080/json_rpc,http://192.168.1.20:8080/json_rpc`. Its RPC must
be reachable from this machine but should stay on your LAN: never expose daemon RPC to the
internet.

### Upgrading without stopping mining

Upgrade one node at a time and let it catch up before touching the next:

1. Set `XELIS_DAEMON2_IMAGE=xelis/daemon:<new tag>` in `.env` and run
   `docker compose up -d --build daemon2`.
2. Wait until the Health page shows `daemon2` in sync.
3. Set `XELIS_DAEMON_IMAGE` to the same tag (and remove `XELIS_DAEMON2_IMAGE`, which follows
   it by default), then `docker compose up -d --build daemon`. If the restart takes more than
   about 10 seconds (a new image, a database upgrade), mining switches to `daemon2` and back
   once `daemon` is in sync. A quicker restart may not switch at all: miners keep their
   current job for those few seconds.

Tested on mainnet with Rigel mining: stopping `daemon` moved mining to `daemon2` within
seconds and back when it returned, and replacing each node in turn, with no rejected shares
and no pause.

Switches are recorded as events and, with alerts on, reported as `mining_paused` alerts.
The Health page marks a node **Update available** when it runs an older version than the
latest XELIS release (checked on GitHub every 6 hours; `XELDASH_VERSION_CHECK=off` stops it).

**Hard forks:** XELIS announces network upgrades with a minimum daemon version and an
activation height (for example, the V7 fork at height 6,909,122 required 1.24.0). Upgrade
before the activation height, now or with **Switch at a block height**. A daemon that is too old stops following the network, and
blocks found on it are worthless.

### Official node fallback

On mainnet and testnet, Stratum can also mine through the XELIS team's public node
(`https://node.xelis.io/json_rpc` on mainnet) while none of your own nodes can issue work:
during the first sync, an upgrade, or an outage. Switch it on under **Official node fallback**
on the **Settings** page (admin token needed), or set `XELIS_OFFICIAL_FALLBACK=true` in `.env` for
the first start; after that, the dashboard switch wins. The change takes effect within a few
seconds, without a restart.

Your own nodes always come first: the public node is only used while none of them qualifies,
and mining moves back as soon as one is in sync. It shows on the Health page as
**Official fallback**, and switches are recorded like any other node switch.

Trade-offs while it is in use: block templates come from a server you do not run, over the
internet, so a few more shares may arrive after a new block. Block rewards still go to each
miner's address; the key they are paid to is looked up on your own node whenever it answers,
even while it syncs. `XELIS_OFFICIAL_NODE_URL` points the fallback at another public node.

## Algorithm changes

xelDash validates shares with the XELIS Hash V3 addon and only issues `xel/v3` work. If a
future fork changes the PoW algorithm, the daemon's templates change algorithm at the
activation height. Stratum then cannot issue work: its log shows "Daemon returned unsupported
template algorithm" and miners get "Request failed" at login, until xelDash is updated with
the new hash. Such a fork needs
a xelDash release with the updated addon before the activation height, alongside the daemon
upgrade.
