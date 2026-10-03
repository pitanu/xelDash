# Security

xelDash is built to run on a private LAN, bound to `127.0.0.1` by default. This page
describes what it protects against, what each part trusts, and the risks that remain.
Report security problems privately rather than in a public issue: use the repository's
**Security** tab ("Report a vulnerability"), or contact the maintainer through their GitHub
profile.

## Who can do what

| Who | Can |
|-----|-----|
| Anyone who can reach the dashboard | Read everything it shows: miner addresses, worker names and last IPs, hashrates, blocks, node status |
| Anyone who can reach Stratum or getwork | Mine, within the limits below |
| Holder of `XELDASH_ADMIN_TOKEN` | For every local node: change its settings and trusted peers, stop, start and restart it, replace its chain data (snapshot or copy), and switch it to another XELIS release (now, at a height, or automatically). Turn the official node fallback on or off, and choose the address that miners without one mine to. |

**The admin token is full control of the nodes.** Daemon settings include file paths and
network options, a snapshot or copy replaces the chain a node follows, and a version switch
chooses the program it runs (official releases only). Use a long random
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
  Peers must be `IP:port`; options the daemon refuses together are refused on save.
- **Daemon releases** are downloaded only from the XELIS repository's own GitHub release
  files. Each archive must match the release's `checksums.txt` and GitHub's digest, and
  `xelis_daemon` inside it the archive's own checksum list. A node that does not stay up on
  a new version for 30 seconds is switched back, and a switch never continues to the next node
  after a failure. Automatic updates are off by default, need two local nodes, wait 24 hours
  after a release, and only move forward.
- **No Docker socket.** Nothing in xelDash can control Docker. Node restarts, version switches
  and data swaps go through files on each node's volume that the node's own supervisor acts on.
- **Mining rewards.** The key a block pays is looked up on your own node whenever it answers,
  never taken from a block template.
- **The launcher** (`xeldash.cmd`, `xeldash.sh`) makes a random database password and admin
  token, keeps them in `.env` (which git ignores), and only lets other computers connect if this
  computer has a home-network address (10.x, 172.16-31.x or 192.168.x). It never asks for or
  touches a wallet.
- **The setup link** the installer opens carries the admin token after a `#`, which browsers
  never send to any server. The dashboard keeps it for that browser tab and removes it from the
  address bar and the history entry as soon as the page loads. It is only opened on the computer
  running the installer.
- **The mining address** is validated by your own node before it is saved (right network, no typos,
  not an integrated address), and changing it needs the admin token.
- **Only your own network can mine.** Stratum, getwork and the dashboard accept connections from
  private addresses (10.x, 172.16-31.x, 192.168.x) and this computer, and turn everything else
  away. `XELDASH_ALLOWED_NETWORKS` in `.env` changes that: `private` (default),
  `tailscale`, `any`, or a list of networks such as `192.168.1.0/24,100.64.0.0/10`.
  Docker Desktop (Windows and macOS) hides the real address of a connecting computer behind its
  own gateway, so on those systems this check cannot tell a LAN computer from an internet one.
  There the protection is the Windows Firewall rules that `xeldash firewall` adds (allow the local
  subnet, block the internet) and, above all, not forwarding the ports on your router. On Linux
  with Docker Engine the real address is visible and the allowlist is enforced by xelDash itself.
  Per-address limits are switched off for Docker's gateway address, because every computer
  would share it.
- **The database is unreachable from outside.** Containers sit on three networks: `edge`
  (dashboard and proxy), `node` (daemons) and `data`, which is internal (no route to the
  host or the internet). Only the API, Stratum, and the migration and backup jobs join `data`;
  the web container cannot reach PostgreSQL, and PostgreSQL publishes no port.
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
- **Daemon upgrades from the dashboard run binaries from the XELIS GitHub releases.** They
  are checked against the release's checksums and GitHub's digest, but not a PGP signature
  (the signing key is not published). Anyone with the admin token can switch versions, and download a backup of the statistics (miner addresses and IP addresses).
- **The official node fallback trusts node.xelis.io while it is in use.** It is off by
  default. When on and none of your nodes can issue work, that server provides block
  templates. The key rewards are paid to comes from your own node whenever it answers, but
  if none of your nodes is reachable at all, the public node looks it up too.
- **"Allow other computers" listens on every network interface** of this computer (the
  launcher checks first that the computer has a home-network address). On a home network behind
  a router that is fine; on a computer with a public address, or if you forward xelDash's ports on
  your router, anyone on the internet could read the dashboard and use your mining server. Never
  forward its ports.
- **Records kept during an outage are private.** While the database cannot be reached, Stratum keeps its journal (miner
  addresses, IP addresses, shares) in a file readable only by the mining server, on a volume that is not published.
