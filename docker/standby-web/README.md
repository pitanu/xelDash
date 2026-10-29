# Standby web

The web page of the second server in a two-server cluster (`docker-compose.standby.yml`). The second server has no database
and no dashboard of its own, so this nginx:

- proxies everything to the main server's dashboard (`PRIMARY_URL`), including its live-update WebSocket, while the main
  server answers;
- shows `offline.html` when it does not: "Dashboard offline. Mining continues on this backup server", with the rigs connected
  and the records waiting to be sent, read from Stratum's `/status` through `/standby/status.json`. The page asks
  `/standby/primary` every few seconds and reloads itself when the main dashboard is back;
- answers `/api/` requests with a 503 `dependency_unavailable` while the main server is away, as a dashboard behind a
  database that is down would.

`PRIMARY_URL` and `STANDBY_STATUS_URL` come from the environment (nginx's template step). It answers only to the host names the
dashboard does (the dashboard's own `docker/web/42-allowed-hosts.sh`, from `XELDASH_CONNECT_HOST`, `XELDASH_PUBLIC_DOMAIN`,
`XELDASH_PROXY_HOST` and `XELDASH_ALLOWED_HOSTS`) and gives any other "421 Misdirected Request", so a website pointing its own
domain at this server cannot read it through a visitor's browser. That script is why the image is built from the repository root. The page is plain HTML with one inline
script, and is served without the main dashboard's strict content security policy.

With a public main server (public mode), this page proxies the main server's public dashboard, so visitors get the same
public view; the offline page's rig count comes from a `/status` that leaves out the front door's addresses. The main server's
HTTPS (`public-https`) does not move here: while the main server is away, visitors reach this page over plain HTTP only.
