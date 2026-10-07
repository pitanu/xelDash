# xelDash documentation

**Using xelDash**

| Guide | For |
|-------|-----|
| [System requirements](REQUIREMENTS.md) | Disk, memory, processor, network and operating systems: minimum and recommended, with what was measured |
| [Getting started](GETTING-STARTED.md) | From nothing to mining, for complete beginners: Docker, the installer, your wallet address, the setup guide |
| [Connecting miners](MINERS.md) | Pool URLs, difficulty, tested miners |
| [Operations](OPERATIONS.md) | Alerts, backups and restores, what happens when the database goes down, HTTPS and login, node settings, snapshots, two-server redundancy, the front door, redundant nodes, daemon upgrades, the official node fallback |
| [Security](SECURITY.md) | What is protected, what the admin token can do, remaining risks |
| [Devnet](DEVNET.md) | Trying xelDash without real coins, and how the mining path is verified |

**How it works**

| Document | For |
|----------|-----|
| [Architecture](ARCHITECTURE.md) | Services, protocols, data model and the security model |
| [Community testing](COMMUNITY-TESTING.md) | What still needs testing on real systems, and how to help |

**Per service**

| README | Covers |
|--------|--------|
| [Stratum](../services/stratum/README.md) | Mining protocol, shares, difficulty, node failover, limits, the journal, standby mode |
| [API](../services/api/README.md) | Statistics, effort and luck, status, price, alerts, ingest, updates |
| [Node admin](../services/node-admin/README.md) | Endpoints for node settings, snapshots, control and versions |
| [Daemon image](../docker/daemon/README.md) | The node container and its supervisor |
| [Address manager](../docker/keepalived/README.md) | The cluster's shared-address container (keepalived) |
| [Standby web](../docker/standby-web/README.md) | The second server's page: the main dashboard, or an offline notice |
| [Front door](../docker/frontdoor/README.md) | The HAProxy box miners connect to, and how it chooses a server |

Contributing: [CONTRIBUTING.md](../CONTRIBUTING.md). Changes: [CHANGELOG.md](../CHANGELOG.md).
