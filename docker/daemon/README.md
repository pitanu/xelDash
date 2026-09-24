# XELIS daemon

Compose uses the official `xelis/daemon` image. The container receives the selected
network and listens for RPC on the internal Compose network. Only P2P port 2125 is
published to the host; do not publish RPC port 8080.

The daemon data directory uses the `/root/.xelis` path from the working prototype and is
stored in the named `xelis-data` volume. Each network's data remains under that persistent
base directory.
