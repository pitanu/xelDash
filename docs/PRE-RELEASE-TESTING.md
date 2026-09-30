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
- [ ] Enable GitHub private vulnerability reporting (the security policy points to it).
- [ ] Confirm CI passes on the default branch.

## Known limits (not bugs)

- On Docker Desktop, xelDash cannot tell a LAN computer from an internet one; the Windows
  firewall rules and the router are what protect it. See [SECURITY.md](SECURITY.md).
- There are no automated tests yet.
- Node upgrades check checksums but not a PGP signature, because XELIS has not published a
  signing key.
