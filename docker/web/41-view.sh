#!/bin/sh
# Decides which view this web server gives, at container start:
#   operator  everything, including node administration. The normal dashboard, and in public mode the admin-web container
#             (XELDASH_WEB_VIEW=admin), which is published on 127.0.0.1 only.
#   public    public mode (XELDASH_PUBLIC_MODE=true) for everyone else: no node administration (a 404), the API leaves out IP
#             addresses and connection problems because every request carries X-Xeldash-View: public, and requests are
#             limited per visitor and in all (web/nginx.conf).
# The header always replaces whatever a visitor sends, so only this container's own setting decides the view.
set -eu

snippets="${XELDASH_NGINX_SNIPPETS:-/etc/nginx/snippets}"
public=0
case "$(printf '%s' "${XELDASH_PUBLIC_MODE:-false}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) public=1 ;;
esac

if [ "$public" = 1 ] && [ "${XELDASH_WEB_VIEW:-}" != admin ]; then
  view=public
else
  view=admin
fi

# The Docker networks this container is on, from its routing table (each line: destination and mask, little-endian hex). The
# HTTPS proxy in front of a public server is on one of them, so only these may name the visitor's real address
# (X-Forwarded-For); a visitor who connects straight to this port cannot.
local_networks() {
  file="${XELDASH_ROUTE_FILE:-/proc/net/route}"
  [ -r "$file" ] || return 0
  awk 'NR > 1 && $3 == "00000000" && $2 != "00000000" { print $2, $8 }' "$file" | while read -r dest mask; do
    a=$(printf '%s' "$dest" | cut -c7-8); b=$(printf '%s' "$dest" | cut -c5-6)
    c=$(printf '%s' "$dest" | cut -c3-4); d=$(printf '%s' "$dest" | cut -c1-2)
    net=$(printf '%d.%d.%d.%d' "0x$a" "0x$b" "0x$c" "0x$d")
    bits=0
    for i in 1 3 5 7; do
      case $(printf '%d' "0x$(printf '%s' "$mask" | cut -c"$i"-$((i + 1)))") in
        255) bits=$((bits + 8)) ;; 254) bits=$((bits + 7)) ;; 252) bits=$((bits + 6)) ;; 248) bits=$((bits + 5)) ;;
        240) bits=$((bits + 4)) ;; 224) bits=$((bits + 3)) ;; 192) bits=$((bits + 2)) ;; 128) bits=$((bits + 1)) ;;
      esac
    done
    echo "$net/$bits"
  done
}

if [ "$view" = public ]; then
  {
    printf 'set $xeldash_view "public";\n'
    # Request limits (web/nginx.conf) count each visitor, and all visitors together.
    printf 'set $limit_ip $binary_remote_addr;\nset $limit_all "all";\n'
    for network in $(local_networks); do printf 'set_real_ip_from %s;\n' "$network"; done
    printf 'real_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n'
    # A visitor may hold a few connections open, and slow or idle ones are closed soon.
    printf 'limit_conn conn_per_ip 20;\n'
    printf 'client_header_timeout 10s;\nclient_body_timeout 10s;\nsend_timeout 30s;\nkeepalive_timeout 30s;\n'
  } > "$snippets/view.conf"
else
  printf 'set $xeldash_view "admin";\nset $limit_ip "";\nset $limit_all "";\n' > "$snippets/view.conf"
fi

if [ "$view" = public ]; then
  cat > "$snippets/node-route.conf" <<'EOF'
location /api/v1/node/ {
  return 404;
}
EOF
  echo "Public view: node administration is not served here (use the admin port on the server itself); requests are limited."
else
  # Snapshot uploads can be many gigabytes: no size limit, streamed straight to node-admin instead of buffered, and no short timeouts.
  cat > "$snippets/node-route.conf" <<'EOF'
location /api/v1/node/ {
  proxy_pass $admin_upstream;
  proxy_set_header Host $host;
  proxy_set_header X-Xeldash-View $xeldash_view;
  client_max_body_size 0;
  proxy_request_buffering off;
  proxy_http_version 1.1;
  proxy_read_timeout 2h;
  proxy_send_timeout 2h;
  client_body_timeout 2h;
}
EOF
  [ "$public" = 1 ] && echo "Operator view of a public server: everything, including node administration."
fi
exit 0
