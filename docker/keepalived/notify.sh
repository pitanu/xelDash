#!/bin/sh
# keepalived calls this on every change: type, name, state (MASTER, BACKUP, FAULT, STOP), priority.
# The state goes to the shared config volume, where the dashboard and the alerts read it.
state="$3"
file="${CLUSTER_STATE_FILE:-/config/cluster.json}"
tmp="${file}.tmp"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$(dirname "$file")"
printf '{"state":"%s","since":"%s","vip":"%s","interface":"%s","server":"%s"}\n' \
  "$state" "$now" "${XELDASH_VIP:-}" "${XELDASH_VIP_INTERFACE:-}" "${XELDASH_SERVER_NAME:-$(hostname)}" > "$tmp"
mv "$tmp" "$file"
echo "cluster: this server is now $state"
