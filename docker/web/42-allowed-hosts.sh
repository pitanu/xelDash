#!/bin/sh
# Turns the host names this dashboard answers to into an nginx map (DNS rebinding: a website pointing its own domain at your
# dashboard's address sends its domain in Host, and gets 421). The same rules as services/api/src/allowed-hosts.js: addresses, names
# without a dot, the local-only suffixes, XELDASH_CONNECT_HOST, XELDASH_PUBLIC_DOMAIN, XELDASH_PROXY_HOST and XELDASH_ALLOWED_HOSTS
# (a comma list; "*.example.org" for every name under it; "any" turns the check off). Runs at container start; a bad entry in
# XELDASH_ALLOWED_HOSTS stops the container with a message.
set -eu

out="${XELDASH_NGINX_SNIPPETS:-/etc/nginx/snippets}/allowed-hosts.conf"
any=0
entries=""

# A name as nginx's $host has it: lower case, no port, no trailing dot. Prints nothing for an address (always answered anyway).
clean() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | sed 's/^\[//; s/\]$//; s/:[0-9]*$//; s/\.$//'
}
is_name() {
  case "$1" in ""|*[!a-z0-9._-]*|.*|*..*) return 1 ;; *) return 0 ;; esac
}
# A dot-escaped name for a regular expression.
escaped() {
  printf '%s' "$1" | sed 's/\./\\./g'
}

for value in "${XELDASH_CONNECT_HOST:-${XELDASH_PUBLIC_HOST:-}}" "${XELDASH_PUBLIC_DOMAIN:-}" "${XELDASH_PROXY_HOST:-}"; do
  name="$(clean "$value")"
  if is_name "$name"; then entries="$entries
  \"~^$(escaped "$name")\\.?\$\" 1;"; fi
done
for token in $(printf '%s' "${XELDASH_ALLOWED_HOSTS:-}" | tr ',' ' '); do
  case "$token" in
    any|ANY|Any) any=1 ;;
    \*.*)
      name="$(clean "${token#\*.}")"
      is_name "$name" || { echo "XELDASH_ALLOWED_HOSTS: \"$token\" is not a host name like dash.example.org or *.example.org" >&2; exit 1; }
      entries="$entries
  \"~(^|\\.)$(escaped "$name")\\.?\$\" 1;" ;;
    *)
      name="$(clean "$token")"
      is_name "$name" || { echo "XELDASH_ALLOWED_HOSTS: \"$token\" is not a host name like dash.example.org or *.example.org" >&2; exit 1; }
      entries="$entries
  \"~^$(escaped "$name")\\.?\$\" 1;" ;;
  esac
done

{
  echo "map \$host \$xeldash_host_ok {"
  if [ "$any" = 1 ]; then echo "  default 1;"; else echo "  default 0;"; fi
  # [IPv6 address], IPv4 address, a name without a dot (also nginx's "_" for a request without Host).
  echo '  "~^\[[0-9a-f:.]+\]$" 1;'
  echo '  "~^[0-9]{1,3}(\.[0-9]{1,3}){3}$" 1;'
  echo '  "~^[a-z0-9_-]+\.?$" 1;'
  echo '  "~(^|\.)(localhost|local|lan|home|home\.arpa|internal|ts\.net)\.?$" 1;'
  printf '%s\n' "$entries" | sed '/^$/d'
  echo "}"
} > "$out"

if [ "$any" = 1 ]; then echo "Dashboard answers to any host name"; else echo "Dashboard answers to addresses, local names${entries:+ and the configured ones}"; fi
