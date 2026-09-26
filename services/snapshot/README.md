# Snapshot service

Downloads, receives, verifies and unpacks node snapshots (zips of a node's RocksDB
database) onto the node's data volume, for the dashboard's **Node data** page. The node
container's entrypoint (`docker/daemon/entrypoint.sh`) swaps a staged snapshot in when it
restarts; the two only share marker files under `<data>/.snapshot`.

It is not published to the host: the dashboard's nginx proxies `/api/v1/snapshot/` to it,
streaming uploads without buffering. Every action needs `XELDASH_ADMIN_TOKEN`.

| Endpoint | Does |
|----------|------|
| `GET /status` | Current operation and progress, chain data, disk space, official snapshot info |
| `PUT /upload` | Receive a zip (streamed, hashed), then check and unpack it |
| `POST /download` | Download the official snapshot (resumable), verify the checksum, unpack |
| `POST /restart` | Ask the node to restart onto the staged snapshot |
| `POST /cancel`, `/discard-staged`, `/discard-previous` | Stop, or free disk space |

Checks before anything is staged: the official checksum (downloads; uploads are compared when
it applies), the zip's CRCs, no absolute or `..` paths, exactly one RocksDB database, and
enough disk space. See [docs/OPERATIONS.md](../../docs/OPERATIONS.md#snapshots).
