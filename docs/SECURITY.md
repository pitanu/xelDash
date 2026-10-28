# Security

xelDash is built to run on a private LAN, bound to `127.0.0.1` by default, or as a public solo mining server with
public mode (`XELDASH_PUBLIC_MODE=true`, see [OPERATIONS.md](OPERATIONS.md#public-mode)). This page describes what it
protects against, what each part trusts, and the risks that remain.
Report security problems privately rather than in a public issue: use the repository's
**Security** tab ("Report a vulnerability"), or contact the maintainer through their GitHub
profile.

## Who can do what

| Who | Can |
|-----|-----|
| Anyone who can reach the dashboard | Read everything it shows: miner addresses, worker names and last IPs, hashrates, blocks, node status. On a public server, visitors see no IP addresses, connection problems, recent events or node administration; the operator's full dashboard is on the server's loopback only |
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
- **A block sound of your own stays in your browser.** The audio file chosen in Settings is kept in that browser (IndexedDB)
  and never sent to the server, so a public server stores and serves nothing for it: each visitor's choice reaches only their
  own browser. It is played from its bytes with the Web Audio API, so the dashboard's content security policy is unchanged, and
  only a file that decodes as audio, of at most 1 MB and 10 seconds, is taken.
- **Metrics name nobody, and stay off unless asked for.** Stratum's Prometheus metrics (the `metrics` profile) are totals: no
  address, worker name or IP address is a label. Per-worker metrics are a separate choice and are never served in public mode.
  Their port is on `127.0.0.1` by default, can require a token, and on a public server published beyond this computer without
  one, every scrape is refused. They are served by Stratum on its own port, never through the dashboard or the API.
- **Stratum and getwork abuse limits.** Per IP: 64 connections, 20 messages per second per
  connection, and a 15-minute ban after 50 or more invalid submissions or failed logins in 5 minutes, when over half of that
  client's submissions in that time were invalid.
  At most 32 workers per connection; worker names may not contain control characters.
  Malformed requests are refused without affecting other miners. When a connection limit is reached, a connection that has never
  had a share accepted and has been quiet for 2 minutes makes room for the new one, and on a public server connections with no share
  for 30 minutes are closed, so idle logins cannot keep miners out.
- **Browsers cannot reach getwork**, and the live-update WebSocket only accepts the
  dashboard's own origin, so other websites cannot use a visitor's browser against them.
- **DNS rebinding is refused.** A website that points its own domain at the dashboard's address (your LAN address, or
  127.0.0.1 on the xelDash computer) to read it through a visitor's browser gets 421: the dashboard and the API's own port answer
  only addresses, names without a dot, local names (`.local`, `.lan`, `.home`, `.home.arpa`, `.internal`, `.localhost`,
  `.ts.net`), and the names in `.env` (`XELDASH_CONNECT_HOST`, `XELDASH_PUBLIC_DOMAIN`, `XELDASH_PROXY_HOST`,
  `XELDASH_ALLOWED_HOSTS`). The live feed checks it too.
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
- **xelDash's own images are signed.** Every release image on ghcr.io carries a build attestation (GitHub artifact attestations,
  signed through Sigstore with this repository's release workflow as the signer), BuildKit's record of the build, and a list of what
  is inside it (SBOM). The release notes list each image's digest. To check an image before running it:
  `gh attestation verify oci://ghcr.io/pitanu/xeldash/api:0.8.0 --owner pitanu` (any image and version). `xeldash update` does not
  check this itself yet; it pulls the images by version.
- **Daemon releases** are downloaded only from the XELIS repository's own GitHub release
  files. Each archive must match the release's `checksums.txt` and GitHub's digest, and
  `xelis_daemon` inside it the archive's own checksum list. A node that does not stay up on
  a new version for 30 seconds is switched back, and a switch never continues to the next node
  after a failure. Automatic updates are off by default, need two local nodes, wait 24 hours
  after a release, and only move forward. On a public server they run only while `.env` allows them
  (`XELIS_AUTO_UPDATE=true`; the dashboard cannot switch them on otherwise) and wait at least 36 hours. xelDash itself never
  updates by itself.
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
- **Only your own network can mine** (unless you run a public server). Stratum, getwork and the dashboard accept connections from
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
- **The database is unreachable from outside.** Containers sit on four networks: `edge`
  (dashboard and proxy), `node` (daemons), `data`, which is internal (no route to the
  host or the internet), and `metrics` (Stratum and the optional metrics forwarder only). Only the API, Stratum, node-admin, and the migration and backup jobs join `data`;
  the web container cannot reach PostgreSQL, and PostgreSQL publishes no port.
- **Alerts** do not let worker names trigger Discord mentions such as `@everyone`.
- **Public mode** (`XELDASH_PUBLIC_MODE`, for a server open to the internet): the API removes every IP-address field from what
  the public dashboard receives, at the one place it sends JSON, and leaves out bans and connection problems; a test calls every
  API route against a database full of IP addresses and fails on any it finds. The public web server answers 404 for node
  administration and replaces any view header a visitor sends, so a visitor cannot ask for the operator's view. A login without
  an address is refused, so no one mines for the server by mistake. The operator's full dashboard is a separate container
  published on 127.0.0.1 only (fixed in the Compose file). Recent events are the operator's only. Alerts never carry a miner's
  IP address; on a public server there are none about individual workers, and cluster alerts leave out the shared address. A
  standby or front door learns public mode from the main server over the cluster's secret connection and keeps it across restarts
  (an unreadable record keeps it on). Everything reachable from the internet is limited (see
  [OPERATIONS.md](OPERATIONS.md#public-mode)): Stratum asks the XELIS node at most 100 times a second whatever miners do (found
  blocks never wait; one template per block serves every miner; checked addresses are remembered), with 32 different addresses,
  1,000 connections, 1,000 new worker names an hour and 300 checked shares a second per IP address and 5,000 connections in all
  (a miner's `d=` cannot hold its difficulty below what the server's vardiff chooses); the API asks the node at most once every 2
  seconds per kind of question; the dashboard limits each visitor and all visitors together, with short timeouts; and the official
  node fallback is never used. A test floods Stratum with fresh addresses from many IP addresses and checks the node budget holds.
- **Database growth.** Shares for job ids a connection was never given count as invalid and are not recorded, late (stale)
  shares are recorded at most 30 a minute per connection, workers that never mined are deleted after a day unused, and shares are
  counted in the minute stats instead of stored one by one. Every container's log is rotated.
- **Containers.** The API and Stratum run as an unprivileged user. Backups are owner-only
  files.

## Remaining risks

- **A public server keeps miners' IP addresses.** Public mode hides them from visitors, but the database records them for the
  per-address limits and bans, and backups contain them. On Docker Desktop every internet client looks like one address, so those
  limits cannot work: run a public server on Linux with Docker Engine. Floods large enough to fill the server's network
  connection are for the hosting provider to stop; the dashboard's per-visitor limits trust the visitor address named by the HTTPS
  proxy only from the dashboard's own Docker network.

The first two are solved by the optional `proxy` service (HTTPS and a login); see
[OPERATIONS.md](OPERATIONS.md#https-and-a-login). Without it:

- **Anyone who can reach the dashboard can read it.** There is no login for viewing.
- **No HTTPS.** The admin token crosses the LAN in clear text when you use it from another
  machine.
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
  forward its ports, unless you mean to run a public server: then turn on public mode first, which hides IP addresses and
  node administration from visitors and limits what strangers can do.
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
  token: they show sizes, a server name and a count of connected rigs, to anyone who is allowed on your network. On a public
  server the node endpoints are not served to visitors at all (a 404), and the standby's status page leaves out the front door's
  addresses. The alert
  settings file on the config volume (webhook addresses, the Telegram token) is readable by the API and Stratum containers, not
  by other users, and the dashboard only ever shows the last four characters.
- **The wallet link is only a link.** The setup page points to the official web wallet at
  wallet.xelis.io. xelDash never sees a recovery phrase, and cannot move coins.
- **Outbound requests.** Besides the XELIS network, xelDash contacts: GitHub (latest release,
  every 6 hours, and xelDash's own published releases to tell when a new version is out; `XELDASH_VERSION_CHECK=off`), CoinGecko (XEL price, only while a viewer has
  it on; `XELDASH_PRICE=off`), node.xelis.io (snapshots when asked, and the official node
  fallback when on). Browsers only ever talk to the dashboard.
- **node-admin and the daemon run as root** inside their containers, because they own the
  node's data volume.
- **The cluster's address manager is the one privileged container.** It exists only on Linux servers that set up a
  cluster, and runs on the host network with `NET_ADMIN`, `NET_BROADCAST` and `NET_RAW` so it can add the shared
  address to the network card. It has no Docker access, and mounts only the config volume.
