# frontdoor

HAProxy in TCP mode, for the "front door" setup (`xeldash frontdoor join`, see
[OPERATIONS](../../docs/OPERATIONS.md#front-door-a-box-miners-connect-to)). Miners connect to this box on 3333 (Stratum) and
8090 (getwork). Each connection goes to the main server while its `GET /api/v1/mining-health` answers 200, and to the standby
Stratum on this box otherwise. Both are sent a PROXY protocol line, so Stratum still sees the real miner address
(`STRATUM_PROXY_FROM`, see [SECURITY](../../docs/SECURITY.md)).

`entrypoint.sh` checks its environment (`FRONTDOOR_MAIN_HOST`, `FRONTDOOR_MAIN_HEALTH_PORT`, `FRONTDOOR_MAIN_STRATUM_PORT`,
`FRONTDOOR_MAIN_GETWORK_PORT`, `FRONTDOOR_STANDBY_HOST`), writes the configuration and starts HAProxy. The TLS port is not
forwarded. A miner already connected to a server that stops mining is dropped when the server closes the connection, and
reconnects to whichever is chosen then.
