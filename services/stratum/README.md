# Stratum service

This directory contains the first protocol layer for the miner-facing XELIS Stratum
endpoint:

- newline-delimited JSON-RPC framing with a 64 KiB line limit;
- algorithm negotiation for current `xel/v3` and legacy algorithm aliases;
- session handling for subscribe, authorize, submit, and reported hashrate;
- daemon-backed address validation/public-key extraction and PostgreSQL worker registration;
- address-specific daemon templates, Stratum job refresh, V3 hash validation, fixed target
  difficulty, share persistence, and network-target block submission.

The service is available in Compose on port 3333, bound to loopback by default. Set
`XELDASH_STRATUM_BIND_IP` to the host's LAN address to accept miners from the LAN. The
default fixed share difficulty is 1,000,000 and is capped at the job's network difficulty;
vardiff is not implemented yet. Jobs are refreshed by polling the daemon for templates.

Only `xel/v3` jobs are currently accepted. A mining submission is hashed from the official
112-byte Stratum MinerWork layout, compared against both its share target and network
target, then recorded in PostgreSQL. Work at network difficulty is submitted to the local
daemon. Known-good miner-vector comparison and end-to-end devnet block submission remain
to be verified. The wire format follows the
[XELIS Stratum protocol](https://docs.xelis.io/developers-api/stratum). The daemon methods
used for address checks are documented in the [Daemon API](https://docs.xelis.io/developers-api/daemon).
