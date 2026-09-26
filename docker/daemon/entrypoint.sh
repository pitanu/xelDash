#!/bin/sh
# Runs the XELIS daemon and swaps in a prepared snapshot when asked. The snapshot service
# (services/snapshot) talks to this script only through files on the shared data volume:
#
#   .snapshot/BOOTSTRAPPING   the first snapshot is still downloading; wait before starting
#   .snapshot/staged/         a verified, unpacked database ready to replace the current one
#   .snapshot/staged/READY    marks it complete
#   .snapshot/RESTART         restart the daemon now (it swaps in the staged database first)
#
# The current database is kept as <network>.previous for rollback until the next swap.
set -eu

DATA=/root/.xelis
NETWORK="${XELIS_NETWORK:-devnet}"
DB="$DATA/$NETWORK"
CONTROL="$DATA/.snapshot"
BIN=/var/run/xelis/xelis
child=""

log() { echo "[xeldash] $*"; }

stop_child() {
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child"
    wait "$child" || true
  fi
  child=""
}

# docker stop sends SIGTERM to PID 1 (this script); pass it on so the daemon shuts down cleanly.
trap 'stop_child; exit 0' TERM INT

swap_in_staged() {
  [ -f "$CONTROL/staged/READY" ] || return 0
  rm -f "$CONTROL/staged/READY"
  if [ -d "$DB" ]; then
    rm -rf "$DB.previous"
    mv "$DB" "$DB.previous"
    log "Moved the current $NETWORK database to $NETWORK.previous"
  fi
  mv "$CONTROL/staged" "$DB"
  log "Switched to the imported snapshot"
}

mkdir -p "$CONTROL"
while [ -f "$CONTROL/BOOTSTRAPPING" ]; do
  log "Waiting for the snapshot download to finish before starting (see the dashboard)"
  sleep 30
done

while true; do
  rm -f "$CONTROL/RESTART"
  swap_in_staged
  "$BIN" "$@" &
  child=$!
  # Wait for the daemon to exit, or for a restart request.
  while kill -0 "$child" 2>/dev/null; do
    if [ -f "$CONTROL/RESTART" ]; then
      log "Restart requested by the snapshot service"
      stop_child
      break
    fi
    sleep 2
  done
  if [ -n "$child" ]; then
    # The daemon exited on its own: exit with its status so Docker's restart policy applies.
    status=0
    wait "$child" || status=$?
    exit "$status"
  fi
done
