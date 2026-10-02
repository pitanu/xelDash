#!/bin/sh
# keepalived calls this on every change: type, name, state (MASTER, BACKUP, FAULT, STOP), priority.
# The state goes to the shared config volume, where the dashboard and the alerts read it.
state="$3"
file="${CLUSTER_STATE_FILE:-/config/cluster.json}"
tmp="${file}.tmp"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$(dirname "$file")"
# Only plain characters go into the JSON, so a server name with a quote or a backslash cannot break it.
clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._:/-' | cut -c1-64; }
case "$state" in MASTER|BACKUP|FAULT|STOP) ;; *) state=UNKNOWN ;; esac
printf '{"state":"%s","since":"%s","vip":"%s","interface":"%s","server":"%s"}\n' \
  "$state" "$now" "$(clean "${XELDASH_VIP:-}")" "$(clean "${XELDASH_VIP_INTERFACE:-}")" "$(clean "${XELDASH_SERVER_NAME:-$(hostname)}")" > "$tmp"
mv "$tmp" "$file"
echo "cluster: this server is now $state"
