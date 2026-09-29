FROM node:22-alpine
# Info-ZIP unzip handles ZIP64 archives (the official snapshot is over 4 GB) and checks CRCs.
RUN apk add --no-cache unzip
WORKDIR /app
COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
COPY packages/db/package.json packages/db/package.json
COPY packages/xelis-hash/package.json packages/xelis-hash/package.json
COPY services/api/package.json services/api/package.json
COPY services/stratum/package.json services/stratum/package.json
COPY services/node-admin/package.json services/node-admin/package.json
RUN npm ci --omit=dev --workspace @xeldash/node-admin
COPY packages/db/src packages/db/src
COPY services/node-admin/src services/node-admin/src
ENV NODE_ENV=production
# Runs as root: it owns files on the nodes' data volumes, like the daemon containers.
CMD ["node", "services/node-admin/src/server.js"]
