# XELIS daemon

Compose builds a thin wrapper around the official `xelis/daemon` image. The wrapper only adds
a static busybox, because the upstream image has no shell or HTTP client for the
healthcheck. The healthcheck calls `get_version` over JSON-RPC.

The image is pinned with `XELIS_DAEMON_IMAGE`, and the tested release is 1.21.3. Releases
1.22.0 through 1.25.0 (and `latest`) exit immediately: their binary needs glibc 2.38+, which
their base image lacks. To upgrade:

1. Check that the new tag starts with `docker run --rm <tag> --help`.
2. Run the devnet check in [docs/DEVNET.md](../../docs/DEVNET.md).
3. Update the pin in `.env.example`, `docker-compose.yml` and the Dockerfile.

The hash addon must support the release's PoW algorithm.

The container receives the selected
network and listens for RPC on the internal Compose network. Only P2P port 2125 is
published to the host; do not publish RPC port 8080.

The daemon data directory uses the `/root/.xelis` path from the working prototype and is
stored in the named `xelis-data` volume. Each network's data remains under that persistent
base directory.
