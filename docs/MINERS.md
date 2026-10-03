# Connecting miners

The easiest way: open the dashboard's **Get started** page (`#/setup`). It shows your server's real
address and port, your wallet address, and a ready-made command for each miner, each with a copy
button.

By hand: use your own XELIS address as the user name. The worker name is optional but shows up on
the dashboard, so name each rig. Miners that have a single "user" or "wallet" field can send
`address.worker` (for example `xel:abc....rig1`); xelDash splits it at the dot.

| Miner type | Pool URL | User / worker |
|------------|----------|---------------|
| Stratum (Rigel, SRBMiner, lolMiner, ...) | `stratum+tcp://<host>:3333` | `<your xel: address>` / `<rig name>` |
| Stratum over TLS (if enabled) | `stratum+ssl://<host>:3334` | same |
| Official `xelis_miner` (getwork) | `--daemon-address ws://<host>:8090 --miner-address <address> --worker <rig>` | |

`<host>` is the machine running xelDash. The miner's own address is what gets paid: xelDash
never holds funds, so rewards go straight to the address in the miner's settings.

## With two servers

If you run a two-server cluster (`./xeldash.sh cluster setup`; see [Operations](OPERATIONS.md#redundancy-two-servers)), point
every miner at the **shared address** the setup printed, not at either server's own address, and use the same settings
as above. The shared address always leads to the server that can mine, so a rig needs no second pool entry and no change
when a server fails or restarts. Rigs reconnect by themselves within seconds.

## Example: Rigel

```sh
rigel -a xelishashv3 -o stratum+tcp://192.168.1.10:3333 -u xel:YOUR_ADDRESS -w rig1
```

## Difficulty

Share difficulty adjusts to each rig automatically (one share about every 10 seconds). To fix
it instead, put `d=<difficulty>` in the Stratum password, for example `-p d=50000`. It is
never set below `STRATUM_MIN_DIFFICULTY`. A fixed difficulty helps GPUs that dislike
retargeting; a good value gives one share every few seconds.

## Which miners are tested

| Miner | Protocol | Status |
|-------|----------|--------|
| Rigel 1.23.0 | Stratum | Tested on mainnet with a GPU |
| `xelis_miner` 1.21.3 | Getwork | Tested on devnet |
| xelDash test miner | Stratum, TLS | Tested on devnet and mainnet |
| SRBMiner-MULTI, BzMiner, OneZeroMiner, lolMiner | Stratum | **Not tested** (see below) |

**Miners not tested yet.** SRBMiner-MULTI, BzMiner and OneZeroMiner list XELIS (`xelishashv3`) in their own documentation, and their example
settings are below, adapted to xelDash. They have **not** been run against xelDash, so treat them as a starting point and tell us what
happens. (An attempt to try them on the maintainer's Windows computer was cut short: the SRBMiner and lolMiner programs disappeared right after
they were unpacked, most likely removed by Windows Defender, which often flags mining programs; OneZeroMiner disappeared after its first
run; and an unattended try with BzMiner did not connect, for a reason that was not looked into.) Replace `HOST` with this server's address and `YOUR_ADDRESS` with your wallet address:

```
SRBMiner-MULTI.exe --algorithm xelishashv3 --pool HOST:3333 --wallet YOUR_ADDRESS --worker rig1 --password x
bzminer.exe -a xelis -p stratum+tcp://HOST:3333 -w YOUR_ADDRESS --pass x --worker rig1
onezerominer.exe -a xelis -o stratum+tcp://HOST:3333 -w YOUR_ADDRESS --worker rig1
```

Use the miner's own help for the exact option names if one of these is refused (versions differ), and do not run the `.bat` examples
that come with a miner without editing them: they contain the miner author's own wallet address. lolMiner's release notes do not mention
XELIS, and it could not be checked, so do not count on it.

Miners that follow the [XELIS Stratum protocol](https://docs.xelis.io/developers-api/stratum)
should work. If yours does not, or you have tried one that is not listed, please open a
"Miner compatibility report" issue; it helps a lot.

## Things that look odd but are fine

- **The miner says "block found" for every share** on getwork: the official miner does that
  for each share it submits. Only real blocks are submitted to the node.
- **A few stale shares** right after each block. Blocks come every 5 seconds or so, so a GPU's
  in-flight work arrives just late. xelDash still accepts shares on the previous job for
  1.5 seconds (`STRATUM_STALE_GRACE_MS`); later ones are counted as stale.
- **The dashboard hashrate differs a little from the miner's own.** It is estimated from the
  shares that were accepted, which are random; the miner's figure is what it computes. Over
  an hour they agree closely.
- **No blocks for a long time.** Solo mining pays in whole blocks at random times. The
  dashboard's expected time to a block, current effort and luck show where you stand;
  a round of 200% effort is not unusual.

## Behind the scenes

- Every share is checked with the official XELIS Hash V3 code before it counts.
- Work for each miner is built for that miner's own address, so found blocks pay it directly.
- Limits per IP (connections, message rate, invalid shares) keep a broken or hostile client
  from affecting other miners; see [Security](SECURITY.md).
- The Stratum service's details are in its [README](../services/stratum/README.md).
