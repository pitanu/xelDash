# Dashboard

React, Vite and Tailwind. The Compose `web` service builds it and serves it with nginx on
port 8088 (loopback by default), proxying `/api` to the API service.

Pages: Overview (`#/`), Miner (`#/miner/<address>`) and Blocks (`#/blocks`). Data refreshes
every 15 seconds. There is no login; like the API, the dashboard is meant for your LAN only.

Local development against a running stack:

```sh
cd web
npm install
npm run dev   # proxies /api to http://127.0.0.1:8081; override with XELDASH_API_URL
```

Colors are role tokens in `src/index.css` with separate light and dark values. Block status
colors are reserved for status and always appear with an icon and a label.
