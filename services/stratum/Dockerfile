# The native hash addon is compiled on the build machine's own architecture and
# cross-compiled for the target, so multi-arch builds do not run rustc under emulation.
# Debian bookworm on both sides keeps the addon's glibc requirement at 2.36.
FROM --platform=$BUILDPLATFORM rust:1.90-bookworm AS hash-build
ARG TARGETARCH

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) triple=x86_64-unknown-linux-gnu; cross="gcc-x86-64-linux-gnu libc6-dev-amd64-cross" ;; \
      arm64) triple=aarch64-unknown-linux-gnu; cross="gcc-aarch64-linux-gnu libc6-dev-arm64-cross" ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    if [ "$(dpkg --print-architecture)" != "$TARGETARCH" ]; then \
      apt-get update && apt-get install -y --no-install-recommends $cross && rm -rf /var/lib/apt/lists/*; \
    fi; \
    echo "$triple" > /tmp/rust-target

ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc

WORKDIR /app/packages/xelis-hash
COPY packages/xelis-hash/Cargo.toml packages/xelis-hash/Cargo.lock packages/xelis-hash/build.rs packages/xelis-hash/rust-toolchain.toml ./
COPY packages/xelis-hash/src ./src
RUN set -eu; \
    triple="$(cat /tmp/rust-target)"; \
    if [ "$(dpkg --print-architecture)" = "$TARGETARCH" ]; then unset "CARGO_TARGET_$(echo "$triple" | tr 'a-z-' 'A-Z_')_LINKER"; fi; \
    rustup target add "$triple"; \
    cargo build --locked --release --target "$triple"; \
    cp "target/$triple/release/libindex.so" /tmp/index.node

FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/xelis-hash/package.json packages/xelis-hash/package.json
COPY services/api/package.json services/api/package.json
COPY services/stratum/package.json services/stratum/package.json
RUN npm ci --omit=dev

COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY packages/xelis-hash/src packages/xelis-hash/src
COPY services/stratum/src services/stratum/src
COPY --from=hash-build /tmp/index.node packages/xelis-hash/index.node

ENV NODE_ENV=production
# Records kept while the database cannot be reached (see store.js); a volume is mounted here.
RUN mkdir -p /spool && chown node:node /spool
# The optional TLS key in docker/stratum-tls must be readable by this user (uid 1000).
USER node
CMD ["npm", "run", "start", "--workspace", "@xeldash/stratum"]
