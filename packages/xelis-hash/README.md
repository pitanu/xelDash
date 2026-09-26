# XELIS Hash V3 native addon

This package exposes the official Rust XELIS Hash V3 implementation to Node.js through
N-API. It accepts the 112-byte MinerWork payload used by the XELIS Stratum protocol and
returns the 32-byte PoW hash.

- `hashMinerWorkAsync` runs on the libuv thread pool and returns a Promise; Stratum uses it
  so hashing does not block other connections.
- `hashMinerWork` hashes on the calling thread.

Each thread keeps one ~543 KB V3 scratchpad instead of allocating one per hash. The thread
pool has 4 threads by default; set `UV_THREADPOOL_SIZE` to hash more shares in parallel.

It does not construct miner work, interpret difficulty, or
submit blocks; those remain responsibilities of the stratum job pipeline.

The upstream `xelis-hash` crate is pinned to version `0.1.0`, with only its `v3` feature
enabled. Build the platform addon with:

```sh
npm install
npm run build --workspace @xeldash/xelis-hash
```

The locked native dependency set currently requires Rust 1.88 or newer; use Rust 1.90 for
the repository's checked build toolchain.

The addon is built for the current platform and architecture. Docker images must build it
for the target runtime architecture before starting Stratum. The upstream implementation
is pinned to commit `f48262b931438fdbf2932711613e020c02f1ea04` from
[`xelis-project/xelis-hash`](https://github.com/xelis-project/xelis-hash), under its MIT
license.
