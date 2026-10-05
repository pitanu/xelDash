FROM node:26-alpine AS build

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/index.html web/vite.config.js ./
COPY web/src ./src
COPY web/public ./public
RUN npm run build

FROM nginx:1.31-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --chmod=755 docker/web/40-allowed-networks.sh /docker-entrypoint.d/40-allowed-networks.sh
COPY --from=build /web/dist /usr/share/nginx/html
