# Connecting miners

The easiest way: open the dashboard's **Connect** page (`#/connect`; **Mine here** for a public server's visitors). It shows
your server's real address and port, your wallet address, and a ready-made command for each miner, each with a copy button,
then lists your workers as they connect. The **Get started** page (`#/setup`) shows the same settings during a first install.

Point miners at the Stratum port it shows (3333 by default), not the dashboard's port: the dashboard does not take miners.

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

Share difficulty adjusts to each rig automatically (one share about every 5 seconds, the block time). To fix
it instead, put `d=<difficulty>` in the Stratum password, for example `-p d=50000`. It is
never set below `STRATUM_MIN_DIFFICULTY`. A fixed difficulty helps GPUs that dislike
retargeting; a good value gives one share every few seconds.

## Which miners are tested

| Miner | Protocol | Status |
|-------|----------|--------|
| Rigel 1.23.0 | Stratum | Tested on mainnet with a GPU; also reported working by a community tester |
| `xelis_miner` 1.21.3 | Getwork | Tested on devnet |
| xelDash test miner (a development tool, not for mining) | Stratum, TLS | Tested on devnet |
| SRBMiner-MULTI | Stratum | **Reported working** by a community tester on Linux; on the maintainer's Windows tries (3.0.6, 3.7.1) no shares were seen; see below |
| OneZeroMiner | Stratum | **Reported working** by a community tester on Linux |
| ForgeMiner | Stratum | **Reported working** by a community tester on Linux |
| BzMiner, lolMiner | Stratum | **Not tested** (see below) |

"Reported working": a community tester mined with it through xelDash 0.1.0 on Lubuntu (miner versions not given). A
[miner compatibility report](https://github.com/pitanu/xelDash/issues/new?template=miner_compatibility.yml) with the version and
settings you used makes an entry firmer.

**SRBMiner-MULTI.** A community tester reports it working through xelDash on Linux (Lubuntu). On the maintainer's Windows computer it
was tried on mainnet with a GPU and a processor (3.7.1, and the older 3.0.6). It connects, logs in and is sent
jobs, and its console shows them arriving, but in every try it stopped hashing within about ten seconds and **never sent a share**: not
one accepted or rejected share was recorded. The traffic was recorded and matches the
[XELIS Stratum specification](https://docs.xelis.io/developers-api/stratum), and Rigel and `xelis_miner` work with the same server, so the
cause is not known: it may be something in SRBMiner, or something xelDash sends it that the specification does not cover. It does show
that SRBMiner logs in with `solo:` before the address and, when it reconnects, sends a session id where the specification has the
algorithm list; xelDash accepts both since this version (before it, SRBMiner could not even log in). It also takes a 1.5% fee. Use
`--algorithm xelishashv3 --pool HOST:3333 --wallet YOUR_ADDRESS --worker rig1 --password x`, and please report what you see.

**Other miners.** BzMiner and OneZeroMiner list XELIS (`xelishashv3`) in their own documentation, and their example
settings are below, adapted to xelDash. OneZeroMiner has since been reported working by a community tester; BzMiner has **not** been
run against xelDash, so treat its line as a starting point and tell us what happens. (An attempt to try them on the maintainer's Windows computer was cut short: the programs disappeared right after unpacking or
after their first run, most likely removed by Windows Defender, which often flags mining programs, and an unattended try with BzMiner
did not connect, for a reason that was not looked into.) Replace `HOST` with this server's address and `YOUR_ADDRESS` with your
wallet address:

```
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
- Each rig's work carries the key of the address it logged in with, so a block it finds pays that address directly.
- Limits per IP (connections, message rate, invalid shares) keep a broken or hostile client
  from affecting other miners; see [Security](SECURITY.md).
- The Stratum service's details are in its [README](../services/stratum/README.md).
