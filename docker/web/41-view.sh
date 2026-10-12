#!/bin/sh
# Decides which view this web server gives, at container start:
#   operator  everything, including node administration. The normal dashboard, and in public mode the admin-web container
#             (XELDASH_WEB_VIEW=admin), which is published on 127.0.0.1 only.
#   public    public mode (XELDASH_PUBLIC_MODE=true) for everyone else: no node administration (a 404), and the API leaves out IP
#             addresses and connection problems because every request carries X-Xeldash-View: public.
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

printf 'set $xeldash_view "%s";\n' "$view" > "$snippets/view.conf"

if [ "$view" = public ]; then
  cat > "$snippets/node-route.conf" <<'EOF'
location /api/v1/node/ {
  return 404;
}
EOF
  echo "Public view: node administration is not served here (use the admin port on the server itself)."
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
