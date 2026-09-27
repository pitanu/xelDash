# Security

xelDash is built to run on a private LAN, bound to `127.0.0.1` by default. This page
describes what it protects against, what each part trusts, and the risks that remain.
Report security problems privately to the maintainer rather than in a public issue.

## Who can do what

| Who | Can |
|-----|-----|
| Anyone who can reach the dashboard | Read everything it shows: miner addresses, worker names and last IPs, hashrates, blocks, node status |
| Anyone who can reach Stratum or getwork | Mine, within the limits below |
| Holder of `XELDASH_ADMIN_TOKEN` | Change the daemon's settings and replace its chain data |

**The admin token is full control of the node.** Daemon settings include file paths and
network options, and a snapshot replaces the chain the node follows. Use a long random
token (at least 20 characters; shorter ones leave node changes off) and keep it private.
Leave it unset if you do not need these features.

## Protections

- **Nothing sensitive is published.** Daemon RPC, PostgreSQL and node-admin are only on the
  internal Compose network. The dashboard, API and Stratum bind to `127.0.0.1` unless you set
  a LAN address.
- **Stratum and getwork abuse limits.** Per IP: 64 connections, 20 messages per second per
  connection, and a 15-minute ban after 50 invalid submissions or failed logins in 5 minutes.
  At most 32 workers per connection; worker names may not contain control characters.
  Malformed requests are refused without affecting other miners.
- **Browsers cannot reach getwork**, and the live-update WebSocket only accepts the
  dashboard's own origin, so other websites cannot use a visitor's browser against them.
- **Dashboard headers.** A strict Content-Security-Policy (scripts, styles and connections
  from the dashboard itself only), no framing by other sites, no referrer, no server version.
- **Admin actions** need the token in an `X-Admin-Token` header (not a cookie), so other
  websites cannot trigger them. It is compared in constant time and kept in the browser tab's
  session storage only.
- **Snapshots** are checked before use: the official checksum where it applies, the zip's own
  CRCs, no absolute or `..` paths, no links or special files, and exactly one database.
- **Daemon settings** are validated against the daemon's own option list and parser, and rolled
  back if the node does not stay up with them. Secret values are never sent to the browser.
- **Alerts** do not let worker names trigger Discord mentions such as `@everyone`.
- **Containers.** The API and Stratum run as an unprivileged user. Backups are owner-only
  files.

## Remaining risks

The first three are solved by the optional `proxy` service (HTTPS, a login, and a host-name
check); see [OPERATIONS.md](OPERATIONS.md#https-and-a-login). Without it:

- **Anyone who can reach the dashboard can read it.** There is no login for viewing.
- **No HTTPS.** The admin token crosses the LAN in clear text when you use it from another
  machine.
- **DNS rebinding.** A malicious website could, in principle, read dashboard data from a
  browser on the same network by rebinding its domain to the dashboard's address. It cannot
  use the admin token, which stays with the dashboard's own origin.
- **Some bad daemon settings do not stop the node** (for example, an invalid P2P bind address
  leaves it running without P2P), so they are not rolled back automatically. Check the Health
  page after a change.
- **The official node fallback trusts node.xelis.io while it is in use.** It is off by
  default. When on and none of your nodes can issue work, that server provides block
  templates. The key rewards are paid to comes from your own node whenever it answers, but
  if none of your nodes is reachable at all, the public node looks it up too.
- **node-admin and the daemon run as root** inside their containers, because they own the
  node's data volume.
