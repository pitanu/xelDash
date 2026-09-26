# The official daemon image has no shell or HTTP client, so add a static busybox for the
# Compose healthcheck. Everything else is the upstream image unchanged.
ARG XELIS_DAEMON_IMAGE=xelis/daemon:1.21.3

FROM busybox:1.37-musl AS busybox

FROM ${XELIS_DAEMON_IMAGE}
COPY --from=busybox /bin/busybox /usr/local/bin/busybox
