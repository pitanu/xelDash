# System requirements

What the computer running xelDash needs. xelDash itself is light; the XELIS blockchain it keeps is what takes disk
space. The mining rigs are separate (see the end).

## At a glance

| | Minimum | Recommended |
|---|---|---|
| **Operating system** | Windows 10 or 11 (64-bit), macOS, or Linux (64-bit) | Linux with Docker Engine for a server that stays on; Windows 10 or 11 is fine |
| **Processor** | 2 cores, x86-64 or ARM64 | 4 cores or more |
| **Memory (RAM)** | 4 GB in the computer | 8 GB (16 GB if your rigs also run on this computer) |
| **Free disk space** | **40 GB** (25 GB if you start without the snapshot: slower, less space) | **100 GB or more, on an SSD** |
| **Network** | A normal broadband connection, always on | Wired Ethernet |
| **Software** | Docker with Compose v2 (the launcher checks and tells you what is missing) | The current Docker release |
| **Power** | A computer that stays on and does not go to sleep | The same, on a UPS if you can |
| **Browser** (to view the dashboard) | A browser from the last two years (Chrome or Edge 111+, Firefox 128+, Safari 16.4+) | Any current browser |

The minimum is enough to run one node and a handful of rigs. The recommended figures leave room for the chain to grow, for
a second node, for backups, and for a server that you do not want to think about for a year.

## Disk space: the one to plan for

**Short on disk? Start without the snapshot.** The fast start (the default) downloads the official snapshot and unpacks it
before deleting the download, which is why it peaks at about 21 GB. Syncing from other nodes instead (`XELIS_SNAPSHOT_AUTO=false`)
**is slower, but needs less space**: there is no 9 GB download and no second copy, so it never needs much more than the chain
itself, roughly **25 GB free** to be comfortable instead of 40 GB. The cost is time: a node that syncs from nothing has to
fetch and check every block, which takes much longer than unpacking a snapshot (the Overview shows the progress and time left).
The launcher checks free space before the first download and, if only the slower start fits, offers it. You can also
choose it later on the Nodes page. The 25 GB figure is an estimate, not a measurement: the node's database can use extra
space for a while as it reorganises itself while syncing, and nobody has timed a full sync here yet.

| What | Size (measured) |
|---|---|
| The XELIS blockchain, mainnet, per node | about **10.7 GB** at block 7.9 million, and it grows with the chain |
| The official snapshot (what a first start downloads) | about 9.2 GB, temporary |
| **Peak during a first start** | about **21 GB**: the snapshot download plus the unpacked chain, before the download is deleted |
| xelDash's own images | about 1.5 GB |
| The statistics database | small: about 18 MB after five days with one rig. Raw shares are kept 7 days (roughly 15 MB per active rig), per-minute stats 90 days, hourly stats forever |
| The same node **after pruning** (see below) | about **6.0 to 6.2 GB**, down from about 10.6 GB, once the node has pruned and been restarted |
| A second node (optional) | another 10.7 GB, plus 21 GB while it first starts, unless you copy the first node's chain (minutes) |
| Old chain copies kept after a snapshot or a copy | up to one more chain size each, until you delete them on the Nodes page |

So **40 GB free is the least that works comfortably for one node**, and 100 GB leaves room for a second node and growth.
xelDash warns you on the Overview and Health pages, and sends an alert, when free space falls below 20 GB
(`XELDASH_DISK_WARN_GB`). A full disk stops the node and can force a long resync. An **SSD** is strongly recommended:
the node's database does a lot of small reads and writes, and a hard disk makes the first sync and the daily running
noticeably slower.

### Pruning old blocks: what it saves

The node can delete old blocks as new ones arrive (the **Prune old blocks** setting, `auto-prune-keep-n-blocks`). Measured on a
copy of the mainnet chain (block height 7.93 million, from the official snapshot, which is a full-history database):

| Blocks kept | Size of the node's data | Saved |
|---|---|---|
| All (no pruning) | about 10.6 GB | |
| The last 1,000 (about 83 minutes) | about 6.0 GB | 43% |
| The last 16,933 (about 23 hours) | about 6.2 GB | 42% |
| The last 108,172 (about 6 days) | about 6.2 GB | 42% |

- **It saves about 4.4 GB, and it hardly matters how many blocks you keep** (from a thousand to over a hundred thousand gave
  the same size, give or take 0.2 GB). What stays is mostly the current state of the chain, which cannot be pruned. So do not
  keep too few: **we recommend 120,000 blocks, about seven days** (6.9 days at one block per 5 seconds). It costs almost nothing in
  space, and it keeps xelDash able to look up your recent blocks even after a long stop. 120,000 is just above the largest size
  that was measured (108,172), so about 6.2 GB is expected; it was not run separately.
- **The space comes back only after the node restarts.** Right after a prune the folder was still 10.3 to 10.8 GB; after a restart
  it dropped to about 6 GB and stayed there.
