FROM alpine:3.24
# keepalived (VRRP) holds the cluster's shared address on whichever server can mine; curl is for the health check.
RUN apk add --no-cache keepalived curl iproute2
COPY entrypoint.sh check.sh notify.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/check.sh /usr/local/bin/notify.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/entrypoint.sh"]
