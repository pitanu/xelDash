FROM node:22-alpine
# Info-ZIP unzip handles ZIP64 archives (the official snapshot is over 4 GB) and checks CRCs.
RUN apk add --no-cache unzip
WORKDIR /app
COPY services/snapshot/package.json ./
COPY services/snapshot/src ./src
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
