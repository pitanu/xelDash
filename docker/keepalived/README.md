# Address manager (keepalived)

Holds the shared address of a two-server cluster. Linux with Docker Engine only: it runs on host networking with
`NET_ADMIN`, `NET_BROADCAST` and `NET_RAW`, so it can add the address to the computer's network card. Docker Desktop
(Windows, macOS) cannot do this. Added by `docker-compose.cluster.yml` (main server) and `docker-compose.standby.yml`
(second server); set up with `./xeldash.sh cluster setup` and `cluster join`.

- `entrypoint.sh` writes keepalived's configuration from `XELDASH_VIP` (with prefix), `XELDASH_CLUSTER_ID`,
  `XELDASH_VIP_INTERFACE` (found from the default route when empty) and `XELDASH_CLUSTER_PRIORITY` (100 on both servers).
  Both servers start as standby; the first up takes the address, and `nopreempt` means a server that comes back stands by
  instead of taking it back.
- `check.sh` is the health check, every 2 seconds: Stratum's `/healthz` on loopback (`XELDASH_STRATUM_HEALTH_PORT`), which is
  200 while a node is ready to give work. Three failures in a row make this server give the address up, so it moves to a
  server that can really mine; two successes bring the server back as a standby.
- `notify.sh` writes the role (`MASTER`, `BACKUP`, `FAULT`) to `/config/cluster.json` on the shared config volume, where
  node-admin reads it for the dashboard and for failover events.

Tested in simulation with two containers on a bridge network: the address moved in about 3 seconds when a server was killed,
in about 8 when its health check failed, and a returning server did not take it back. It has not been run on a real network;
see [docs/PRE-RELEASE-TESTING.md](../../docs/PRE-RELEASE-TESTING.md). VRRP has no strong authentication, which is covered in
[docs/SECURITY.md](../../docs/SECURITY.md).