- **The ingest endpoint exists only in a cluster.** `/api/v1/ingest` answers 404 unless `XELDASH_CLUSTER_SECRET` (at least 16
  characters) is set, checks the secret in constant time before it reads any body, and takes at most 4 MB and 2000 records per
  request. Every record is checked before it is applied (types, lengths, a sequence number that cannot jump ahead and freeze
  later records, payloads under 8 KB), and one that fails is counted and dropped, never stored.
- **What a miner can make Stratum record is limited.** Connection-problem events cut the miner's address and worker text to 200
  characters and are capped at 60 a minute in all. While the database is away, the journal keeps blocks always, but events and
  bans only up to twice `STRATUM_JOURNAL_MAX_MB` and shares only up to `STRATUM_JOURNAL_MAX_MB`, so nothing a miner sends can fill the disk.
- **A cluster code is checked before it is used.** `./xeldash.sh cluster join` accepts the shared address (a home-network
  address), cluster number, secret (32 hex characters), network, wallet address, the main server (a home-network address or a
  `.local`/`.lan`/`.home` name, as `http://host:port`) and server name only in their exact forms, and writes nothing to
  `.env` otherwise, so a crafted code cannot send a standby's records and secret to another computer or add text to a
  configuration file. The address manager checks the same values again before it builds its configuration.
- **`.env` is private on Linux and macOS.** The launcher creates it readable by its owner only (it holds the database password,
  the admin token and the cluster secret). On Windows it has the folder's normal permissions.
- **The standby copies the alert settings.** To send the failover alert while the main server is away, the standby asks the main
  server for its alert settings (webhook addresses, the Telegram token) over the ingest endpoint, with the cluster secret, and
  keeps them in its config volume. They cross your network in plain HTTP, like the rest of the cluster traffic; the same trust as
  the secret itself (see the next point), and a reason to use the HTTPS proxy profile if your network is shared.
- **The front door is trusted to name the miner.** With a front door (`STRATUM_PROXY_FROM`), the main server's Stratum reads a
  PROXY line from the listed addresses telling it each miner's real address, and uses it for the network allow-list, limits and bans.
  A computer that is not listed is never believed (its connection is taken as it is, and a PROXY line from it is not valid
  Stratum). `any` and networks of every address are refused. A listed address must always send the line, so a front door cannot
  be bypassed from it by mistake. On Docker Desktop (Windows, macOS) the main server's Stratum sees every outside computer as
  Docker's gateway, so the setup trusts `gateway` there: any computer on your network that can reach the Stratum port can then
  claim to be another address, to get around a ban or the "Miners may connect from" setting. That is the same trust as letting
  people on your network connect at all, and a reason to keep that network yours. A Linux main server trusts the front door's
  address only.
- **The front door decrypts Stratum TLS.** With encrypted Stratum on the front door (`STRATUM_TLS_ENABLED=true`), the miner's connection
  is encrypted only as far as the front door; from there to the main server it is plain on your network (with the PROXY line). Its
  private key is in `docker/stratum-tls` on the front door, read-only, and never leaves it. Miners accept TLS 1.2 and newer.
- **A redundancy cluster trusts your network.** The two servers share a secret (`XELDASH_CLUSTER_SECRET`, in both
  `.env` files; keep the cluster code private). The standby sends its records to the main server over plain HTTP,
  with the secret in a header, so anyone who can read traffic on your network can read it; and the address manager
  uses VRRP, which has no strong authentication, so a computer on your network can announce itself and take the
  shared address (your rigs would then mine for it, not you, if it also ran Stratum with another address). Both are
  the same trust as letting people on your network mine through xelDash at all. Use the HTTPS proxy profile for the
  main server if your network is shared with people you do not trust.
- **Some read-only endpoints are open to your network.** Disk space, the cluster role and (in a cluster) the standby's `/status` need no
  token: they show sizes, a server name and a count of connected rigs, to anyone who is allowed on your network. The alert
  settings file on the config volume (webhook addresses, the Telegram token) is readable by the API and Stratum containers, not
  by other users, and the dashboard only ever shows the last four characters.
- **The wallet link is only a link.** The setup page points to the official web wallet at
  wallet.xelis.io. xelDash never sees a recovery phrase, and cannot move coins.
- **Outbound requests.** Besides the XELIS network, xelDash contacts: GitHub (latest release,
  every 6 hours, and xelDash's own tags to tell when a new version is out; `XELDASH_VERSION_CHECK=off`), CoinGecko (XEL price, only while a viewer has
  it on; `XELDASH_PRICE=off`), node.xelis.io (snapshots when asked, and the official node
  fallback when on). Browsers only ever talk to the dashboard.
- **node-admin and the daemon run as root** inside their containers, because they own the
  node's data volume.
- **The cluster's address manager is the one privileged container.** It exists only on Linux servers that set up a
  cluster, and runs on the host network with `NET_ADMIN`, `NET_BROADCAST` and `NET_RAW` so it can add the shared
  address to the network card. It has no Docker access, and mounts only the config volume.
