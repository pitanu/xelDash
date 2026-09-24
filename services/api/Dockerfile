FROM node:22-alpine

WORKDIR /app
COPY package.json ./package.json
COPY packages/db/package.json packages/db/package.json
COPY services/api/package.json services/api/package.json
RUN npm install --omit=dev
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY services/api/src services/api/src

ENV NODE_ENV=production
CMD ["npm", "run", "start", "--workspace", "@xeldash/api"]
