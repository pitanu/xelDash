# XELIS daemon

Compose runs the official daemon binary. It is copied unchanged out of the `xelis/daemon`
image onto `gcr.io/distroless/cc-debian13`, and a static busybox is added for the
healthcheck. The healthcheck calls `get_version` over JSON-RPC.

**Why the binary is re-based.** Since 1.22.0 the upstream Dockerfile compiles on
`cargo-chef:…-slim-trixie` (Debian 13, glibc 2.41) but still ships on
`distroless/cc-debian12` (glibc 2.36). The binary needs `GLIBC_2.38` and `GLIBC_2.39`, so
the official images from 1.22.0 onward, including `latest`, exit on start. The change came
from upstream commit `99599508` (2026-05-17). The official `xelis/miner` and
`xelis/wallet` images have the same problem. Upstream fixed it in commit `f6ea12c`
(2026-09-27), which ships on `cc-debian13`; the first release after it will run as
published (as of 2026-10-07 the newest release, 1.25.0, is older than the fix). The re-base stays harmless with fixed images, and the wrapper is still needed for
busybox and the supervisor in `entrypoint.sh`.

**Mainnet needs 1.24.0 or newer.** Mainnet activated block version 6 at height 6,199,855 and
the V7 emergency hard fork at 6,909,122, which requires 1.24.0 or newer. Older daemons
cannot follow the chain.

The entrypoint (`entrypoint.sh`) is a small supervisor that node-admin drives through files
under `.xeldash/` on the data volume (the full list is at the top of the script). It:

- waits during a first-start snapshot download, and on restart swaps a staged snapshot (or
  a copy from the other node) in, keeping the old database as `<network>.previous`;
- applies dashboard settings after checking them with the daemon's parser, and puts them
  back if the daemon exits within 30 seconds;
- runs a downloaded release (`.xeldash/bin/<version>/xelis_daemon`) instead of the image's
  daemon when one is selected, checking it with `--version` first and switching back if it
  exits within 30 seconds;
- restarts, or stays stopped until started, on request (the healthcheck passes while stopped
  or bootstrapping, so dependents are not held up);
- resolves host names in `--priority-nodes`/`--exclusive-nodes` to addresses, since the
  daemon ignores names.

The pin is `XELIS_DAEMON_IMAGE`, and the tested release is 1.25.0. A release chosen on the
dashboard takes precedence over the image until **Back to the image's version**. To upgrade
the image:

1. Build the wrapper with the new tag and check that it starts (`--version`).
2. Run the devnet check in [docs/DEVNET.md](../../docs/DEVNET.md).
3. Update the pin in `.env.example`, `docker-compose.yml` and the Dockerfile.

The hash addon must support the release's PoW algorithm (`xel/v3` through block version 7).

The container receives the selected network and listens for RPC on the internal Compose
network. Only P2P port 2125 is published to the host; do not publish RPC port 8080.

The daemon data directory uses the `/root/.xelis` path from the working prototype and is
stored in the named `xelis-data` volume. Each network's data remains under that persistent
base directory.
