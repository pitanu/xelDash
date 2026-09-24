FROM rust:1.90-bookworm AS hash-build

WORKDIR /app/packages/xelis-hash
COPY packages/xelis-hash/Cargo.toml packages/xelis-hash/Cargo.lock packages/xelis-hash/build.rs packages/xelis-hash/rust-toolchain.toml ./
COPY packages/xelis-hash/src ./src
RUN cargo build --locked --release

FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/xelis-hash/package.json packages/xelis-hash/package.json
COPY services/api/package.json services/api/package.json
COPY services/daemon-spike/package.json services/daemon-spike/package.json
COPY services/stratum/package.json services/stratum/package.json
RUN npm ci --omit=dev

COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY packages/xelis-hash/src packages/xelis-hash/src
COPY services/stratum/src services/stratum/src
COPY --from=hash-build /app/packages/xelis-hash/target/release/libindex.so packages/xelis-hash/index.node

ENV NODE_ENV=production
CMD ["npm", "run", "start", "--workspace", "@xeldash/stratum"]
