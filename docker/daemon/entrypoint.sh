#!/bin/sh
# Runs the XELIS daemon, applies settings saved from the dashboard, and swaps in prepared
# snapshots. node-admin (services/node-admin) talks to this script only through files on the
# shared data volume, under .xeldash/:
#
#   daemon-help.txt      the daemon's --help, written on each start (the dashboard's settings list)
#   daemon-args          dashboard settings in use: extra daemon flags, one per line
#   daemon-args.pending  saved settings waiting for the next restart
#   settings-result      outcome of the last settings change (applied, rejected, reverted)
#   BOOTSTRAPPING        the first snapshot is still downloading; wait before starting
#   staged/, staged/READY  a verified, unpacked database ready to replace the current one
#   RESTART              restart the daemon now
#   STOP                 keep the daemon stopped until the marker is removed (dashboard Stop)
#   bin/<version>/xelis_daemon  a release binary downloaded and verified by node-admin
#   bin/current          the release version in use; absent means the image's own binary
#   bin/pending          version to switch to on the next start ("image" for the image's own)
#   upgrade-result       outcome of the last switch (applied, rejected, reverted)
#   STOPPED              written while stopped, so node-admin knows the database is closed
#
# Settings are checked with the daemon's own parser before they are applied, and put back if
# the daemon exits within SETTLE_SECONDS of starting with them. On a snapshot swap the current
# database is kept as <network>.previous for rollback until the next swap.
set -eu

DATA=/root/.xelis
NETWORK="${XELIS_NETWORK:-devnet}"
DB="$DATA/$NETWORK"
CONTROL="$DATA/.xeldash"
IMAGE_BIN=/var/run/xelis/xelis
BIN=$IMAGE_BIN
SETTLE_SECONDS=30
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

# The daemon reads peers as IP:port and skips a host name, so a peer given by Compose service
# name (daemon2's --priority-nodes=daemon:2125) is resolved to its current address on each
# start. A name that does not resolve is left out and logged.
resolve_peer() {
  case "$1" in
    --priority-nodes=*|--exclusive-nodes=*) ;;
    *) printf '%s\n' "$1"; return ;;
  esac
  flag=${1%%=*}
  peer=${1#*=}
  host=${peer%:*}
  port=${peer##*:}
  # Already an address: IPv4 digits and dots, or a bracketed IPv6 address.
  case "$host" in
    \[*) printf '%s\n' "$1"; return ;;
    *[!0-9.]*) ;;
    *) printf '%s\n' "$1"; return ;;
  esac
  ip=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    ip=$(busybox nslookup "$host" 2>/dev/null | busybox awk '/^Name:/ { found = 1 } found && /^Address/ { print $NF; exit }')
    case "$ip" in *.*.*.*) break ;; esac
    ip=""
    sleep 3
  done
  if [ -n "$ip" ]; then
    printf '%s=%s:%s\n' "$flag" "$ip" "$port"
  else
    log "Could not resolve peer $peer; starting without it" >&2
  fi
}

result() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" > "$CONTROL/settings-result"; }

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
# Compose's flags (network, RPC address, data path) always come first; dashboard settings are
# added after them from daemon-args.
printf '%s\n' "$@" > "$CONTROL/base-args"

# Check a settings file with the daemon's parser: generating a config template parses every
# flag and exits without starting the node. Prints the parser's error on failure.
check_settings() {
  settings="$1"
  rm -f /tmp/xeldash-check.json
  set --
  while IFS= read -r line; do [ -n "$line" ] && set -- "$@" "$line"; done < "$CONTROL/base-args"
  while IFS= read -r line; do [ -n "$line" ] && set -- "$@" "$line"; done < "$settings"
  "$BIN" "$@" --config-file /tmp/xeldash-check.json --generate-config-template > /tmp/xeldash-check.out 2>&1
}

apply_pending() {
  [ -f "$CONTROL/daemon-args.pending" ] || return 1
  if check_settings "$CONTROL/daemon-args.pending"; then
    if [ -f "$CONTROL/daemon-args" ]; then mv "$CONTROL/daemon-args" "$CONTROL/daemon-args.previous"; else rm -f "$CONTROL/daemon-args.previous"; fi
    mv "$CONTROL/daemon-args.pending" "$CONTROL/daemon-args"
    result "applied"
    log "Applied the daemon settings saved from the dashboard"
    return 0
  fi
  reason="$(tr '\n' ' ' < /tmp/xeldash-check.out | cut -c1-500)"
  rm -f "$CONTROL/daemon-args.pending"
  result "rejected $reason"
  log "Rejected the saved daemon settings: $reason"
  return 1
}

# The binary to run: a downloaded release when one is selected and still there, else the image's.
select_bin() {
  BIN=$IMAGE_BIN
  if [ -f "$CONTROL/bin/current" ]; then
    version=$(cat "$CONTROL/bin/current")
    if [ -x "$CONTROL/bin/$version/xelis_daemon" ]; then
      BIN="$CONTROL/bin/$version/xelis_daemon"
    else
      log "Release $version is missing; using the image's daemon"
      rm -f "$CONTROL/bin/current"
    fi
  fi
}

