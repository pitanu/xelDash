# Pre-release testing

What has not been tested on a real system yet, and how to test it before the repository goes
public. Everything here was built and checked on one Windows PC that already had xelDash
running, so the first-time experience on a clean machine is the biggest unknown.

For each item, note the result (pass, fail, or unclear) and what you saw. Report problems as
issues, or to the maintainer directly. Do not paste your `.env` file or admin token anywhere.

## 1. Clean-machine install (most important)

Use a computer or virtual machine that has never run xelDash. Docker Desktop (Windows, macOS)
or Docker Engine (Linux) should be installed but nothing else. Pretend you know nothing about
XELIS nodes or wallets.

- [ ] Follow [GETTING-STARTED.md](GETTING-STARTED.md) using only the launcher (`xeldash.cmd`,
      `xeldash.ps1` or `xeldash.sh`). Note every point where you were unsure what to do.
- [ ] The dashboard opens by itself with the setup page, and no token had to be copied by hand.
- [ ] Step 1 (node sync) shows sensible progress and an estimated time, and finishes.
- [ ] Step 2: pasting a wrong address (typo, wrong network, extra spaces) gives a clear message;
      a correct one is accepted. The web wallet link opens wallet.xelis.io.
- [ ] Step 3: connect a real miner using only what the setup page shows.
- [ ] After a first block or share, the Overview and Miners pages show it.
- [ ] `xeldash stop`, then `xeldash start` again: everything comes back, and the address is kept.
- [ ] `xeldash update` works, and mining continues afterwards.

## 2. Local network only

- [ ] From another computer or phone on the same Wi-Fi, open the dashboard and connect a miner
      to Stratum after running `xeldash lan on`.
- [ ] Windows: from an elevated PowerShell run `.\xeldash.ps1 firewall preview`, then
      `firewall on`, then `firewall status`. Repeat the check above from another device. The
      rules should appear in Windows Defender Firewall under the group "xelDash".
- [ ] Windows: `firewall off` and `firewall remove` remove them again.
- [ ] From outside the network (for example a phone on mobile data, with no port forwarding set
      up), the dashboard and Stratum ports are not reachable. Do not forward ports on the
      router to test this.
- [ ] Linux with Docker Engine (not Docker Desktop): a computer with a public address, or a
      test using `XELDASH_ALLOWED_NETWORKS=192.168.99.0/24`, is turned away, and the reason
      shows in "Connection problems".
- [ ] `PostgreSQL` is not reachable: `docker compose exec web sh -c "nc -z postgres 5432"`
      should fail, and nothing listens on port 5432 on the host.

## 3. Connection problems card

Try each of these and check the Health or Setup page explains it in plain words within a
minute:

- [ ] A mainnet address on a test network (or the reverse).
- [ ] An address with one letter changed.
- [ ] A miner with no address at all.
- [ ] A miner pointed at the wrong port (for example the dashboard's port).
- [ ] A miner started while the node is still syncing.

## 4. Other miners

Only Rigel has been tested on mainnet. For each miner: does it connect, get work, and have
shares accepted? Does `address.worker` in the user field work?

- [ ] SRBMiner-MULTI
- [ ] lolMiner
- [ ] OneZeroMiner
- [ ] The official `xelis_miner` (getwork, port 8090)
- [ ] A miner over TLS (port 3334, self-signed certificate)

## 5. Alerts

- [ ] Settings, Alerts: set up Discord, save, press "Send a test message". It arrives.
- [ ] The same for Telegram and for a generic webhook.
- [ ] A wrong Discord address or bot token gives a readable error, not a crash.
- [ ] Turning an alert type off stops it (for example, "A worker stops sending shares").
- [ ] Restart the stack: the saved settings are still there.
- [ ] When one of your blocks loses the race for its height, a "side block for now" event and alert
      arrive well before the block is final. This has not been seen against a real daemon yet, so
      note whether it fires. If only the later "final as a side block" alert arrives, report it.

## 5b. Database outage

- [ ] With a rig mining, stop PostgreSQL (`docker compose stop postgres`) for a minute: the rig stays connected and
      keeps finding shares, and the dashboard shows "Dashboard offline: the database is not reachable. Mining continues."
- [ ] Start it again: within seconds the dashboard recovers, the shares and blocks from the outage are in the
      statistics, and `docker compose exec stratum ls /spool` shows no journal left.
- [ ] Restart the mining server (`docker compose restart stratum`) in the middle of an outage: the rig reconnects and
      keeps mining, and everything is recorded once the database is back.

## 5c. Two-server cluster (needs two Linux computers with Docker Engine on the same network)

Only the failover logic has been tested so far, with containers on one machine; none of this has run on real hardware.

- [ ] `./xeldash.sh cluster setup` on the first server suggests a free address and prints a code; `cluster join CODE` on
      the second works, and `cluster status` on both shows one as active and one as standing by.
- [ ] A miner connected to the shared address mines on the active server. Switch that server off (power it off, not
      `docker stop`): the miner reconnects to the other one within about ten seconds and keeps getting shares accepted.
- [ ] The standby's page (its own address) shows "Dashboard offline ... mining continues" with the rig counted, while the
      main server is off. Switch the main server back on: the page shows the real dashboard again by itself, the
      journal drains (the "records waiting" number goes to nothing), and the blocks and shares from the outage appear in the statistics.
- [ ] The returning server stays on standby (it does not take the address back).
- [ ] Reboot the active server (not power off): same result. Reboot the standby: nothing happens to mining.
- [ ] Stop the active server's node (`docker compose stop daemon`): it gives the address up, the other server takes it,
      and the Health page says "Cannot mine".
- [ ] After the main server returns as standby, an alert "standing by again" arrives (alert type "A server takes over
      the shared address"); and when the main server's node is stopped, an alert says it cannot mine.
- [ ] Both servers on a Raspberry Pi (arm64), if you have one.

## 6. Nodes and upgrades

- [ ] Add a second local node, then a rolling update to a newer version. Mining continues.
- [ ] Schedule an upgrade for a block height.
- [ ] Automatic updates (optional, off by default) with two nodes.
- [ ] Download the official snapshot from the Nodes page.

## 7. Linux and macOS launcher

- [ ] `./xeldash.sh install`, `start`, `stop`, `update`, `lan on`, `lan off`, `status`.
- [ ] Note anything that assumes Windows.
- [ ] On Apple Silicon or a Raspberry Pi (arm64): do the containers start? No arm64 image has
      been built yet.

## 8. Release workflow (maintainer)

- [ ] Push a `v0.1.0-rc.1` tag and check the release workflow, including the arm64 build.
- [ ] A fresh install using the published images pulls them instead of building.
- [ ] The published images are public: GitHub creates container packages as private, so set each
      one (api, stratum, web, node-admin, daemon) to public, then confirm a pull works while logged out.
- [ ] A release candidate tag (for example `v0.1.0-rc.1`) does not take the `latest` tag.
- [ ] Enable GitHub private vulnerability reporting (the security policy points to it).
- [ ] Confirm CI passes on the default branch.

## Known limits (not bugs)

- On Docker Desktop, xelDash cannot tell a LAN computer from an internet one; the Windows
  firewall rules and the router are what protect it. See [SECURITY.md](SECURITY.md).
- There are no automated tests yet.
- Node upgrades check checksums but not a PGP signature, because XELIS has not published a
  signing key.
