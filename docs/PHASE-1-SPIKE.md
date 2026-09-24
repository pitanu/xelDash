# Phase 1 spike

## Implemented

- Initial npm workspace and strict TypeScript configuration.
- `@xeldash/daemon-spike` JSON-RPC client with bounded request timeouts and JSON-RPC error handling.
- Template inspection script that queries node height, network difficulty, and a template for `XELIS_DEFAULT_ADDRESS`.
- Client methods for `get_miner_work` and `submit_block` to support the next end-to-end spike step.
- Initial Stratum protocol layer: bounded newline framing, JSON-RPC request parsing, XELIS algorithm alias negotiation, and session handling for subscribe/authorize/submit/reported hashrate.
- Stratum address authorization uses daemon `validate_address` and `extract_key_from_address`, then persists the worker identity in PostgreSQL.
- Stratum submissions fail closed while no active validated job exists. This layer is not yet exposed as a running Compose service.

Run after installing workspace dependencies and starting a daemon reachable at `XELIS_RPC_URL`:

```sh
npm install
# Set XELIS_DEFAULT_ADDRESS and XELIS_RPC_URL in the environment.
npm run spike:template
```

## Still to prove

- Start and sync the official daemon on devnet in Docker.
- Confirm an address-specific template and miner-work response from that daemon build.
- Connect daemon templates/jobs to Stratum notifications and submissions; validate every nonce with XELIS Hash V3 before recording it.
- Integrate the XELIS V3 hash implementation and verify it against known-good miner vectors.
- Find a devnet block and submit it, confirming its final status through daemon events.

The [Stratum protocol](https://docs.xelis.io/developers-api/stratum) lists `xel/v3` as the
current algorithm identifier and defines aliases `xel/2` for V3 and `xel/1` for V2. The
daemon client still reports the daemon's algorithm unchanged; algorithm selection for
Stratum is negotiated independently. The daemon's mining-work format and submission path
still need confirmation against the selected daemon image before issuing jobs.
