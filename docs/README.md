# xelDash documentation

**Using xelDash**

| Guide | For |
|-------|-----|
| [Getting started](GETTING-STARTED.md) | From nothing to mining, for complete beginners: Docker, the installer, your wallet address, the setup guide |
| [Connecting miners](MINERS.md) | Pool URLs, difficulty, tested miners |
| [Operations](OPERATIONS.md) | Alerts, backups and restores, HTTPS and login, node settings, snapshots, redundant nodes, daemon upgrades, the official node fallback |
| [Security](SECURITY.md) | What is protected, what the admin token can do, remaining risks |
| [Devnet](DEVNET.md) | Trying xelDash without real coins, and how the mining path is verified |

**How it works**

| Document | For |
|----------|-----|
| [Architecture](ARCHITECTURE.md) | Services, protocols, data model and the security model |
| [Pre-release testing](PRE-RELEASE-TESTING.md) | What still needs testing on real systems, for testers |

**Per service**

| README | Covers |
|--------|--------|
| [Stratum](../services/stratum/README.md) | Mining protocol, shares, difficulty, node failover, limits |
| [API](../services/api/README.md) | Statistics, effort and luck, status, price |
| [Node admin](../services/node-admin/README.md) | Endpoints for node settings, snapshots, control and versions |
| [Daemon image](../docker/daemon/README.md) | The node container and its supervisor |

Contributing: [CONTRIBUTING.md](../CONTRIBUTING.md). Changes: [CHANGELOG.md](../CHANGELOG.md).
