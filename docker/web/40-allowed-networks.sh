#!/bin/sh
# Turns XELDASH_ALLOWED_NETWORKS into nginx allow/deny lines, so the dashboard answers only
# your own network by default. Values: "private" (this computer and home networks), "tailscale"
# (100.64.0.0/10, for a VPN), "any", or addresses and networks such as 192.168.1.0/24,
# separated by commas. Runs at container start; a bad entry stops the container with a message.
set -eu

out=/etc/nginx/snippets/allowed-networks.conf
value="${XELDASH_ALLOWED_NETWORKS:-private}"
private="127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 ::1/128 fc00::/7 fe80::/10"
tailscale="100.64.0.0/10 fd7a:115c:a1e0::/48"
any=0

# The container's own loopback (its health check) can only be the container itself: always fine.
printf 'allow 127.0.0.0/8;
allow ::1;
' > "$out"
for token in $(printf '%s' "$value" | tr ',' ' '); do
  case "$token" in
    any) any=1 ;;
    private) for n in $private; do echo "allow $n;" >> "$out"; done ;;
    tailscale|cgnat) for n in $tailscale; do echo "allow $n;" >> "$out"; done ;;
    *[!0-9a-fA-F:./]*|"") echo "XELDASH_ALLOWED_NETWORKS: \"$token\" is not private, tailscale, any, an address or a network like 192.168.1.0/24" >&2; exit 1 ;;
    *) echo "allow $token;" >> "$out" ;;
  esac
done

if [ "$any" = 1 ]; then : > "$out"; else echo "deny all;" >> "$out"; fi
echo "Dashboard may be opened from: $value"
