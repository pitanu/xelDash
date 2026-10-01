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
| `ALERT_WEBHOOK_URL` | Receives `{ event, text, ...details, sentAt }` as a JSON POST |
| `ALERT_EVENTS` | Which alerts to send (default: all, see below) |
| `ALERT_WORKER_OFFLINE_MINUTES` | Minutes without an accepted share before a worker counts as offline (10) |
| `ALERT_DASHBOARD_URL` | Adds dashboard links, for example `http://192.168.1.10:8088` |

Events:

- `block_found`: a block candidate was accepted by the node.
- `block_rejected`: the node refused a block candidate.
- `disk_low`: the disk the nodes use has less free space than `XELDASH_DISK_WARN_GB` (default 20 GB), or
  less than 5 GB. A full disk stops a node and can force a long resync. The dashboard shows the same warning
  on the Overview and Health pages. Checked every 10 minutes, repeated at most once a day.
- `block_side`: one of your blocks lost the race for its height and is a side block for now. Side
  blocks are paid too, with a reduced reward, once final; this comes well before that.
- `block_final`: a block reached the stable height, as main chain, side or orphaned, with its
  reward. Blocks that become final within 5 seconds of each other arrive as one summary.
- `mining_paused`: Stratum paused work because no node is usable, when it resumes, and
  when mining switches to another node.
- `worker_offline`: a worker stopped sending accepted shares, and when it comes back. Only
  workers with shares in the last 24 hours are watched. After an API restart the first check
  only records state, so workers that were already offline are not announced again.
- `node_update`: a node version switch started, finished or failed (including automatic and
  scheduled ones), and a failed chain copy.

Node stops, starts, restarts and chain copies also show under Recent events on the
dashboard.

Each channel sends at most one message per second. If alerts pile up, extra ones are skipped
and the next message says how many.

The API log lists the enabled channels at startup ("Alerts enabled: ..."). Failed deliveries
are logged and not retried.

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

### Manual

```sh
docker compose exec -T postgres pg_dump -U xeldash --format=custom xeldash > xeldash.dump
```

Use your `POSTGRES_USER` and `POSTGRES_DB` if you changed them.

### Size

Raw shares are kept 7 days and per-minute stats 90 days (see `RETENTION_*`). Dumps stay
small: roughly 15 MB of raw shares per active worker at steady state, plus the hourly stats
and blocks, which grow slowly.

## Restore

Restoring replaces the current database. Stop the services that write to it first:

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

## Which networks may connect

`XELDASH_ALLOWED_NETWORKS` in `.env` decides who may use Stratum, getwork and the dashboard:
`private` (default: home-network addresses and this computer), `tailscale`, `any`, or a comma
separated list such as `192.168.1.0/24`. Docker Desktop hides the real address of a connecting
computer, so on Windows and macOS this cannot block the internet by itself: run
`xeldash firewall` (Windows, asks for administrator rights) and never forward the ports on your
router. See [SECURITY.md](SECURITY.md).

## HTTPS and a login

By default the dashboard has no login and no HTTPS, which is fine on a trusted LAN or when you
only open it on the xelDash machine itself. Otherwise, turn on the optional `proxy` service:
Caddy in front of the dashboard with HTTPS, a username and password, and a check that only
answers your chosen host name (which also blocks DNS-rebinding attacks).

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
`XELDASH_ADMIN_TOKEN`. If both lines are not set, the proxy refuses to start rather than run
without a login.

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

Automatic snapshots are for `daemon` only. A second node is quickest to start with **Copy from
daemon** (see [Redundant nodes](#redundant-nodes)), or it can take a snapshot from the same
page.

## Upgrading xelDash

1. Back up the database.
2. Pull the new version and read the changelog for anything marked as breaking.
3. Rebuild and restart: `docker compose up -d --build`. To run a published release instead of
   building, set `XELDASH_VERSION` (for example `0.1.0`) in `.env`, then run
   `docker compose pull && docker compose up -d`. Images are at
   `ghcr.io/pitanu/xeldash/{api,stratum,web,daemon}` (`XELDASH_IMAGE_REGISTRY` overrides the
   prefix), for amd64 and arm64.

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
anyway: a mandatory release may need installing sooner than the delay allows.

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
