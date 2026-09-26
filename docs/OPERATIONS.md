# Operations

## Alerts

The API can send alerts to Discord, Telegram and/or any JSON webhook. Set one or more in
`.env` and restart the API (`docker compose up -d api`):

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
- `block_final`: a block reached the stable height, as main chain, side or orphaned, with its
  reward. Blocks that become final within 5 seconds of each other arrive as one summary.
- `mining_paused`: Stratum paused work because no node is usable, when it resumes, and
  when mining switches to another node.
- `worker_offline`: a worker stopped sending accepted shares, and when it comes back. Only
  workers with shares in the last 24 hours are watched. After an API restart the first check
  only records state, so workers that were already offline are not announced again.

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

## Snapshots

A snapshot is a zip of a node's database. Starting from one takes minutes instead of syncing
the chain from the network. The XELIS team publishes a mainnet snapshot every day at
`https://node.xelis.io/files/mainnet.zip` (about 9 GB) with a SHA-256 checksum next to it.
Using a snapshot means trusting whoever made it instead of verifying the chain yourself.

Snapshot actions replace the node's data, so they need an admin token. Set a long random
`XELDASH_ADMIN_TOKEN` in `.env` (for example the output of `openssl rand -hex 24`) and restart
xelDash. Without it, the dashboard only shows status.

### From the dashboard

Open **Health → Snapshots and chain data** and enter the admin token. Then either:

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

With two nodes, only `daemon` uses snapshots; `daemon2` syncs from it over the local network.

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
`xelis-data-2` volume) and connects to `daemon` directly. It needs to sync the chain before
it can take over; the Health page lists both nodes and marks the one in use. Two nodes on
one machine protect against node restarts, upgrades and crashes, not against the machine
failing.

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
   it by default), then `docker compose up -d --build daemon`. Mining switches to `daemon2`
   while `daemon` restarts, and back once it is in sync.

Switches are recorded as events and, with alerts on, reported as `mining_paused` alerts.

**Hard forks:** XELIS announces network upgrades with a minimum daemon version and an
activation height (for example, the V7 fork at height 6,909,122 required 1.24.0). Upgrade
before the activation height. A daemon that is too old stops following the network, and
blocks found on it are worthless.

## Algorithm changes

xelDash validates shares with the XELIS Hash V3 addon and only issues `xel/v3` work. If a
future fork changes the PoW algorithm, the daemon's templates change algorithm at the
activation height. Stratum then cannot issue work: its log shows "Daemon returned unsupported
template algorithm" and miners get "Request failed" at login, until xelDash is updated with
the new hash. Such a fork needs
a xelDash release with the updated addon before the activation height, alongside the daemon
upgrade.
