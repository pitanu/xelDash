# Devnet verification

How to run the stack on a private devnet and check that Stratum produces blocks the daemon
accepts. Last verified 2026-09-26 with daemon 1.25.0 (and earlier with 1.21.3).

## 1. Start the stack

Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`, `XELIS_NETWORK=devnet` and
`XELIS_SNAPSHOT_AUTO=false` (the defaults are for mainnet). Or let the launcher do it:
`./xeldash.sh install --network devnet` (`xeldash install --network devnet` on Windows). Then run
`docker compose up -d --build` (the launcher does this too).
Devnet has no seed peers, so the daemon creates its own genesis block and chain.

A devnet chain made by one daemon release may not load in a release with different devnet
fork heights (1.22.0 added V6 at height 30). To start over, run `docker compose down -v`.
This also deletes the database.

## 2. Mine past the V3 fork

Devnet uses `xel/v1` below height 5 and `xel/v2` below height 15. Stratum only serves
`xel/v3`, so mine the first blocks with the official miner over the daemon's getwork server.
Use the 1.21.3 miner image: images from 1.22.0 onward fail to start (see
[docker/daemon/README.md](../docker/daemon/README.md)), and 1.21.3 mines fine against a 1.25.0
daemon.

```sh
docker run --rm --name xeldash-bootstrap-miner --network xeldash_node xelis/miner:1.21.3 \
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

## Getwork check

The official miner can also mine through xelDash's getwork endpoint instead of the daemon:

```sh
docker run --rm --network xeldash_node xelis/miner:1.21.3 \
  --miner-address <devnet address> --daemon-address ws://stratum:8090 \
  --worker official-miner --num-threads 4 --disable-interactive-mode
```

Its shares then appear under that worker on the dashboard.

## Two-node check

Devnet nodes generate their own genesis block, so a second devnet node must be given the
first node's genesis (printed as "Genesis generated: <hex>" when the chain was created)
and should keep reconnecting to it. Use a local override file, not the main Compose file:

```yaml
# redundant-devnet.yml
services:
  daemon2:
    command:
      - --network=devnet
      - --rpc-bind-address=0.0.0.0:8080
      - --dir-path=/root/.xelis/
      - --genesis-block-hex=<genesis hex>
      - --exclusive-nodes=daemon:2125
```

```sh
COMPOSE_PROFILES=redundant XELIS_RPC_URLS=http://daemon:8080/json_rpc,http://daemon2:8080/json_rpc \
  docker compose -f docker-compose.yml -f redundant-devnet.yml up -d
```

Run the Stratum check with `-e XELIS_RPC_URL=http://daemon2:8080/json_rpc` (so its block
verification does not depend on `daemon`), then stop and start `daemon` while it mines.

## Results so far

- Two nodes (2026-09-26): mining continued through `docker compose stop daemon` and start;
  14 of 14 blocks verified, no miner disconnects. Failover took about 8 seconds and failback
  about 6; a block found on a job from the stopped node was submitted through `daemon2`.
- Getwork (2026-09-26): official xelis_miner 1.21.3 through port 8090. 38 blocks accepted,
  all found by hash in the daemon. With a lower share target, 78 shares and 5 blocks were
  recorded and the miner reported exactly 5 accepted blocks.
- Daemon 1.25.0: 5 of 5 Stratum blocks verified at block version 6 (heights 33 to 37), all
  finalized as `main-chain` with rewards.
- Native V3 hash, the 112-byte MinerWork layout, `submit_block`, and the BLAKE3 block hash
  match the daemon: 3 of 3 blocks accepted and found by hash (heights 17 to 19).
- `new_block` subscription works; blocks, service events and shares are recorded.
- Rigel 1.23.0 has mined on mainnet through Stratum; SRBMiner and lolMiner have not been tested.
