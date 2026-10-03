#!/bin/sh
# Builds the HAProxy configuration from the environment, after checking every value (they end up in a config file).
#   FRONTDOOR_MAIN_HOST          main server's address (a name or an IPv4 address)
#   FRONTDOOR_MAIN_HEALTH_PORT   main server's dashboard port (its /api/v1/mining-health says whether it can mine)
#   FRONTDOOR_MAIN_STRATUM_PORT  main server's Stratum port (default 3333)
#   FRONTDOOR_MAIN_GETWORK_PORT  main server's getwork port (default 8090)
#   FRONTDOOR_STANDBY_HOST       the local standby Stratum (default "stratum")
#   FRONTDOOR_TLS                "true" to also accept encrypted Stratum on 3334, with /tls/cert.pem and /tls/key.pem
set -eu

fail() { echo "frontdoor: $1" >&2; exit 1; }
host_ok() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'; }
port_ok() { printf '%s' "$1" | grep -Eq '^[0-9]{1,5}$' && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

MAIN_HOST=${FRONTDOOR_MAIN_HOST:-}
HEALTH_PORT=${FRONTDOOR_MAIN_HEALTH_PORT:-8088}
STRATUM_PORT=${FRONTDOOR_MAIN_STRATUM_PORT:-3333}
GETWORK_PORT=${FRONTDOOR_MAIN_GETWORK_PORT:-8090}
STANDBY_HOST=${FRONTDOOR_STANDBY_HOST:-stratum}
TLS=${FRONTDOOR_TLS:-false}

[ -n "$MAIN_HOST" ] || fail "FRONTDOOR_MAIN_HOST is not set (run: xeldash frontdoor join CODE)"
host_ok "$MAIN_HOST" || fail "FRONTDOOR_MAIN_HOST is not a host name or address"
host_ok "$STANDBY_HOST" || fail "FRONTDOOR_STANDBY_HOST is not a host name"
case "$TLS" in true|false) ;; *) fail "FRONTDOOR_TLS must be true or false" ;; esac
for p in "$HEALTH_PORT" "$STRATUM_PORT" "$GETWORK_PORT"; do port_ok "$p" || fail "\"$p\" is not a port number"; done

TLS_BIND=""
if [ "$TLS" = true ]; then
  [ -r /tls/cert.pem ] && [ -r /tls/key.pem ] || fail "STRATUM_TLS_ENABLED is true but /tls/cert.pem and /tls/key.pem are missing (put them in docker/stratum-tls, see its README)"
  # HAProxy wants the certificate and its key in one file.
  umask 077
  cat /tls/cert.pem /tls/key.pem > /tmp/bundle.pem
  TLS_BIND="
frontend stratum_tls_in
    bind :3334 ssl crt /tmp/bundle.pem ssl-min-ver TLSv1.2
    default_backend stratum
"
fi

cat > /tmp/haproxy.cfg <<CFG
global
    log stdout format raw local0 notice
    maxconn 4096

defaults
    mode tcp
    log global
    option tcplog
    timeout connect 3s
    timeout client 10m
    timeout server 10m
    timeout check 1s

resolvers docker
    nameserver dns 127.0.0.11:53
    hold valid 10s
    accepted_payload_size 8192

# The main server is chosen while its mining check answers (3 failures to leave, 2 successes to return); the local standby
# is used otherwise. send-proxy tells the Stratum which miner is really connecting.
backend stratum
    option httpchk GET /api/v1/mining-health
    http-check connect port ${HEALTH_PORT}
    http-check send meth GET uri /api/v1/mining-health hdr Host frontdoor
    http-check expect status 200
    server main ${MAIN_HOST}:${STRATUM_PORT} check inter 2s fall 3 rise 2 on-marked-down shutdown-sessions send-proxy resolvers docker init-addr last,libc,none
    server standby ${STANDBY_HOST}:3333 backup send-proxy resolvers docker init-addr last,libc,none

backend getwork
    option httpchk GET /api/v1/mining-health
    http-check connect port ${HEALTH_PORT}
    http-check send meth GET uri /api/v1/mining-health hdr Host frontdoor
    http-check expect status 200
    server main ${MAIN_HOST}:${GETWORK_PORT} check inter 2s fall 3 rise 2 on-marked-down shutdown-sessions send-proxy resolvers docker init-addr last,libc,none
    server standby ${STANDBY_HOST}:8090 backup send-proxy resolvers docker init-addr last,libc,none

frontend stratum_in
    bind :3333
    default_backend stratum

frontend getwork_in
    bind :8090
    default_backend getwork
${TLS_BIND}
CFG

haproxy -c -f /tmp/haproxy.cfg >/dev/null || fail "the generated configuration is not valid"
[ "$TLS" != true ] || echo "frontdoor: encrypted Stratum is accepted on 3334 (the front door decrypts it and passes it on)"
echo "frontdoor: miners go to ${MAIN_HOST} while it can mine, else to the local standby"
exec haproxy -W -db -f /tmp/haproxy.cfg
