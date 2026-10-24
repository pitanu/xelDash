# What 1.0.0 promises

From 1.0.0, xelDash follows [Semantic Versioning](https://semver.org/) for everything on this page: within 1.x (1.0.0, 1.1.0,
1.2.3 and so on) none of it is renamed, removed or changed in meaning. New things may be added in any 1.x release. A change that
breaks something here waits for 2.0.0 and is marked **Breaking** in the [changelog](../CHANGELOG.md).

Until 1.0.0 is released, this page describes the plan; 0.x releases may still change these things, and say so in the changelog.

## Updating

- `xeldash update` (`./xeldash.sh update`) takes any 1.x install to a newer 1.x release with no steps by hand. Your `.env`, your
  statistics and your backups are kept, and a backup of the statistics is saved before anything changes (see
  [Updating xelDash](OPERATIONS.md#updating-xeldash)).
- Database migrations only add to the data: going back to an older 1.x release after an update may lose what the newer one added,
  but the older release still starts.
- A backup made by `xeldash backup` on 1.x can be restored (`xeldash restore`) on the same or a later 1.x release.

## Settings (`.env`)

- Every setting in [.env.example](../.env.example) keeps its name and meaning. Defaults may be tuned (a retention period, a limit);
  such a change is listed in the changelog.
- A setting renamed before 1.0.0 still works under its old name throughout 1.x: `XELDASH_PUBLIC_HOST` is `XELDASH_CONNECT_HOST`.
  The launcher adds the new name to `.env` and keeps the old line the same, so going back to an older version still works.
- Variables that only the Compose files set for the containers (`DATA_DIR`, `CONFIG_DIR`, `DATABASE_URL`, `CONNECT_HOST` and the
  like) are not settings and are not promised.

## Launcher commands

`install` (with `--address`, `--lan`, `--network`, `--yes`, `--no-start`, `--set KEY=VALUE`), `start`, `stop`, `restart`, `status`,
`logs`, `open`, `token`, `update`, `backup`, `restore FILE`, `lan on|off|status`, `frontdoor setup|join|status|off`, and on Linux
`cluster setup|join|status|off`. They keep their names and options in `xeldash.cmd`, `xeldash.ps1` and `xeldash.sh`.

## The API (`/api/v1`)

These `GET` endpoints, and the fields they answer with, keep their names and meaning; answers may gain fields, so a client should
ignore fields it does not know: `/api/v1/overview`, `/api/v1/status`, `/api/v1/hashrate`, `/api/v1/miners`,
`/api/v1/miners/{address}`, `/api/v1/miners/{address}/workers/{name}`, `/api/v1/blocks`, `/api/v1/blocks.csv` (its columns too),
`/api/v1/events`, `/api/v1/rewards`, `/api/v1/uptime`, `/api/v1/version`, `/api/v1/problems`, `/api/v1/price`, `/api/v1/connect`,
`/api/v1/front-door`, `/api/v1/mining-health`. A public server answers them without IP addresses, as described in
[Operations](OPERATIONS.md#public-mode).

Not promised: node administration (`/api/v1/node/*`, which the dashboard uses and which may change with it), what xelDash servers
send each other (`/api/v1/ingest`), and the dashboard's live-update messages (`/api/v1/live`).

## Webhook alerts

Each alert's `event` name and the fields listed under [Webhook alerts](OPERATIONS.md#webhook-alerts) keep their names; alerts may
gain fields, and new kinds of alert may be added.

## Metrics

With metrics on ([Operations](OPERATIONS.md#metrics)), these names keep their meaning and the labels they have at 1.0.0:
`xeldash_shares_total`, `xeldash_share_difficulty_total`, `xeldash_share_seconds`, `xeldash_share_batch_seconds`,
`xeldash_shares_written_total`, `xeldash_blocks_total`, `xeldash_connections`, `xeldash_workers`, `xeldash_ip_bans`,
`xeldash_store_online`, `xeldash_store_queued_shares`, `xeldash_store_journal_records`, `xeldash_store_dropped_total`,
`xeldash_node_ready`, `xeldash_node_active`, `xeldash_node_fallback`, `xeldash_node_topoheight`, `xeldash_node_peers`,
`xeldash_public_mode`, `xeldash_event_loop_delay_seconds`, `process_cpu_seconds_total`, `process_resident_memory_bytes`, and the
per-worker `xeldash_worker_shares_total` and `xeldash_worker_difficulty_total`. New metrics may be added.

## Ports

The default ports stay: 8088 (dashboard), 3333 (Stratum), 3334 (Stratum over TLS), 8090 (getwork), 2125 (the XELIS node's P2P), and
9464 (metrics, when on). Each can still be changed in `.env`.

## Not promised

- How the dashboard looks and where things are on it.
- The database's tables: read statistics through the API, not the database.
- How the containers are built inside, and how the services talk to each other.
- Anything marked experimental, or described as a test tool (`npm run load`, the devnet scripts).
