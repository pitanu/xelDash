# Getting started

This page takes you from nothing to a miner earning XEL, assuming you have never run a node or
used Docker. It takes about 20 minutes of your time, plus a wait while the blockchain downloads
(you do not need to watch it).

**What you are setting up:** xelDash runs a XELIS node for you (the program that keeps a copy of
the blockchain), plus a mining server your mining programs connect to, plus a dashboard to watch
it all. Rewards for blocks you find go straight to your own wallet: xelDash never holds coins.

## What you need

- **A computer that can stay on:** Windows 10 or 11, macOS, or Linux. About 25 GB of free disk
  space for the blockchain, and a normal internet connection.
- **Docker.** It is a free program that runs xelDash's parts in the background so you do not
  have to install each one. See the next section.
- **A XELIS wallet address**, to receive rewards. You can get one after installing; see
  [Your wallet address](#your-wallet-address).
- **A mining program and a graphics card or processor** to mine with. See
  [Connecting miners](MINERS.md). If you do not have these yet, you can still set up xelDash first.

## 1. Install Docker

| Your computer | What to do |
|---------------|-----------|
| **Windows** | Download and install [Docker Desktop](https://www.docker.com/products/docker-desktop/). If it offers to turn on WSL 2, say yes, and restart Windows if it asks. Then open Docker Desktop from the Start menu and wait until it says it is running. |
| **macOS** | Download and install [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/), open it once, and wait until it says it is running. |
| **Linux** | Install [Docker Engine](https://docs.docker.com/engine/install/) (it includes Compose), and add yourself to the docker group: `sudo usermod -aG docker $USER`, then log out and in. |

You do not need to know anything else about Docker. xelDash's launcher tells you if something is
missing.

## 2. Get xelDash

On the project's GitHub page, choose **Code → Download ZIP**, then unzip it somewhere you will
find again, for example your Documents folder. (If you know git, `git clone` works too and
lets xelDash update itself later.)

## 3. Run the installer

- **Windows:** open the unzipped folder and double-click **`xeldash.cmd`**.
- **macOS and Linux:** open a terminal in the folder and run `./xeldash.sh`.

It asks two questions, and both can be skipped:

1. **Your wallet address.** Paste it, or press Enter to add it later in the dashboard.
2. **Other computers.** Say yes if you will mine from other computers on your home network.

Then it does the rest: it makes a random password for the database and an admin password for the
dashboard, chooses the real XELIS network (mainnet) and the fast start from the official
snapshot, builds and starts everything (about 10 minutes the first time), and opens the
dashboard in your browser.

**Write down the admin password it prints.** You need it to change settings in the dashboard. You
can show it again any time with `xeldash token` (Windows) or `./xeldash.sh token`.

## 4. Follow the setup guide

The dashboard opens on a **Get started** page with four steps and a progress bar:

1. **Connect to the XELIS network.** xelDash downloads a snapshot of the blockchain (about 9 GB)
   and starts your node from it, with a progress bar and time left. This is the slow part; leave
   it running. You can close the page and come back.
2. **Choose where your rewards go.** Paste your wallet address.
3. **Connect a miner.** The page shows the exact settings to copy into your mining program.
4. **Watch your first share arrive.** Once a share is accepted, everything works.

## Your wallet address

A wallet address is like a bank account number: it tells XELIS where to send the rewards. It
starts with `xel:` on the real network. You get one by creating a wallet:

1. Go to **[wallet.xelis.io](https://wallet.xelis.io)**, the official XELIS web wallet, and create a new wallet.
2. **Write down the recovery phrase on paper and keep it safe.** Never share it, never type it
   into any other website, and never send it to anyone. Whoever has it can take your coins. There
   is no way to recover it if you lose it.
3. Copy your wallet's address and paste it into xelDash.

xelDash only ever needs the address, never the recovery phrase or your wallet password, and it
cannot move your coins. If anything asks you for them, it is not xelDash.

## Day to day

| To do this | Windows | macOS and Linux |
|------------|---------|-----------------|
| See what is running | `xeldash status` | `./xeldash.sh status` |
| Stop, start again | `xeldash stop`, `xeldash start` | `./xeldash.sh stop`, `./xeldash.sh start` |
| Open the dashboard | `xeldash open` | `./xeldash.sh open` |
| Show the admin password | `xeldash token` | `./xeldash.sh token` |
| Let other computers on your network use it | `xeldash lan on` | `./xeldash.sh lan on` |
| Update xelDash | `xeldash update` | `./xeldash.sh update` |
| Two Linux servers sharing one address (redundancy) | not on Windows | `./xeldash.sh cluster setup` |
| Save a backup of your statistics | `xeldash backup` | `./xeldash.sh backup` |
| Put a backup back | `xeldash restore FILE` | `./xeldash.sh restore FILE` |
| See the logs | `xeldash logs` | `./xeldash.sh logs` |

To type these on Windows, open a Command Prompt in the xelDash folder (click the folder's address bar,
type `cmd` and press Enter) and use `xeldash` as written. In PowerShell, type `.\xeldash` instead.
Most things are also on the dashboard: node restarts, settings and updates
are on the **Nodes** and **Settings** pages.

`update` needs xelDash to have been downloaded with git. If you used the ZIP, download the newest
ZIP, unzip it, and copy your `.env` file (the settings, including your passwords) into the new
folder before running the launcher.

## Mining from other computers

By default, only the computer running xelDash can connect, which is the safe choice. To mine from
other computers on your home network, run `xeldash lan on` (`./xeldash.sh lan on`). It finds this
computer's address on your network, checks that it is a home-network address (and refuses
otherwise), lets other computers on your network connect, and shows the address to type into
your miners. On Windows it also asks for permission to add firewall rules that allow your home
network and block the internet: say yes (`xeldash firewall status` shows them, `xeldash firewall off`
removes them). xelDash only accepts miners from private networks; `XELDASH_ALLOWED_NETWORKS` in
`.env` changes that.

**Never open xelDash's ports on your router** (port forwarding). It is built for your home
network, not the internet. See [Security](SECURITY.md).

## Problems

- **"Docker is not running".** Open Docker Desktop and wait until it says it is running.
- **A port is already in use.** Another program uses 8088 or 3333. Change `XELDASH_WEB_PORT` or
  `XELDASH_STRATUM_PORT` in the `.env` file, then run `start` again.
- **The snapshot is slow or stuck.** It is a 9 GB download; a slow connection takes a while. It
  resumes if interrupted. The **Nodes** page shows the details.
- **I forgot the admin password.** Run `xeldash token`. It is also in the `.env` file.
- **My miner will not connect.** The Health and Get started pages list connections that were
  turned away, with the reason and what to change. The Get started page also has a checklist under
  "It does not connect". Most often it is the wrong address for another computer, or network access is off.
- **The dashboard says "Dashboard offline".** The page cannot reach its data. If it says the database is not reachable,
  mining carries on: your rigs stay connected and everything is recorded when the database is back, with nothing to do.
  If it says it cannot reach the xelDash server, the page reconnects by itself; if you run two servers, the other one keeps
  mining and its own page says so.
- **I want to start over.** Run `docker compose down -v` in the folder, then delete the folder.
  This deletes the blockchain copy and all statistics (not your wallet, which is separate).

More: [Connecting miners](MINERS.md), [Operations](OPERATIONS.md) (alerts, backups, a second
node, upgrades), [Security](SECURITY.md).

---

## Manual setup (advanced)

The launcher does what this section does by hand. Use it if you prefer to control every setting.

```sh
git clone https://github.com/pitanu/xelDash.git
cd xelDash
cp .env.example .env
```

Open `.env` and set at least `POSTGRES_PASSWORD` (any long random password) and
`XELDASH_ADMIN_TOKEN` (`openssl rand -hex 24`). The defaults choose mainnet and the official
snapshot. `XELIS_DEFAULT_ADDRESS` is optional (the dashboard can set the address). Every setting
is explained in [`.env.example`](../.env.example). Then:

```sh
docker compose up -d --build
```

Open **http://localhost:8088**. To use it from other machines, set the bind addresses in `.env`
to this machine's LAN address (or 0.0.0.0 on a home network), set `XELDASH_PUBLIC_HOST` to it too,
and run `docker compose up -d` again:

```
XELDASH_WEB_BIND_IP=192.168.1.10
XELDASH_STRATUM_BIND_IP=192.168.1.10
XELDASH_PUBLIC_HOST=192.168.1.10
```

### Ports

| Port | What | Default bind |
|------|------|--------------|
| 8088 | Dashboard | `127.0.0.1` |
| 3333 | Stratum | `127.0.0.1` |
| 3334 | Stratum over TLS (optional) | `127.0.0.1` |
| 8090 | Getwork, for the official `xelis_miner` | `127.0.0.1` |
| 8081 | API | `127.0.0.1` |
| 2125 | XELIS P2P | `127.0.0.1` |

Your node connects out to other nodes without any setup. To also accept incoming peers, which
helps the network and your blocks' reach, forward P2P port 2125 on your router and set
`XELIS_P2P_BIND_IP=0.0.0.0`. The daemon's RPC, PostgreSQL and the admin service are never
published.

### Commands

```sh
docker compose ps                  # what is running
docker compose logs -f stratum     # or daemon, api, node-admin, web
docker compose restart stratum
docker compose down                # stop everything; data volumes are kept
git pull && docker compose up -d --build   # update xelDash
```

To reach the daemon's RPC from the host while debugging (never on a machine others can reach):

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d daemon
```

This publishes the RPC on `127.0.0.1:8080`. To try xelDash without real coins, see [Devnet](DEVNET.md).
