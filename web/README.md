# Dashboard

React, Vite and Tailwind. The Compose `web` service builds it and serves it with nginx on
port 8088 (loopback by default), proxying `/api` to the API service.

Pages: Overview (`#/`), Miner (`#/miner/<address>`), Worker
(`#/miner/<address>/worker/<name>`), Blocks (`#/blocks`) and Health (`#/health`). There is
no login; like the API, the dashboard is meant for your LAN only.

Updates arrive live over the `/api/v1/live` WebSocket (nginx proxies the upgrade), which
triggers a refetch of the affected data. The header shows "Live" or "Polling"; without the
socket, pages refresh every 15 seconds.

Local development against a running stack:

```sh
cd web
npm install
npm run dev   # proxies /api to http://127.0.0.1:8081; override with XELDASH_API_URL
```

Colors are role tokens in `src/index.css` with separate light and dark values. Block status
colors are reserved for status and always appear with an icon and a label.