- **It prunes only when the chain height is an exact multiple of the number you set.** With 1,000 that is every 83 minutes. With
  **120,000 the first prune can be up to about seven days away** (whenever the height next reaches a multiple of 120,000), and
  then it prunes about once a week; between prunes the node holds between 120,000 and 240,000 blocks. So: set it, apply (the node
  restarts), wait for the first prune (the node's log says "Auto pruning chain"), then restart the node once more to get the space
  back. To see it work sooner, try a small number such as 1,000 first.
- **While it prunes** (about 11 minutes in the test) the node was using about 1.6 GB of memory when sampled right after (the exact peak was not
  recorded), and its folder grew by up to about 2 GB before shrinking. Plan for that headroom on a small computer.
- **It does not lower the 40 GB needed for the first start**: pruning starts after the node has its data. Pruning while syncing
  from nothing (no snapshot) was not measured.
- **It cannot be undone** without downloading a new snapshot, and a pruned node cannot help other nodes sync old blocks.
  Mining works as normal on a pruned node (block templates were checked); a block that your miners found and that the node
  has since pruned away is left as "pending" on the dashboard, because the node can no longer say what became of it.

On Windows and macOS, Docker keeps its data inside a virtual disk that lives on your drive, so the free space that
matters is your computer's drive (xelDash reads it for you and shows it on the Nodes page).

## Memory and processor

Measured on the mainnet stack (one rig mining, two nodes, all services running):

| Service | Memory | Processor (idle, one rig) |
|---|---|---|
| XELIS node | 0.1 to 0.4 GB each, growing as it caches | under 1% of a core |
| Mining server (Stratum) | about 80 MB | under 1% |
| API | about 65 MB | about 2% |
| Database | about 50 MB | about 2% |
| Dashboard web server, node admin | about 20 MB each | under 1% |
| **The whole stack** | **about 0.7 GB with two nodes; roughly half that with one** | a few percent of one core |

Checking a share costs about 830 hash calculations per second per core on a modern desktop processor (a Ryzen 9 7900X in the
test), and uses a pool of threads. A rig normally sends one share every 10 seconds, so a hundred rigs need about
1% of one core. **The mining server will not be your bottleneck.** The heavy work is the node's first sync (validating
blocks), which is why starting from the official snapshot, as xelDash does by default, matters on a small computer.

Not measured yet, so allow room: the peak memory of the node while it unpacks and first syncs. The 4 GB minimum is the whole
computer, with Docker allowed at least 2 GB of it (Docker Desktop on Windows takes half of the computer's memory by
default, which is fine).

## Network

- **Download:** about 9.2 GB on a first start (the snapshot), plus the images (about 1.5 GB), then very little.
- **Running traffic:** about 0.5 GB a day per node (measured: roughly 0.2 GB in and 0.26 GB out), more with more peers.
  Mining shares from your rigs are tiny.
- **Ports** (all on your own network; never forward them on your router): 8088 (dashboard), 3333 (Stratum),
  3334 (Stratum over TLS, optional), 8090 (getwork), and 2125 (the node's peer connections, outbound is enough).
- The computer needs to reach GitHub (release checks and node upgrades) and, on first start, the XELIS snapshot server.
  It does not need a public address or any open port from the internet.

## Operating systems and hardware

| | Status |
|---|---|
| **Windows 10 or 11, 64-bit, Docker Desktop (WSL 2)** | The main tested setup: Windows 10 Pro with Docker Desktop (Docker 29.7, Compose 5.3). Docker Desktop needs virtualization turned on in the BIOS, which most computers already have. |
| **Linux, 64-bit x86, Docker Engine** | The images are the same ones; the launcher's Linux path has only been run in a shell on Windows so far. Needed for a two-server cluster. |
| **macOS (Intel or Apple Silicon), Docker Desktop** | Should work; not tested. |
| **Linux on ARM64 (Raspberry Pi 4 or 5, 64-bit OS)** | The images are published for ARM64, but they have never been run on real hardware. A Pi needs the 8 GB model and an **SSD** (not an SD card). Treat it as experimental until a tester confirms it. |
| 32-bit systems | Not supported. |

xelDash's own code needs no special processor features. The XELIS node is the official upstream one.

Leave the computer on and set it **not to sleep**: Windows updates that restart the computer, and sleep, stop mining
until it is back. If that matters to you, a second Linux server removes the problem (see
[Operations](OPERATIONS.md#redundancy-two-servers)).

## Two servers (redundancy)

Both servers are **Linux with Docker Engine** (Docker Desktop cannot be part of a cluster), on the same home network, each
with the requirements above, plus one unused address on your network for the shared address. The second server runs its own
node, so it needs the same disk space (about 11 GB for the chain, 21 GB at its first start). It has no database, so it
needs less memory than the main server, but give it the same recommended figures.

## Front door

A Linux box with Docker Engine on the same home network, with the requirements above for a second server: its own node (the same disk
space, 11 GB for the chain and 21 GB at its first start) and no database. The main server can be Windows or macOS. It adds a few
megabytes of memory for HAProxy.

## The mining rigs

xelDash does not mine. Your rigs run a mining program (Rigel, SRBMiner, `xelis_miner` and others) on a graphics card or a
processor, on the same computer or on others on your network, and connect to xelDash. What the rigs need depends on the
mining program: the tested one is Rigel 1.23.0 on an NVIDIA RTX 3060 Ti, about 8.7 KH/s on mainnet. The computer running
xelDash does not need a graphics card.

## How these numbers were measured

One computer: a Ryzen 9 7900X (12 cores, 24 threads) with 28 GB given to Docker, Windows 10 Pro, Docker Desktop 29.7, running
the mainnet stack for several days with two nodes and one rig (about 8 KH/s). Memory and processor figures are from
`docker stats` while it mined; disk figures are the volume sizes; traffic is the difference in each node's counters over
2.7 hours. **Nothing has been measured on a low-end computer yet**, so the minimums are cautious rather than proven; the
[pre-release testing list](PRE-RELEASE-TESTING.md) asks for a first start on a 2-core, 4 GB computer and on a Raspberry
Pi to confirm or lower them.
