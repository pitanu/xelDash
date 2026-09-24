FROM node:22-alpine

WORKDIR /app
COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
COPY packages/db/package.json packages/db/package.json
COPY services/api/package.json services/api/package.json
COPY services/daemon-spike/package.json services/daemon-spike/package.json
COPY services/stratum/package.json services/stratum/package.json
RUN npm ci --omit=dev
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY services/api/src services/api/src

ENV NODE_ENV=production
CMD ["npm", "run", "start", "--workspace", "@xeldash/api"]
