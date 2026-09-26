# Node admin service

Node administration for the dashboard's **Node** page: the XELIS daemon's settings, and
snapshots (zips of a node's RocksDB database) downloaded, received, verified and unpacked
onto the node's data volume. The node
container's entrypoint (`docker/daemon/entrypoint.sh`) swaps a staged snapshot in when it
restarts; the two only share marker files under `<data>/.xeldash`.

It is not published to the host: the dashboard's nginx proxies `/api/v1/node/` to it,
streaming uploads without buffering. Every action needs `XELDASH_ADMIN_TOKEN`.

| Endpoint | Does |
|----------|------|
| `GET /settings` | Daemon options (parsed from its `--help`), current and pending values, last outcome |
| `PUT /settings` | Validate and save settings for the next restart |
| `POST /settings/apply`, `/settings/discard` | Restart the node to apply them, or drop them |
| `GET /snapshot/status` | Current operation and progress, chain data, disk space, official snapshot info |
| `PUT /snapshot/upload` | Receive a zip (streamed, hashed), then check and unpack it |
| `POST /snapshot/download` | Download the official snapshot (resumable), verify the checksum, unpack |
| `POST /snapshot/restart` | Ask the node to restart onto the staged snapshot |
| `POST /snapshot/cancel`, `/discard-staged`, `/discard-previous` | Stop, or free disk space |

Checks before anything is staged: the official checksum (downloads; uploads are compared when
it applies), the zip's CRCs, no absolute or `..` paths, exactly one RocksDB database, and
enough disk space. See [docs/OPERATIONS.md](../../docs/OPERATIONS.md#snapshots).
