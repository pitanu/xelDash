# Phase 1 spike

## Implemented

- Initial npm workspace with JavaScript, JSDoc types, and TypeScript `checkJs` validation.
- `@xeldash/daemon-spike` JSON-RPC client with bounded request timeouts and JSON-RPC error handling.
- Template inspection script that queries node height, network difficulty, and a template for `XELIS_DEFAULT_ADDRESS`.
- Client methods for `get_miner_work` and `submit_block` to support the next end-to-end spike step.
- Initial Stratum protocol layer: bounded newline framing, JSON-RPC request parsing, XELIS algorithm alias negotiation, and session handling for subscribe/authorize/submit/reported hashrate.
- Stratum address authorization uses daemon `validate_address` and `extract_key_from_address`, then persists the worker identity in PostgreSQL.
- Native addon boundary for official XELIS Hash V3, pinned to an upstream commit and built in a Rust container stage.
- Stratum obtains per-address block templates and miner work, notifies miners, polls for changed jobs, validates share/network difficulty, persists share measurements, and submits network-target work to the local daemon.
- Compose builds and runs the Stratum service with its native hash addon; miner and RPC ports are loopback-bound by default.

The JSON-RPC endpoint is private to the Compose network by default. To run this spike from
the host, start the daemon with the development overlay, which publishes RPC only on
loopback, then set the host-side RPC URL:

```sh
npm ci
# In PowerShell, set these for the current terminal session.
$env:XELIS_DEFAULT_ADDRESS = "your-address-for-this-network"
$env:XELIS_RPC_URL = "http://127.0.0.1:8080/json_rpc"
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d daemon
npm run spike:template
```

Do not expose daemon RPC on a LAN or public interface. The development overlay binds it to
`127.0.0.1` only and should not be used on a host where loopback forwarding is not trusted.

## Still to prove

- Start and sync the official daemon on devnet in Docker.
- Confirm an address-specific template and miner-work response from that daemon build.
- Verify the generated MinerWork bytes and hash against known-good miner vectors.
- Confirm daemon acceptance of block submissions from the Stratum MinerWork representation.
- Find a devnet block and confirm its status through daemon events.

The [Stratum protocol](https://docs.xelis.io/developers-api/stratum) lists `xel/v3` as the
current algorithm identifier and defines aliases `xel/2` for V3 and `xel/1` for V2. The
daemon client still reports the daemon's algorithm unchanged; algorithm selection for
Stratum is negotiated independently. The daemon's mining-work format and submission path
still need confirmation against the selected daemon image before issuing jobs.
