# Runs the official XELIS daemon binary on a Debian 13 runtime.
#
# Since 1.22.0 the upstream image builds the binary on Debian 13 (glibc 2.41) but still ships
# it on distroless/cc-debian12 (glibc 2.36), so it exits with "GLIBC_2.38 not found". Copying
# the unchanged binary onto cc-debian13 fixes that; older releases run there too. A static
# busybox provides the shell for the healthcheck and for entrypoint.sh, which runs the daemon
# and swaps in snapshots prepared by the snapshot service.
ARG XELIS_DAEMON_IMAGE=xelis/daemon:1.25.0

FROM ${XELIS_DAEMON_IMAGE} AS upstream

FROM busybox:1.37-musl AS busybox

FROM gcr.io/distroless/cc-debian13
ENV APP_DIR=/var/run/xelis
ENV DATA_DIR=/var/run/xelis/data
COPY --from=upstream /var/run/xelis/xelis /var/run/xelis/xelis
COPY --from=busybox /bin/busybox /usr/local/bin/busybox
# Distroless has no shell, so install busybox's applets (sh, mv, rm, sleep...) from busybox itself.
RUN ["/usr/local/bin/busybox", "--install", "-s", "/usr/local/bin"]
COPY entrypoint.sh /usr/local/bin/xeldash-entrypoint.sh
WORKDIR /var/run/xelis/data
ENTRYPOINT ["/usr/local/bin/busybox", "sh", "/usr/local/bin/xeldash-entrypoint.sh"]
