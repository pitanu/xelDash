# Devnet verification

How to run the stack on a private devnet and check that Stratum produces blocks the daemon
accepts. Last verified 2026-09-26 with daemon 1.21.3.

## 1. Start the stack

Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`, then run `docker compose up -d --build`.
Devnet has no seed peers, so the daemon creates its own genesis block and chain.

## 2. Mine past the V3 fork

Devnet uses `xel/v1` below height 5 and `xel/v2` below height 15. Stratum only serves
`xel/v3`, so mine the first blocks with the official miner over the daemon's getwork server:

```sh
docker run --rm --name xeldash-bootstrap-miner --network xeldash_backend xelis/miner:1.21.3 \
  --miner-address <devnet address> --daemon-address ws://daemon:8080 \
  --num-threads 16 --disable-interactive-mode
```

Stop it once `get_info` reports height 15 or more. A devnet address starts with `xet:`. The
genesis block's miner address (`get_block_at_topoheight` with `topoheight: 0`) works.

## 3. Mine through Stratum

`services/stratum/scripts/devnet-miner.js` mines through Stratum with the native addon.
For each accepted share it checks that `get_block_by_hash` finds the block under the
BLAKE3 MinerWork hash:

```sh
docker compose run --rm --no-deps \
  -v ./services/stratum/scripts:/app/services/stratum/scripts \
  stratum node services/stratum/scripts/devnet-miner.js <devnet address> 3
```

It prints `OK block <hash> height <n>` per verified block and exits non-zero on any
mismatch. Afterwards, `blocks` and `service_events` should have one row per block.

## Results so far

- Native V3 hash, the 112-byte MinerWork layout, `submit_block`, and the BLAKE3 block hash
  match the daemon: 3 of 3 blocks accepted and found by hash (heights 17 to 19).
- `new_block` subscription works; blocks, service events and shares are recorded.
- Still open: a third-party Stratum miner (for example SRBMiner or lolMiner) against the
  stack, to confirm wire-format compatibility beyond our own test miner.
