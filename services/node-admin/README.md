# Node admin service

Node administration for the dashboard (the **Nodes** page and **Settings**), for each
local node: `daemon`, and `daemon2` once the `redundant` profile has started it. It manages a
node only through files on that node's data volume (`<data>/.xeldash`), which the node's
supervisor (`docker/daemon/entrypoint.sh`) acts on: extra daemon flags, restart and stop
markers, staged snapshots, and downloaded release binaries. Nothing here can control Docker.

It also reads and writes the shared config volume (the fallback switch, mining address and alert settings) and watches
the role file the cluster's address manager writes there. On a standby server it runs without a database and only logs
the events it would record.

It is not published to the host: the dashboard's nginx proxies `/api/v1/node/` to it,
streaming uploads without buffering. Reads are open; every change needs
`XELDASH_ADMIN_TOKEN` in the `X-Admin-Token` header. Node-scoped endpoints take `?node=`
(`daemon` by default).

| Endpoint | Does |
|----------|------|
| `GET /nodes` | Each node: running or stopped, chain data, the version it runs and where from, last version switch, and the current switch's progress |
| `POST /control/restart`, `/control/stop`, `/control/start` | Restart a node, or stop it (it stays stopped, across restarts, until started) |
| `POST /copy?node=&from=` | Copy one node's chain data into the other (the source stops during the copy) |
| `GET /settings` | Daemon options (parsed from its `--help`), current and pending values, last outcome |
| `PUT /settings` | Validate and save settings for the next restart (peer lists are `IP:port`) |
| `POST /settings/apply`, `/settings/discard` | Restart the node to apply them, or drop them |
| `GET /snapshot/status` | Current operation and progress, chain data, disk space, official snapshot info |
| `PUT /snapshot/upload` | Receive a zip (streamed, hashed), then check and unpack it |
| `POST /snapshot/download` | Download the official snapshot (resumable), verify the checksum, unpack |
| `POST /snapshot/restart` | Ask the node to restart onto the staged snapshot |
| `POST /snapshot/cancel`, `/discard-staged`, `/discard-previous` | Stop, or free disk space |
| `GET /releases` | Official XELIS releases with a build for this machine |
| `POST /upgrade` | Switch nodes to a release (or `image`), one at a time, the usual mining node last |
| `GET/POST/DELETE /scheduled-upgrade` | A switch at a block height, for network upgrades |
| `GET/PUT /auto-update` | Optional automatic updates (off by default, two local nodes needed) |
| `GET/PUT /fallback` | The official node fallback switch, read by Stratum and the API |
| `GET /disk` | Free space on the disk(s) the nodes use, and the warning level (`XELDASH_DISK_WARN_GB`); a `disk_low` event is recorded when it runs low. Under Docker Desktop it reads the computer's drive through a read-only mount (`docker/hostdisk`), since the virtual disk reports its own size |
| `GET /cluster` | This server's role in a two-server cluster (`MASTER`, `BACKUP`, `FAULT`), from the address manager's role file; changes are recorded as events, which become alerts. `{ "configured": false }` without a cluster |
| `GET /backup` | Admin token. Streams a `pg_dump` of the statistics database as a download (the same file `xeldash backup` writes) |
| `GET/PUT /alerts`, `POST /alerts/test` | Where alerts go (Discord, Telegram, webhook) and which ones, kept in `alerts.json` on the config volume, which the API watches. Secrets are shown only by their last four characters; the test sends one message to each place and says which arrived |
| `GET/PUT /mining-address` | The address xelDash mines to when a miner sends none: checked by your node (network, typos, not integrated), kept on the config volume, read by Stratum |
| `POST /token/check` | Check an admin token when it is entered |

One heavy disk operation (download, upload, unpack or copy) runs at a time across all nodes.

Snapshots are checked before anything is staged: the official checksum (downloads; uploads
are compared when it applies), the zip's CRCs, no absolute or `..` paths, no links or special
files, exactly one RocksDB database, and enough disk space. Releases must match their
`checksums.txt`, GitHub's digest and the archive's inner checksum list. See
[docs/OPERATIONS.md](../../docs/OPERATIONS.md) and [docs/SECURITY.md](../../docs/SECURITY.md).