upgrade_result() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" > "$CONTROL/upgrade-result"; }

# Switch to the version node-admin asked for, after checking the binary runs here.
apply_binary() {
  [ -f "$CONTROL/bin/pending" ] || return 1
  wanted=$(cat "$CONTROL/bin/pending")
  rm -f "$CONTROL/bin/pending"
  previous=$(cat "$CONTROL/bin/current" 2>/dev/null || echo image)
  if [ "$wanted" = image ]; then
    rm -f "$CONTROL/bin/current"
    echo "$previous" > "$CONTROL/bin/previous"
    upgrade_result "applied image"
    log "Switched back to the image's daemon"
    return 0
  fi
  candidate="$CONTROL/bin/$wanted/xelis_daemon"
  out="not found"
  if [ -x "$candidate" ] && out=$("$candidate" --version 2>&1); then
    echo "$wanted" > "$CONTROL/bin/current"
    echo "$previous" > "$CONTROL/bin/previous"
    upgrade_result "applied $wanted"
    log "Switched to release $wanted ($out)"
    return 0
  fi
  upgrade_result "rejected $wanted does not run here: $(echo "$out" | tr '\n' ' ' | cut -c1-300)"
  log "Release $wanted does not run here; keeping the current daemon"
  return 1
}

revert_binary() {
  previous=$(cat "$CONTROL/bin/previous" 2>/dev/null || echo image)
  if [ "$previous" = image ]; then rm -f "$CONTROL/bin/current"; else echo "$previous" > "$CONTROL/bin/current"; fi
}

revert_settings() {
  if [ -f "$CONTROL/daemon-args.previous" ]; then mv "$CONTROL/daemon-args.previous" "$CONTROL/daemon-args"; else rm -f "$CONTROL/daemon-args"; fi
}

# A STOPPED marker from before a container restart is stale; STOP itself is kept, so a node
# stopped from the dashboard stays stopped.
rm -f "$CONTROL/STOPPED"

while [ -f "$CONTROL/BOOTSTRAPPING" ]; do
  log "Waiting for the snapshot download to finish before starting (see the dashboard)"
  sleep 30
done

while true; do
  rm -f "$CONTROL/RESTART"
  if [ -f "$CONTROL/STOP" ]; then
    : > "$CONTROL/STOPPED"
    log "Stopped from the dashboard; waiting to be started again"
    while [ -f "$CONTROL/STOP" ]; do sleep 2; done
    rm -f "$CONTROL/STOPPED"
    log "Starting again"
  fi
  swap_in_staged
  just_upgraded=0
  if apply_binary; then just_upgraded=1; fi
  select_bin
  # The dashboard's settings list comes from the daemon that is about to run.
  "$BIN" --help > "$CONTROL/daemon-help.txt" 2>&1 || true
  just_applied=0
  if apply_pending; then just_applied=1; fi

  set --
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    line=$(resolve_peer "$line")
    [ -n "$line" ] && set -- "$@" "$line"
  done < "$CONTROL/base-args"
  if [ -f "$CONTROL/daemon-args" ]; then
    while IFS= read -r line; do [ -n "$line" ] && set -- "$@" "$line"; done < "$CONTROL/daemon-args"
  fi
  started=$(date +%s)
  "$BIN" "$@" &
  child=$!
  # Wait for the daemon to exit, or for a restart or stop request.
  while kill -0 "$child" 2>/dev/null; do
    if [ -f "$CONTROL/STOP" ]; then
      log "Stop requested from the dashboard"
      stop_child
      break
    fi
    if [ -f "$CONTROL/RESTART" ]; then
      log "Restart requested from the dashboard"
      stop_child
      break
    fi
    sleep 2
  done
  if [ -n "$child" ]; then
    status=0
    wait "$child" || status=$?
    child=""
    if [ "$just_upgraded" = 1 ] && [ $(( $(date +%s) - started )) -lt "$SETTLE_SECONDS" ]; then
      # The new release ran --version but did not stay up (for example, a database it cannot open).
      failed=$(cat "$CONTROL/bin/current" 2>/dev/null || echo "the image's version")
      revert_binary
      upgrade_result "reverted the node exited with code $status within ${SETTLE_SECONDS}s of starting on $failed; the previous version is back"
      log "The daemon exited ($status) right after switching versions; switching back"
      continue
    fi
    if [ "$just_applied" = 1 ] && [ $(( $(date +%s) - started )) -lt "$SETTLE_SECONDS" ]; then
      # The new settings passed the parser but the daemon did not stay up with them.
      revert_settings
      result "reverted the node exited with code $status within ${SETTLE_SECONDS}s of starting with the new settings; the previous settings are back"
      log "The daemon exited ($status) right after new settings were applied; restoring the previous settings"
      continue
    fi
    # The daemon exited on its own: exit with its status so Docker's restart policy applies.
    exit "$status"
  fi
done
