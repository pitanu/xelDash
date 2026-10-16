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
| The statistics database | small: about 18 MB after five days with one rig, measured when every share was still stored (it no longer is). Per-minute stats are kept 90 days, hourly stats forever |
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
test), and uses a pool of threads. A rig normally sends one share every 5 seconds, so a hundred rigs need about
2.5% of one core. **The mining server will not be your bottleneck.** The heavy work is the node's first sync (validating
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
- **A public server** (public mode, [Operations](OPERATIONS.md#public-mode)) is the exception: a Linux server with a public
  address and a domain name pointing at it, with ports 80 and 443 (HTTPS), 3333 (Stratum), 8090 (getwork) and optionally 3334
  open to the internet. Size it for the rigs you expect (see below); each rig uses well under a kilobyte a second.

## Operating systems and hardware

| | Status |
|---|---|
| **Windows 10 or 11, 64-bit, Docker Desktop (WSL 2)** | The main tested setup: Windows 10 Pro with Docker Desktop (Docker 29.7, Compose 5.3). Docker Desktop needs virtualization turned on in the BIOS, which most computers already have. |
| **Linux, 64-bit x86, Docker Engine** | The images are the same ones; the launcher's Linux setup step has only been run in a Linux container so far, not on a real Linux computer. Needed for a two-server cluster. |
| **macOS (Intel or Apple Silicon), Docker Desktop** | Should work; not tested. |
| **Linux on ARM64 (Raspberry Pi 4 or 5, 64-bit OS)** | The images are published for ARM64, but they have never been run on real hardware. A Pi needs the 8 GB model and an **SSD** (not an SD card). Treat it as experimental until a tester confirms it. |
| 32-bit systems | Not supported. |

xelDash's own code needs no special processor features. The XELIS node is the official upstream one.

Leave the computer on and set it **not to sleep**: Windows updates that restart the computer, and sleep, stop mining
until it is back. If that matters to you, a second Linux server removes the problem (see
[Operations](OPERATIONS.md#redundancy-two-servers)).

## How many rigs one server carries

A home mining setup has a handful of rigs; even a large one has dozens. xelDash is measured far beyond that, with a capacity test
(`npm run load`) that connects simulated rigs to the real stack on a private devnet. Each rig sends one accepted share every 5 seconds,
XELIS's block time and what Stratum asks of a real rig, and a miner keeps finding blocks in the background, which makes the server
refresh every rig's work.

Measured on the desktop described under [How these numbers were measured](#how-these-numbers-were-measured) (2026-10-13), with blocks found about as
often as on mainnet (11 to 26 a minute; `LOAD_CHAIN_THREADS=8`), each rig sending a share every 5 seconds:

| Rigs | Addresses | Shares per second | Stratum processor use (cores, average / peak) | Time to answer a share (typical / 95% / 99%) |
|---:|---:|---:|---|---|
| 1,000 | 1 | 200 | 0.45 / 0.49 | 3.3 / 4.9 / 55 ms |
| 2,000 | 1 | 400 | 0.87 / 1.07 | 3.4 / 5.5 / 91 ms |
| 3,000 | 1 | 600 | 1.31 / 1.49 | 3.6 / 29 / 148 ms |
| 4,000 | 1 | 800 | 1.72 / 2.00 | 3.9 / 160 / 227 ms |
| 3,000 | 200 | 600 | 1.27 / 1.46 | 3.7 / 13 / 151 ms |
| 4,000 | 200 | 800 | 1.79 / 2.14 | 4.0 / 123 / 221 ms |

No share was stale or rejected at any size, with one address, 200 addresses, or 200 addresses as a public server
(`XELDASH_PUBLIC_MODE`, all limits on), and the node's processor use stayed at about 1% or less. Rigs share their work from
the node: one template per block serves every rig and every address (each rig writes its own extra nonce and miner key into its
copy, and the node takes the miner from the submitted work), so the node is asked a few times per block whatever the number of
rigs or miners. xelDash checks on the running node that its work is the same for every address before sharing between addresses,
and falls back to per-address work if it is not. When one of its own rigs finds a block, Stratum gives every rig new work as soon
as the node accepts it.

What limits a server is the Stratum process: checking shares (spread over a pool of hash threads, so it uses more than one core) and
sending every rig new work on each block. About 3,000 rigs run comfortably on this computer and 4,000 work, with the slowest answers
growing to about a quarter of a second. Before work sharing, the same test was overloaded at 2,000 rigs (answers took up to 16 s) and a
request to the node failed at 4,000. The database (0.7 to 0.8 of a core at 4,000 rigs, 800 rows a second) and the dashboard (about
50 ms to load the overview) were not the limit. A slower computer, a Raspberry Pi, or a mainnet node (which is busier than the devnet
node used here) will carry fewer; the test is in the repository so you can run it on yours.

### Shares per second

The table above counts rigs, and a share every 5 seconds per rig is a small load; what each rig costs most is its work being refreshed.
To measure how many **shares** the server can check and record by themselves, the same test was run with few rigs sending shares very
fast (a share every 0.2 seconds each, 25 times what a real rig sends), every one a valid share that is hashed, checked and written
to the database:

| Shares per second | Rigs sending | Accepted | Time to answer a share (typical / slowest 5%) | Stratum processor use | Database processor use |
|---:|---:|---:|---|---:|---:|
| 250 | 50 | all | 3 ms / 4 ms | about 0.5 core | about 0.2 core |
| 500 | 100 | all | 3 ms / 4 ms | about 1 core | about 0.4 core |
| 1,000 | 200 | all | 4 ms / 7 ms | about 2 cores | about 0.8 core |
| 2,000 | 400 | all | 14 ms / 390 ms | about 4 cores | about 1.8 cores |

The server checked, recorded and answered **2,000 shares a second with none refused or lost** (each answer comes after the share is checked
and written, and the database wrote 2,020 rows a second, as they arrived), on the same computer. Each share costs about 2 ms of processor time,
mostly the hash that proves it is valid work.

**How fast can it check shares at all?** Two more measurements separate the proof of work from the rest:

- The hash alone (the XELIS Hash V3 check, in the native addon, no network or database) takes about 1.3 ms on one thread: about 3,000 shares a
  second with 4 threads, 5,800 with the default 8 (`STRATUM_HASH_THREADS`), 9,200 with 16 and 12,000 with 24. That is the ceiling set by the
  proof of work.
- Stratum itself, with the database switched off (shares are checked and answered, and kept in a journal file), answered **2,000 shares a second
  in about 2 ms** and about 2,900 a second at its limit; above that it fell behind (the time to answer grew to seconds and late shares were
  counted stale), with the hash threads not yet all busy. The profile below found why: the journal, not the thread that handles every
  connection's messages. That limit is gone in the releases after 0.2.0; this measurement is from before, and has not been repeated on this computer.

So on this computer the limit was roughly 3,000 shares a second through Stratum, with the hash able to do about twice that on 8 threads. Real rigs
send far fewer: Stratum asks each one for about a share every 5 seconds, so 3,000 shares a second would be around 15,000 rigs' worth of steady
shares. The rig count above is what limits a server first, not the share rate.

**Where the time goes (profiled).** Stratum was profiled (`node --cpu-prof`, and each thread's processor time) on the small virtual machine
described under [How these numbers were measured](#how-these-numbers-were-measured): 4 cores, with the database, a devnet node and the simulated rigs on the same machine, each rig at
difficulty 1 sending a share a second. Per share, on that processor:

| | Processor time per share | Where it runs |
|---|---:|---|
| The hash (proof of work) | about 3.2 ms | the hash threads (`STRATUM_HASH_THREADS`) |
| Everything else in Stratum: messages, jobs, answers | about 0.5 ms | the one main thread |
| Writing the share to the database, Stratum's side | about 0.3 ms more | the main thread |
| Writing the share, the database's side | about 1.3 ms | PostgreSQL |

- **The main thread is not what fills up first.** At 0.75 ms a share it could handle about 1,300 shares a second here, and it was never more than
  about half busy. The hash and the database together use about six times as much processor time, spread over several cores.
- **With the database switched off, the journal was the limit.** Each share was written to the journal file in turn (opened, written and closed),
  queued behind the hashes on the same thread pool, and its answer waited for that. At 800 shares a second the time to answer grew to 4.4 s with
  about half the computer idle. After 0.2.0, the records that arrive while one write is under way go out together in the next. On the same
  virtual machine, with the database off:

  | Shares per second | Before: typical / slowest 5% | After: typical / slowest 5% |
  |---:|---|---|
  | 500 | 7 ms / 34 ms | 5 ms / 14 ms |
  | 800 | 4,400 ms / 6,100 ms, some late shares counted stale | 12 ms / 52 ms |
  | 1,000 | 5,000 ms / 7,900 ms, many stale | 28 ms / 230 ms |

  It now falls behind at about 1,200 a second on 4 cores, with the hash threads using 3.5 of them: the proof of work is the limit, as it should be.
- **With the database on**, the virtual machine ran out of processor time at about 700 shares a second (the hash, PostgreSQL at about one core, and the
  simulated rigs). More database connections (`DB_POOL_MAX`) or not waiting for the disk on each commit made no difference, which also points to
  processor time. Each share was its own database transaction (three statements, five round trips). After 0.2.0 shares are written in
  batches, and checked for duplicates by their connection instead of by the database, so the answer no longer waits for it. The same
  test before and after, on a desktop (AMD Ryzen 9 7900X, 24 threads, Docker Desktop on Windows, with another xelDash stack running):

  | Shares per second | Time to answer, typical / slowest 5%: before → after | Database processor use: before → after | Stratum: before → after |
  |---:|---|---|---|
  | 500 | 3.1 / 4.0 ms → 1.5 / 1.9 ms | 0.37 → 0.05 core | 0.9 → 0.7 core |
  | 1,000 | 3.4 / 4.5 ms → 1.5 / 1.9 ms | 0.79 → 0.06 core | 1.8 → 1.5 cores |
  | 2,000 | 4.5 / 21.7 ms → 1.6 / 2.2 ms | 1.57 → 0.12 core | 3.6 → 3.0 cores |

  Every share was still accepted and written (2,000 rows a second); the database now does about a thirteenth of the work. Since
  shares are no longer stored one by one either (only counted, migration 009), the same test needs 0.02, 0.02 and 0.05 of a core
  of the database at 500, 1,000 and 2,000 shares a second, with the same answer times.
- **After an outage**, the journal used to be recorded one record at a time: about 540 shares a second on the desktop above. New
  shares go to the journal until it is empty, so a server receiving more than that could fall further behind instead of catching up.
  Shares in the journal are now recorded in batches too: 50,000 of them in 0.9 s (about 56,000 a second) instead of 92 s, with the
  same counts.
- **Metrics** (docs/OPERATIONS.md#metrics) cost nothing measurable: the same test with them on, per-worker metrics included, answered
  in 1.9 / 2.6 ms (typical / slowest 5%) at 2,000 shares a second against 1.9 / 2.7 ms with them off, and Stratum used 3.52 cores
  against 3.51.

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

Two computers. Their numbers depend on the processor and the disk, so compare yours with these before reading them as yours.

| | Desktop | Small virtual machine |
|---|---|---|
| Used for | Everything on this page except the profile: the mainnet figures, the rig and share capacity tables | "Where the time goes": the Stratum profile and the journal before and after (2026-10-13) |
| Processor | AMD Ryzen 9 7900X: 12 cores, 24 threads | Intel Xeon at 2.8 GHz (Skylake or Cascade Lake server class: family 6, model 85; AVX2 and AVX-512): 4 virtual cores, one thread each, 33 MB L3 cache |
| Memory | 28 GB given to Docker (the capacity test reported 31 GB) | 15 GiB |
| Disk | NVMe SSD | A 256 GB virtual disk (virtio); a synchronous 8 KB write takes about 0.5 ms (about 2,000 a second, `dd oflag=dsync`) |
| System | Windows 10 Pro, Docker Desktop 29.7 (WSL 2) | Ubuntu 24.04 in a cloud sandbox virtual machine (KVM, Firecracker), Linux 6.18, Docker Engine 29.8 |
| How xelDash ran | The whole stack in Docker: the mainnet stack for several days with two nodes and one rig (about 8 KH/s), and the capacity test (`npm run load`) | Stratum straight on the machine (Node.js 22.22, `node --cpu-prof`); PostgreSQL 17.11 and a devnet XELIS node 1.25.0 in Docker; the simulated rigs (`test/load/rigs.js`) on the same 4 cores |

The virtual machine's processor is shared with other virtual machines, so its numbers vary more from run to run than a desktop's;
read them as proportions (which part of the work costs what) more than as a capacity.

On the desktop, memory and processor figures are from `docker stats` while it mined; disk figures are the volume sizes; traffic is
the difference in each node's counters over 2.7 hours. **Nothing has been measured on a low-end computer yet**, so the minimums are cautious rather than proven; the
[community testing list](COMMUNITY-TESTING.md) asks for a first start on a 2-core, 4 GB computer and on a Raspberry
Pi to confirm or lower them.
