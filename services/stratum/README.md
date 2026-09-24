# Stratum service

This directory contains the first protocol layer for the miner-facing XELIS Stratum
endpoint:

- newline-delimited JSON-RPC framing with a 64 KiB line limit;
- algorithm negotiation for current `xel/v3` and legacy algorithm aliases;
- session handling for subscribe, authorize, submit, and reported hashrate;
- daemon-backed address validation/public-key extraction and PostgreSQL worker registration.

The server is not yet wired into Compose. A usable mining endpoint still needs the daemon
job source, XELIS V3 hash verification, share difficulty validation, and solved-block
submission. `mining.submit` fails closed when there is no active job; it never counts an
unverified nonce as an accepted share. The wire format follows the
[XELIS Stratum protocol](https://docs.xelis.io/developers-api/stratum). The daemon methods
used for address checks are documented in the [Daemon API](https://docs.xelis.io/developers-api/daemon).
