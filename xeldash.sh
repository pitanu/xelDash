#!/usr/bin/env bash
# xelDash launcher for Linux and macOS: set it up, start it, stop it, update it.
#
#   ./xeldash.sh            first time: guided setup; afterwards: shows what is running
#   ./xeldash.sh install    guided setup (creates .env, starts xelDash, opens the dashboard)
#   ./xeldash.sh start | stop | restart | status | logs [service] | open | token
#   ./xeldash.sh lan on|off|status    let other computers on your network use xelDash
#   ./xeldash.sh update     get the newest xelDash and restart it
#   ./xeldash.sh backup     save a copy of your statistics to the backups folder
#   ./xeldash.sh cluster setup|join CODE|status|off   two Linux servers sharing one address, for redundancy
#   ./xeldash.sh frontdoor setup|join CODE|status|off a Linux box miners connect to, in front of this server
#   ./xeldash.sh restore FILE   put a backup back (replaces the current statistics)
#
# Options for install (all optional; without them it asks):
#   --address xel:...   your wallet address (or add it later in the dashboard)
#   --lan yes|no        allow other computers on your home network
#   --network mainnet|testnet|devnet   (default mainnet)
#   --yes               do not ask anything; use defaults
#   --no-start          write .env only
#   --set KEY=VALUE     set any .env value (repeatable)
set -euo pipefail
cd "$(dirname "$0")"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; D=""; N=""; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ---------------------------------------------------------------- .env helpers

get_env() { [ -f .env ] && sed -n "s/^$1=//p" .env | head -1 || true; }

# Set KEY=VALUE in .env: replaces the first "KEY=" (or commented "# KEY=") line, else appends.
set_env() {
  local tmp; tmp="$(mktemp)"
  KEY="$1" VAL="$2" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
    { if (!done && ($0 ~ ("^" k "=") || $0 ~ ("^# ?" k "="))) { print k "=" v; done = 1 } else print }
    END { if (!done) print k "=" v }' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# ---------------------------------------------------------------- checks

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    say ""
    say "${B}xelDash needs Docker, and it is not installed yet.${N}"
    case "$(uname -s)" in
      Darwin) say "Install Docker Desktop for Mac: https://www.docker.com/products/docker-desktop/" ;;
      *)      say "Install Docker Engine: https://docs.docker.com/engine/install/" ;;
    esac
    say "Open Docker once so it is running, then run ./xeldash.sh again."
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    die "Docker is installed, but not Docker Compose (version 2). Update Docker: https://docs.docker.com/compose/install/"
  fi
  local out
  if ! out="$(docker info 2>&1)"; then
    case "$out" in
      *"permission denied"*) die "Docker is installed, but your user may not use it. Run: sudo usermod -aG docker \$USER  then log out and in again." ;;
      *) die "Docker is installed, but not running. Start Docker (open Docker Desktop, or: sudo systemctl start docker) and try again." ;;
    esac
  fi
}

http_ok() {
  if command -v curl >/dev/null 2>&1; then curl -fs -o /dev/null -m 3 "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O /dev/null -T 3 "$1"
  else return 0; fi
}

# This computer's address on the home network, or nothing when it cannot be told.
lan_ip() {
  local ip=""
  case "$(uname -s)" in
    Darwin)
      local iface; iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
      [ -n "$iface" ] && ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)" ;;
    *)
      ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 || true)"
      [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)" ;;
  esac
  printf '%s' "$ip"
}
is_private_ip() { [[ "$1" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; }

open_url() {
  # XELDASH_NO_BROWSER=1 skips opening a browser (servers, tests).
  [ -n "${XELDASH_NO_BROWSER:-}" ] && return 0
  case "$(uname -s)" in
    Darwin) open "$1" >/dev/null 2>&1 || true ;;
    *) command -v xdg-open >/dev/null 2>&1 && xdg-open "$1" >/dev/null 2>&1 || true ;;
  esac
}

web_port() { local p; p="$(get_env XELDASH_WEB_PORT)"; printf '%s' "${p:-8088}"; }

# ---------------------------------------------------------------- lan

lan_on() {
  local ip="${1:-}"
  [ -z "$ip" ] && ip="$(lan_ip)"
  if [ -z "$ip" ]; then
    warn "Could not find this computer's address on your network. Run: ./xeldash.sh lan on 192.168.1.20 (use your own address)."
    return 1
  fi
  if ! is_private_ip "$ip"; then
    warn "This computer's address ($ip) is not a home-network address, so opening xelDash to the network could expose it to the internet. If you are sure, set XELDASH_WEB_BIND_IP, XELDASH_STRATUM_BIND_IP and XELDASH_PUBLIC_HOST in .env yourself."
    return 1
  fi
  set_env XELDASH_WEB_BIND_IP 0.0.0.0
  set_env XELDASH_STRATUM_BIND_IP 0.0.0.0
  set_env XELDASH_PUBLIC_HOST "$ip"
  ok "Other computers on your network can now use xelDash at http://$ip:$(web_port)"
  case "$(uname -s)" in
    Darwin)
      warn "Docker Desktop hides where connections come from on macOS, so xelDash cannot tell your network from the internet here."
      say "    Never forward these ports on your router, and consider turning on the macOS firewall." ;;
    *)
      say "    xelDash only accepts connections from your own network (XELDASH_ALLOWED_NETWORKS in .env)."
      say "    Never forward these ports on your router." ;;
  esac
}
lan_off() {
  set_env XELDASH_WEB_BIND_IP 127.0.0.1
  set_env XELDASH_STRATUM_BIND_IP 127.0.0.1
  set_env XELDASH_PUBLIC_HOST ""
  ok "xelDash now only answers on this computer."
}

cmd_lan() {
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first."
  case "${1:-status}" in
    on)  check_docker; lan_on "${2:-}" || exit 1; docker compose up -d >/dev/null; ok "Restarted with the new setting." ;;
    off) check_docker; lan_off; docker compose up -d >/dev/null; ok "Restarted with the new setting." ;;
    status)
      local host; host="$(get_env XELDASH_PUBLIC_HOST)"
      if [ "$(get_env XELDASH_STRATUM_BIND_IP)" = "127.0.0.1" ] || [ -z "$(get_env XELDASH_STRATUM_BIND_IP)" ]; then
        say "Only this computer can use xelDash. Allow your network with: ./xeldash.sh lan on"
      else
        say "Other computers on your network can use xelDash at http://${host:-<this computer>}:$(web_port)"
      fi ;;
    *) die "Use: ./xeldash.sh lan on | off | status" ;;
  esac
}

# ---------------------------------------------------------------- install

# ---------------------------------------------------------------- disk space

# Free space, in GB (1024-based, like df and Finder), on the drive that holds xelDash's data. XELDASH_TEST_FREE_GB overrides it for tests.
disk_free_gb() {
  [ -n "${XELDASH_TEST_FREE_GB:-}" ] && { printf '%s' "$XELDASH_TEST_FREE_GB"; return; }
  local dir="."
  # With Docker Engine on Linux the data lives under Docker's own directory; Docker Desktop keeps it on this drive.
  if [ "$(uname -s)" = Linux ]; then
    local root; root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
    [ -n "$root" ] && [ -d "$root" ] && dir="$root"
  fi
  df -Pk "$dir" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }'
}

# The first start downloads the blockchain snapshot and unpacks it before deleting the download (about 21 GB at the
# peak, so 40 GB free is comfortable); syncing from other nodes instead needs about half that but takes much longer.
# Warns before anything is downloaded, and offers the slower start when only that fits.
check_disk_space() {
  local yes="${1:-0}"
  [ -z "${XELDASH_SKIP_DISK_CHECK:-}" ] || return 0
  [ "$(get_env XELIS_NETWORK)" = mainnet ] || return 0
  local free; free="$(disk_free_gb)"
  [[ "$free" =~ ^[0-9]+$ ]] || return 0
  local fast=40 slow=25 snapshot=0
  [ "$(get_env XELIS_SNAPSHOT_AUTO)" = true ] && snapshot=1
  local need=$slow; [ "$snapshot" -eq 1 ] && need=$fast
  if [ "$free" -ge "$need" ]; then ok "Free disk space: $free GB, enough."; return 0; fi
  say ""
  warn "Only $free GB of disk space is free where xelDash keeps its data."
  if [ "$snapshot" -eq 1 ] && [ "$free" -ge "$slow" ]; then
    say "The fast start needs about $fast GB free: it downloads the blockchain (9 GB) and unpacks it (11 GB) before deleting the download."
    say "A slower start needs only about $slow GB: the node syncs from other nodes instead, which takes much longer, but never holds both copies."
    local reply="y"
    if [ "$yes" -eq 0 ]; then read -r -p "Use the slower start that fits? [Y/n]: " reply || reply=""; fi
    case "$reply" in n|N|no|NO) warn "Continuing with the fast start. It may run out of space; the dashboard warns you and you can free space meanwhile." ;;
      *) set_env XELIS_SNAPSHOT_AUTO false; ok "Using the slower start. You can switch later on the Nodes page (Snapshots)." ;;
    esac
    return 0
  fi
  die "That is not enough: xelDash needs about $slow GB free even with the slower start (the blockchain is about 11 GB and grows). Free some space and run ./xeldash.sh again. (XELDASH_SKIP_DISK_CHECK=1 skips this check.)"
}

cmd_install() {
  local network="" address="" lan="" yes=0 nostart=0 sets=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --network) network="${2:-}"; shift 2 ;;
      --address) address="${2:-}"; shift 2 ;;
      --lan) lan="${2:-}"; shift 2 ;;
      --yes|-y) yes=1; shift ;;
      --no-start) nostart=1; shift ;;
      --set) sets+=("${2:-}"); shift 2 ;;
      *) die "Unknown option $1. See the top of this file, or run ./xeldash.sh help." ;;
    esac
  done

  say "${B}xelDash setup${N}"
  say ""
  check_docker
  ok "Docker is ready."

  if [ -f .env ]; then
    ok "xelDash is already set up here (.env exists). Starting it."
    cmd_start
    return
  fi

  [ -f .env.example ] || die "Run this from the xelDash folder (.env.example is missing)."
  cp .env.example .env
  chmod 600 .env 2>/dev/null || true  # it holds passwords and the admin token: readable by this user only
  use_release_version

  network="${network:-mainnet}"
  case "$network" in mainnet|testnet|devnet) ;; *) die "Network must be mainnet, testnet or devnet." ;; esac
  local prefix="xel"; [ "$network" != "mainnet" ] && prefix="xet"

  if [ -z "$address" ] && [ "$yes" -eq 0 ]; then
    say ""
    say "${B}Your XELIS wallet address${N}"
    say "Rewards for blocks you find are paid straight to it. It starts with ${prefix}:"
    say "No wallet yet? Create one free at https://wallet.xelis.io (write the recovery phrase down and never share it)."
    say "${D}Press Enter to add it later, in the dashboard.${N}"
    read -r -p "Address: " address || address=""
  fi
  address="$(printf '%s' "$address" | tr -d '[:space:]')"
  if [ -n "$address" ] && ! [[ "$address" =~ ^${prefix}:[a-z0-9]{30,120}$ ]]; then
    warn "That does not look like a $network address, so it was skipped. You can add it in the dashboard."
    address=""
  fi

  if [ -z "$lan" ] && [ "$yes" -eq 0 ]; then
    say ""
    say "${B}Other computers${N}"
    say "Will you mine from other computers on your home network? (If it is only this computer, say no.)"
    read -r -p "Allow other computers? [y/N]: " reply || reply=""
    case "$reply" in y|Y|yes|YES) lan=yes ;; *) lan=no ;; esac
  fi

  set_env POSTGRES_PASSWORD "$(random_hex 16)"
  set_env XELDASH_ADMIN_TOKEN "$(random_hex 24)"
  set_env XELIS_NETWORK "$network"
  if [ "$network" = "mainnet" ]; then set_env XELIS_SNAPSHOT_AUTO true; fi
  [ -n "$address" ] && set_env XELIS_DEFAULT_ADDRESS "$address"
  case "$lan" in
    yes|y|Y|YES) lan_on || warn "Continuing without network access. Try later: ./xeldash.sh lan on" ;;
  esac
  local kv
  for kv in "${sets[@]+"${sets[@]}"}"; do
    [ -n "$kv" ] || continue
    [[ "$kv" == *=* ]] || die "--set needs KEY=VALUE, got: $kv"
    set_env "${kv%%=*}" "${kv#*=}"
  done
  check_disk_space "$yes"
  ok "Settings saved to .env (with a new random password and admin token)."

  if [ "$nostart" -eq 1 ]; then say "Not starting, as asked. Start later with: ./xeldash.sh start"; return; fi
  cmd_start first
}

# ---------------------------------------------------------------- run

compose_up() {
  local log=".xeldash-start.log" version; version="$(get_env XELDASH_VERSION)"
  if [ -n "$version" ] && [ "$version" != "local" ]; then
    # A released version: download the ready-made images instead of building them.
    docker compose pull >"$log" 2>&1 || true
    docker compose up -d >>"$log" 2>&1 &
  else
    docker compose up -d --build >"$log" 2>&1 &
  fi
  local pid=$!
  printf '%s' "Starting xelDash "
  while kill -0 "$pid" 2>/dev/null; do printf '.'; sleep 3; done
  printf '\n'
  if ! wait "$pid"; then
    say ""; tail -n 25 "$log"
    die "xelDash could not start. The last lines of the log are above (full log: $log)."
  fi
}

cmd_start() {
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first."
  check_docker
  local first="${1:-}"
  if [ "$first" = first ]; then
    say ""
    say "${B}Building xelDash.${N} The first time this takes about 10 minutes and downloads a few hundred MB."
  fi
  compose_up
  local port; port="$(web_port)"
  local i; for i in $(seq 1 60); do http_ok "http://127.0.0.1:$port/" && break; sleep 2; done
  http_ok "http://127.0.0.1:$port/" || die "xelDash started, but the dashboard is not answering yet. Check: ./xeldash.sh logs"
  ok "xelDash is running."
  local host; host="$(get_env XELDASH_PUBLIC_HOST)"
  say ""
  say "  Dashboard:  ${B}http://localhost:$port${N}"
  [ -n "$host" ] && say "  On your network:  ${B}http://$host:$port${N}"
  if [ "$first" = first ]; then
    say "  Admin password:  ${B}$(get_env XELDASH_ADMIN_TOKEN)${N}"
    say "    You need it to change settings in the dashboard. Show it again any time: ./xeldash.sh token"
    say ""
    say "Opening the dashboard. It will guide you through the rest."
    if [ "$(get_env XELIS_NETWORK)" = mainnet ]; then say "The blockchain downloads in the background (about 10 GB): you can close the window."; fi
    open_url "http://localhost:$port/#/setup?token=$(get_env XELDASH_ADMIN_TOKEN)"
  fi
}

# ---------------------------------------------------------------- release versions

# The VERSION file says which released images this copy of xelDash goes with. A downloaded release has its version number in it (for
# example 0.1.0-rc.6) and installs by pulling the ready-made images; a copy of the development branch has "local" and builds from source.
release_version() {
  local v=""
  [ -f VERSION ] && v="$(tr -d '[:space:]' < VERSION)"
  if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then printf '%s' "$v"; fi
}

# A new .env for a release uses the release's images.
use_release_version() {
  local v; v="$(release_version)"
  if [ -n "$v" ]; then set_env XELDASH_VERSION "$v"; fi
  return 0
}

# Whether version $1 is newer than $2: 1.10.0 > 1.9.0, a release is newer than its pre-releases, 0.1.0-rc.10 > 0.1.0-rc.9.
version_newer() {
  local a="$1" b="$2" ac bc ap="" bp="" i
  ac="${a%%-*}"; bc="${b%%-*}"
  [[ "$a" == *-* ]] && ap="${a#*-}"
  [[ "$b" == *-* ]] && bp="${b#*-}"
  local -a x y
  IFS=. read -ra x <<<"$ac"; IFS=. read -ra y <<<"$bc"
  for i in 0 1 2; do
    if [ "${x[$i]:-0}" -gt "${y[$i]:-0}" ]; then return 0; fi
    if [ "${x[$i]:-0}" -lt "${y[$i]:-0}" ]; then return 1; fi
  done
  [ "$ap" = "$bp" ] && return 1
  [ -z "$ap" ] && return 0
  [ -z "$bp" ] && return 1
  IFS=. read -ra x <<<"$ap"; IFS=. read -ra y <<<"$bp"
  local n=${#x[@]}; [ "${#y[@]}" -gt "$n" ] && n=${#y[@]}
  for ((i = 0; i < n; i++)); do
    local p="${x[$i]:-}" q="${y[$i]:-}"
    [ "$p" = "$q" ] && continue
    [ -z "$p" ] && return 1
    [ -z "$q" ] && return 0
    if [[ "$p" =~ ^[0-9]+$ && "$q" =~ ^[0-9]+$ ]]; then [ "$p" -gt "$q" ] && return 0; return 1; fi
    [[ "$p" =~ ^[0-9]+$ ]] && return 1
    [[ "$q" =~ ^[0-9]+$ ]] && return 0
    [[ "$p" > "$q" ]] && return 0
    return 1
  done
  return 1
}

# The newest release tag in GitHub's tag list (JSON on stdin). A pre-release counts only when the running version is one too.
newest_tag() {
  local current="$1" best="" name
  while read -r name; do
    [[ "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || continue
    if [[ "$name" == *-* && "$current" != *-* ]]; then continue; fi
    if [ -z "$best" ] || version_newer "${name#v}" "${best#v}"; then best="$name"; fi
  done < <(grep -o '"name"[[:space:]]*:[[:space:]]*"v[^"]*"' | sed -E 's/.*"(v[^"]*)"$/\1/')
  printf '%s' "$best"
}

# Update a release install: find the newest release, download it, put its files over this folder (.env, backups and your data are not in it,
# so they stay) and start it. Pull the new launcher in last, by starting it again, since this script is about to be replaced.
update_release() {
  local current="$1" repo api tag version url tmp dir
  repo="$(get_env XELDASH_UPDATE_REPO)"; repo="${repo:-pitanu/xelDash}"
  [[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "XELDASH_UPDATE_REPO must look like owner/name."
  api="${XELDASH_RELEASE_API:-https://api.github.com/repos/$repo}"
  say "Looking for a newer release..."
  tag="$(curl -fsSL -m 20 -H 'accept: application/vnd.github+json' "$api/tags?per_page=100" 2>/dev/null | newest_tag "$current")" || tag=""
  [ -n "$tag" ] || die "Could not find a release to update to. Check your internet connection, or look at https://github.com/$repo/releases"
  version="${tag#v}"
  if ! version_newer "$version" "$current"; then ok "You already have the newest release ($current)."; return 0; fi
  say "Updating $current to $version..."
  tmp="$(mktemp -d)"
  url="${XELDASH_ARCHIVE_URL:-https://github.com/$repo/archive/refs/tags/$tag.tar.gz}"
  # Tried three times: a virus scanner can briefly hold a file that was just written, and a connection can drop.
  local try=1
  until curl -fsSL -m 600 -o "$tmp/release.tar.gz" "$url"; do
    [ "$try" -ge 3 ] && { rm -rf "$tmp"; die "Could not download $url"; }
    try=$((try + 1)); sleep 2
  done
  mkdir "$tmp/x"
  tar -xzf "$tmp/release.tar.gz" -C "$tmp/x" || { rm -rf "$tmp"; die "The download is damaged. Try again."; }
  dir="$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [ ! -f "$dir/xeldash.sh" ] || [ ! -f "$dir/docker-compose.yml" ] || [ "$(tr -d '[:space:]' < "$dir/VERSION" 2>/dev/null)" != "$version" ]; then
    rm -rf "$tmp"; die "That download is not xelDash release $version. Nothing was changed."
  fi
  cp -R "$dir"/. ./ || { rm -rf "$tmp"; die "Could not copy the new files into this folder."; }
  rm -rf "$tmp"
  set_env XELDASH_VERSION "$version"
  exec bash ./xeldash.sh _finish-update "$version"   # this folder is the script's own (it changed into it at the start)
}

cmd_finish_update() {
  [ -z "${XELDASH_UPDATE_NO_START:-}" ] || { ok "Updated to ${1:-the new version} (not started: XELDASH_UPDATE_NO_START)."; return 0; }
  check_docker
  compose_up
  ok "xelDash is updated to ${1:-the new version} and running. Your settings and data were kept."
}

cmd_update() {
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first."
  check_docker
  # A release install (XELDASH_VERSION is a version number) updates to the newest release; a source install (local) pulls and rebuilds.
  local running; running="$(get_env XELDASH_VERSION)"
  if [ -n "$running" ] && [ "$running" != local ]; then update_release "$running"; return; fi
  if [ -d .git ] && command -v git >/dev/null 2>&1; then
    say "Getting the newest xelDash..."
    git pull --ff-only || die "Could not update automatically (you may have changed files). Run: git status"
  else
    warn "This folder was not downloaded with git, so it cannot update itself. Download the newest release and copy your .env into it."
    exit 1
  fi
  compose_up
  ok "xelDash is updated and running. Your settings and data were kept."
}

# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the /tmp paths; it does nothing elsewhere.
# Backups hold the statistics (miners, workers, blocks), not the blockchain or your wallet.
backup_dir() { local d; d="$(get_env XELDASH_BACKUP_DIR)"; printf '%s' "${d:-./backups}"; }
db_user() { local u; u="$(get_env POSTGRES_USER)"; printf '%s' "${u:-xeldash}"; }
db_name() { local d; d="$(get_env POSTGRES_DB)"; printf '%s' "${d:-xeldash}"; }

cmd_backup() {
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first."
  check_docker
  local dir file; dir="$(backup_dir)"; mkdir -p "$dir"
  file="$dir/xeldash-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # Dumped inside the database container and copied out, so no tool is needed on this computer.
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres pg_dump -U "$(db_user)" --format=custom --file=/tmp/xeldash-backup.dump "$(db_name)" \
    || die "The backup failed. Is xelDash running? Start it with: ./xeldash.sh start"
  MSYS_NO_PATHCONV=1 docker compose cp postgres:/tmp/xeldash-backup.dump "$file" || die "Could not copy the backup out of the database container."
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres rm -f /tmp/xeldash-backup.dump || true
  chmod 600 "$file" 2>/dev/null || true
  ok "Backup saved: $file"
  say "It holds miner addresses and IP addresses: keep it private, and copy it off this computer too."
}

cmd_restore() {
  local file="${1:-}" yes="${2:-}"
  [ -n "$file" ] || die "Say which backup to restore: ./xeldash.sh restore backups/xeldash-....dump"
  [ -f "$file" ] || die "No such file: $file"
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first."
  check_docker
  if [ "$yes" != "--yes" ]; then
    warn "This replaces your current statistics (miners, workers, blocks, events) with the ones in the backup."
    read -r -p "Type yes to continue: " reply || reply=""
    [ "$reply" = yes ] || die "Cancelled. Nothing was changed."
  fi
  docker compose stop stratum api
  MSYS_NO_PATHCONV=1 docker compose cp "$file" postgres:/tmp/xeldash-restore.dump
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres pg_restore -U "$(db_user)" -d "$(db_name)" --clean --if-exists /tmp/xeldash-restore.dump \
    || warn "pg_restore reported problems (some can be harmless). Check the dashboard."
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres rm -f /tmp/xeldash-restore.dump || true
  compose_up
  ok "Backup restored and xelDash is running."
}

# ---------------------------------------------------------------- cluster (two servers, Linux only)

cluster_need_linux() {
  [ "$(uname -s)" = Linux ] || die "Redundancy between two servers needs Linux with Docker Engine. Docker Desktop (Windows, macOS) cannot hold a shared address on your network. See docs/OPERATIONS.md#redundancy-two-servers"
  if grep -qiE 'microsoft|linuxkit' /proc/sys/kernel/osrelease 2>/dev/null || docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'; then
    die "This Docker runs in a virtual machine (Docker Desktop or WSL), which cannot hold a shared address on your network. Use Linux with Docker Engine. See docs/OPERATIONS.md#redundancy-two-servers"
  fi
}

# The address of this computer with its prefix length, e.g. 192.168.1.10/24.
lan_cidr() { ip -o -4 addr show scope global 2>/dev/null | awk -v ip="$1" 'index($4, ip "/") == 1 { print $4; exit }'; }

# An address near the top of the home network that nothing answers on, to share between the two servers.
suggest_vip() {
  local base="${1%.*}" n
  for n in 250 249 248 247 246 245 244 243 242 241 240; do
    if ! ping -c1 -W1 "$base.$n" >/dev/null 2>&1 && ! ip neigh show "$base.$n" 2>/dev/null | grep -q lladdr; then printf '%s' "$base.$n"; return; fi
  done
}

json_get() { sed -n 's/.*"'"$1"'":"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p' | head -1; }

cluster_setup() {
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first, then come back."
  check_docker; cluster_need_linux
  [ -z "$(get_env XELDASH_VIP)" ] || die "This server is already part of a cluster. Show it with: ./xeldash.sh cluster status"
  local vip="" yes="" arg
  for arg in "$@"; do case "$arg" in --yes) yes=1 ;; --vip=*) vip="${arg#--vip=}" ;; esac; done
  local ip; ip="$(lan_ip)"
  [ -n "$ip" ] && is_private_ip "$ip" || die "Could not find this server's address on your home network. Set it up with ./xeldash.sh lan on first."
  local cidr prefix; cidr="$(lan_cidr "$ip")"; prefix="${cidr#*/}"; [ -n "$prefix" ] && [ "$prefix" != "$cidr" ] || prefix=24
  if [ -z "$vip" ]; then
    local guess; guess="$(suggest_vip "$ip")"
    say ""
    say "Your two servers will share one address, and your miners connect to it. It must be an unused address on your home network"
    say "(outside your router's automatic range if you can; your router's settings show it)."
    if [ -n "$yes" ]; then vip="$guess"; else read -r -p "Shared address [$guess]: " vip || vip=""; vip="${vip:-$guess}"; fi
  fi
  [[ "$vip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && is_private_ip "$vip" || die "That is not a home-network address: $vip"
  [ "$vip" != "$ip" ] || die "The shared address must differ from this server's own address ($ip)."
  ping -c1 -W1 "$vip" >/dev/null 2>&1 && die "Something already answers on $vip. Pick an address nothing uses."

  local id secret name; id=$(( 1 + 0x$(random_hex 1) % 254 )); secret="$(random_hex 16)"; name="$(hostname)"
  lan_on "$ip" >/dev/null || true
  set_env XELDASH_CLUSTER_SECRET "$secret"
  set_env XELDASH_CLUSTER_ID "$id"
  set_env XELDASH_VIP "$vip/$prefix"
  set_env XELDASH_SERVER_NAME "$name"
  set_env XELDASH_PUBLIC_HOST "$vip"
  set_env COMPOSE_FILE "docker-compose.yml:docker-compose.cluster.yml"
  say "Starting the address manager..."
  compose_up
  # What the second server needs to know, as one code to paste.
  local address network primary json code
  address="$(curl -s -m 3 "http://127.0.0.1:$(web_port)/api/v1/node/mining-address" 2>/dev/null | json_get address)"
  network="$(get_env XELIS_NETWORK)"; primary="http://$ip:$(web_port)"
  json="$(printf '{"v":1,"vip":"%s/%s","id":%s,"secret":"%s","network":"%s","address":"%s","primary":"%s","name":"%s"}' "$vip" "$prefix" "$id" "$secret" "${network:-mainnet}" "$address" "$primary" "$name")"
  code="xelcluster1:$(printf '%s' "$json" | base64 | tr -d '\n')"
  ok "This server is set up. Miners should connect to $vip (port 3333). It is shared with your second server."
  say ""
  say "Now set up the second server (Linux, on the same network):"
  say "  1. Download xelDash there, and run:   ${B}./xeldash.sh cluster join $code${N}"
  say "  2. Wait for it to finish syncing its node (the first time it downloads the blockchain)."
  say "Keep that code private: it holds the cluster secret. Show the cluster any time with: ./xeldash.sh cluster status"
}

# A cluster code is pasted from somewhere, so every field is checked before it is written to .env (where Docker Compose reads
# it and the address manager's configuration is built from it): a crafted code must not be able to point this server's
# records and secret at another computer, or put extra text into a configuration file.
cluster_code_ok() {
  local vip="$1" id="$2" secret="$3" network="$4" address="$5" primary="$6" name="$7" host
  [[ "$vip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] && is_private_ip "${vip%/*}" && [ "${vip#*/}" -ge 8 ] && [ "${vip#*/}" -le 30 ] || { warn "The shared address in the code is not a home-network address: $vip"; return 1; }
  [[ "$id" =~ ^[0-9]{1,3}$ ]] && [ "$id" -ge 1 ] && [ "$id" -le 255 ] || { warn "The cluster number in the code is not valid."; return 1; }
  [[ "$secret" =~ ^[0-9a-f]{32}$ ]] || { warn "The cluster secret in the code is not valid."; return 1; }
  case "$network" in mainnet|testnet|devnet|"") ;; *) warn "The network in the code is not valid: $network"; return 1 ;; esac
  [[ -z "$address" || "$address" =~ ^(xel|xet):[a-z0-9]{30,120}$ ]] || { warn "The wallet address in the code is not valid."; return 1; }
  [[ "$primary" =~ ^http://([^/:]+):[0-9]{2,5}$ ]] || { warn "The main server's address in the code is not valid: $primary"; return 1; }
  host="${BASH_REMATCH[1]}"
  if [[ "$host" =~ ^[0-9.]+$ ]]; then is_private_ip "$host" || { warn "The main server's address ($host) is not on a home network."; return 1; }
  else [[ "$host" =~ ^[A-Za-z0-9-]+(\.(local|lan|home))?$ ]] || { warn "The main server's name in the code is not valid: $host"; return 1; }; fi
  [[ "$name" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { warn "The server name in the code is not valid."; return 1; }
}

cluster_join() {
  local code="${1:-}"
  [ -n "$code" ] || die "Say which cluster to join: ./xeldash.sh cluster join xelcluster1:..."
  case "$code" in xelcluster1:*) ;; *) die "That is not a cluster code. It starts with xelcluster1:" ;; esac
  local json; json="$(printf '%s' "${code#xelcluster1:}" | base64 -d 2>/dev/null)" || die "The cluster code is damaged. Copy it again in full."
  local vip id secret network address primary name
  vip="$(printf '%s' "$json" | json_get vip)"; id="$(printf '%s' "$json" | json_get id)"; secret="$(printf '%s' "$json" | json_get secret)"
  network="$(printf '%s' "$json" | json_get network)"; address="$(printf '%s' "$json" | json_get address)"
  primary="$(printf '%s' "$json" | json_get primary)"; name="$(printf '%s' "$json" | json_get name)"
  [ -n "$vip" ] && [ -n "$id" ] && [ -n "$secret" ] && [ -n "$primary" ] || die "The cluster code is incomplete. Copy it again in full."
  cluster_code_ok "$vip" "$id" "$secret" "$network" "$address" "$primary" "$name" || die "The cluster code was refused. Copy it again from the main server (./xeldash.sh cluster setup prints it)."
  check_docker; cluster_need_linux
  if [ ! -f .env ]; then cp .env.example .env; chmod 600 .env 2>/dev/null || true; use_release_version; fi
  [ -z "$(get_env XELDASH_PRIMARY_URL)" ] || die "This server already joined a cluster."
  set_env XELIS_NETWORK "${network:-mainnet}"
  set_env XELIS_SNAPSHOT_AUTO true
  set_env XELDASH_PRIMARY_URL "$primary"
  set_env XELDASH_CLUSTER_SECRET "$secret"
  set_env XELDASH_CLUSTER_ID "$id"
  set_env XELDASH_VIP "$vip"
  [ -z "$address" ] || set_env XELIS_DEFAULT_ADDRESS "$address"
  set_env XELDASH_SERVER_NAME "$(hostname)"
  [ -n "$(get_env XELDASH_ADMIN_TOKEN)" ] || set_env XELDASH_ADMIN_TOKEN "$(random_hex 24)"
  set_env XELDASH_WEB_BIND_IP 0.0.0.0
  set_env XELDASH_STRATUM_BIND_IP 0.0.0.0
  set_env COMPOSE_FILE "docker-compose.standby.yml"
  if ! curl -fs -m 5 -H "x-cluster-secret: $secret" "$primary/api/v1/ingest/ping" >/dev/null 2>&1; then
    warn "The main server at $primary did not answer. Check that it is running and that the code is right. Continuing: this server keeps its records and sends them when the main server answers."
  else
    ok "The main server answers."
  fi
  say "Starting this server. The first time it downloads the blockchain (about 10 GB) and builds or pulls the images."
  compose_up
  ok "This server is the standby. It takes over the shared address by itself if the main server stops."
  say "  Its page (the main dashboard, or an offline notice) is at http://$(lan_ip):$(web_port)"
}

cluster_status() {
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first."
  [ -n "$(get_env XELDASH_VIP)" ] || { say "This server is not part of a cluster. Set one up with: ./xeldash.sh cluster setup"; return; }
  check_docker
  local role="standby server"; [ -z "$(get_env XELDASH_PRIMARY_URL)" ] && role="main server"
  say "This is the $role. Shared address: $(get_env XELDASH_VIP)  (miners connect to its port 3333)"
  local state; state="$(docker compose exec -T keepalived cat /config/cluster.json 2>/dev/null | json_get state)"
  case "$state" in
    MASTER) say "It holds the shared address now: your rigs mine on this server." ;;
    BACKUP) say "It is standing by: your rigs mine on the other server." ;;
    FAULT)  say "It cannot mine right now (its node is not ready), so it gave the address to the other server." ;;
    *)      say "The address manager is not running. Start it with: ./xeldash.sh start" ;;
  esac
}

cluster_off() {
  [ -n "$(get_env XELDASH_VIP)" ] || die "This server is not part of a cluster."
  [ -z "$(get_env XELDASH_PRIMARY_URL)" ] || die "This is the standby server. To remove it, run: docker compose down -v, and delete this folder. The main server keeps working on its own after ./xeldash.sh cluster off."
  check_docker
  set_env XELDASH_VIP ""; set_env XELDASH_CLUSTER_ID ""; set_env XELDASH_CLUSTER_SECRET ""; set_env COMPOSE_FILE ""
  docker compose up -d --remove-orphans >/dev/null
  ok "This server is on its own again. Point your miners back at this server's own address."
}

cmd_cluster() {
  case "${1:-status}" in
    setup)  shift; cluster_setup "$@" ;;
    join)   shift; cluster_join "$@" ;;
    status) cluster_status ;;
    off)    cluster_off ;;
    *)      die "Use: ./xeldash.sh cluster setup | join CODE | status | off" ;;
  esac
}

# ---------------------------------------------------------------- front door (a Linux box in front of the main server)

# Docker Desktop (Windows, macOS, or Linux with Desktop) shows every outside client as the network's gateway.
docker_is_desktop() {
  [ "$(uname -s)" != Linux ] || grep -qiE 'microsoft|linuxkit' /proc/sys/kernel/osrelease 2>/dev/null || docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'
}

frontdoor_setup() {
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first, then come back."
  check_docker
  [ -z "$(get_env STRATUM_PROXY_FROM)" ] || die "A front door is already set up. Show it with: ./xeldash.sh frontdoor status"
  local from="" arg
  for arg in "$@"; do case "$arg" in --from=*) from="${arg#--from=}" ;; esac; done
  local ip; ip="$(lan_ip)"
  [ -n "$ip" ] && is_private_ip "$ip" || die "Could not find this server's address on your home network. Set it up with ./xeldash.sh lan on first."
  if [ -z "$from" ]; then
    say ""
    say "The front door is a second, Linux computer that your miners connect to. What is its address on your home network?"
    say "(Find it on that computer with: hostname -I)"
    read -r -p "Front door's address: " from || from=""
  fi
  [[ "$from" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && is_private_ip "$from" || die "That is not a home-network address: $from"
  [ "$from" != "$ip" ] || die "The front door must be a different computer than this one ($ip)."
  local secret; secret="$(get_env XELDASH_CLUSTER_SECRET)"; [ -n "$secret" ] || secret="$(random_hex 16)"
  lan_on "$ip" >/dev/null || true
  set_env XELDASH_CLUSTER_SECRET "$secret"
  set_env XELDASH_SERVER_NAME "$(hostname)"
  # The Stratum believes the front door's PROXY line (the real miner's address) from this address only; Docker Desktop shows
  # every outside computer as its gateway, so there that has to be trusted too.
  if docker_is_desktop; then set_env STRATUM_PROXY_FROM "$from,gateway"; else set_env STRATUM_PROXY_FROM "$from"; fi
  say "Restarting to accept the front door..."
  compose_up
  frontdoor_code_print "$ip" "$secret"
}

frontdoor_code_print() {
  local ip="$1" secret="$2" address network json code stratum getwork
  address="$(curl -s -m 3 "http://127.0.0.1:$(web_port)/api/v1/node/mining-address" 2>/dev/null | json_get address)"
  network="$(get_env XELIS_NETWORK)"
  stratum="$(get_env XELDASH_STRATUM_PORT)"; getwork="$(get_env XELDASH_GETWORK_PORT)"
  json="$(printf '{"v":1,"secret":"%s","network":"%s","address":"%s","host":"%s","webPort":%s,"stratumPort":%s,"getworkPort":%s,"name":"%s"}' \
    "$secret" "${network:-mainnet}" "$address" "$ip" "$(web_port)" "${stratum:-3333}" "${getwork:-8090}" "$(hostname)")"
  code="xelfront1:$(printf '%s' "$json" | base64 | tr -d '\n')"
  ok "This server accepts the front door."
  say ""
  say "Now, on the Linux computer that will be the front door:"
  say "  1. Download xelDash there, and run:   ${B}./xeldash.sh frontdoor join $code${N}"
  say "  2. Wait for its node to sync (the first time it downloads the blockchain)."
  say "  3. Point your miners at the front door's address (port 3333) instead of this server."
  say "Keep that code private: it holds the secret. Miners should connect only through the front door from now on."
}

# Pasted from somewhere, so every field is checked before it reaches .env.
frontdoor_code_ok() {
  local secret="$1" network="$2" address="$3" host="$4" web="$5" stratum="$6" getwork="$7" name="$8" p
  [[ "$secret" =~ ^[0-9a-f]{32}$ ]] || { warn "The secret in the code is not valid."; return 1; }
  case "$network" in mainnet|testnet|devnet|"") ;; *) warn "The network in the code is not valid: $network"; return 1 ;; esac
  [[ -z "$address" || "$address" =~ ^(xel|xet):[a-z0-9]{30,120}$ ]] || { warn "The wallet address in the code is not valid."; return 1; }
  [[ "$host" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && is_private_ip "$host" || { warn "The main server's address in the code is not a home-network address: $host"; return 1; }
  for p in "$web" "$stratum" "$getwork"; do [[ "$p" =~ ^[0-9]{2,5}$ ]] && [ "$p" -le 65535 ] || { warn "A port number in the code is not valid: $p"; return 1; }; done
  [[ "$name" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { warn "The server name in the code is not valid."; return 1; }
}

frontdoor_join() {
  local code="${1:-}"
  [ -n "$code" ] || die "Say which server to join: ./xeldash.sh frontdoor join xelfront1:..."
  case "$code" in xelfront1:*) ;; *) die "That is not a front door code. It starts with xelfront1:" ;; esac
  local json; json="$(printf '%s' "${code#xelfront1:}" | base64 -d 2>/dev/null)" || die "The code is damaged. Copy it again in full."
  local secret network address host web stratum getwork name
  secret="$(printf '%s' "$json" | json_get secret)"; network="$(printf '%s' "$json" | json_get network)"; address="$(printf '%s' "$json" | json_get address)"
  host="$(printf '%s' "$json" | json_get host)"; web="$(printf '%s' "$json" | json_get webPort)"; stratum="$(printf '%s' "$json" | json_get stratumPort)"
  getwork="$(printf '%s' "$json" | json_get getworkPort)"; name="$(printf '%s' "$json" | json_get name)"
  [ -n "$secret" ] && [ -n "$host" ] && [ -n "$web" ] && [ -n "$stratum" ] && [ -n "$getwork" ] || die "The code is incomplete. Copy it again in full."
  frontdoor_code_ok "$secret" "$network" "$address" "$host" "$web" "$stratum" "$getwork" "$name" || die "The code was refused. Copy it again from the main server (./xeldash.sh frontdoor setup prints it)."
  check_docker
  if docker_is_desktop; then die "The front door needs Linux with Docker Engine: Docker Desktop hides the miners' addresses from it. See docs/OPERATIONS.md#front-door-a-box-miners-connect-to"; fi
  if [ ! -f .env ]; then cp .env.example .env; chmod 600 .env 2>/dev/null || true; use_release_version; fi
  [ -z "$(get_env FRONTDOOR_MAIN_HOST)" ] || die "This computer is already a front door."
  [ -z "$(get_env XELDASH_PRIMARY_URL)" ] || die "This computer is already the second server of a cluster."
  set_env XELIS_NETWORK "${network:-mainnet}"
  set_env XELIS_SNAPSHOT_AUTO true
  set_env XELDASH_PRIMARY_URL "http://$host:$web"
  set_env XELDASH_CLUSTER_SECRET "$secret"
  set_env FRONTDOOR_MAIN_HOST "$host"
  set_env FRONTDOOR_MAIN_HEALTH_PORT "$web"
  set_env FRONTDOOR_MAIN_STRATUM_PORT "$stratum"
  set_env FRONTDOOR_MAIN_GETWORK_PORT "$getwork"
  [ -z "$address" ] || set_env XELIS_DEFAULT_ADDRESS "$address"
  set_env XELDASH_SERVER_NAME "$(hostname)"
  [ -n "$(get_env XELDASH_ADMIN_TOKEN)" ] || set_env XELDASH_ADMIN_TOKEN "$(random_hex 24)"
  set_env XELDASH_WEB_BIND_IP 0.0.0.0
  set_env XELDASH_STRATUM_BIND_IP 0.0.0.0
  set_env COMPOSE_FILE "docker-compose.frontdoor.yml"
  if ! curl -fs -m 5 -H "x-cluster-secret: $secret" "http://$host:$web/api/v1/ingest/ping" >/dev/null 2>&1; then
    warn "The main server at $host did not answer. Check that it is running and that the code is right. Continuing: this computer keeps its records and sends them when the main server answers."
  else
    ok "The main server answers."
  fi
  say "Starting the front door. The first time it downloads the blockchain (about 10 GB) and builds or pulls the images."
  compose_up
  ok "The front door is running. Point your miners at $(lan_ip) (port 3333): they reach the main server while it can mine, and this computer when it cannot."
  say "  Its page (the main dashboard, or an offline notice) is at http://$(lan_ip):$(get_env XELDASH_WEB_PORT | sed 's/^$/8088/')"
}

frontdoor_status() {
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first."
  check_docker
  if [ -n "$(get_env FRONTDOOR_MAIN_HOST)" ]; then
    local host; host="$(get_env FRONTDOOR_MAIN_HOST)"
    say "This is the front door. Miners connect here (port 3333)."
    if curl -fs -m 4 "http://$host:$(get_env FRONTDOOR_MAIN_HEALTH_PORT)/api/v1/mining-health" >/dev/null 2>&1; then
      say "The main server ($host) can mine: miners are sent there."
    else
      say "The main server ($host) cannot mine right now (or does not answer): miners are mining on this computer."
    fi
  elif [ -n "$(get_env STRATUM_PROXY_FROM)" ]; then
    say "This is the main server. It accepts a front door at: $(get_env STRATUM_PROXY_FROM)"
  else
    say "No front door is set up. Set one up with: ./xeldash.sh frontdoor setup"
  fi
}

frontdoor_off() {
  [ -z "$(get_env FRONTDOOR_MAIN_HOST)" ] || die "This is the front door itself. To remove it, run: docker compose down -v, and delete this folder. The main server keeps working on its own after ./xeldash.sh frontdoor off."
  [ -n "$(get_env STRATUM_PROXY_FROM)" ] || die "No front door is set up."
  check_docker
  set_env STRATUM_PROXY_FROM ""
  [ -n "$(get_env XELDASH_VIP)" ] || set_env XELDASH_CLUSTER_SECRET ""
  compose_up
  ok "The front door is off. Point your miners back at this server's own address."
}

cmd_frontdoor() {
  case "${1:-status}" in
    setup)  shift; frontdoor_setup "$@" ;;
    join)   shift; frontdoor_join "$@" ;;
    status) frontdoor_status ;;
    off)    frontdoor_off ;;
    *)      die "Use: ./xeldash.sh frontdoor setup | join CODE | status | off" ;;
  esac
}

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  "")       if [ -f .env ]; then check_docker; docker compose ps; say ""; say "Dashboard: http://localhost:$(web_port)   (more: ./xeldash.sh help)"; else cmd_install; fi ;;
  install)  shift; cmd_install "$@" ;;
  start)    cmd_start ;;
  stop)     check_docker; docker compose stop; ok "xelDash is stopped. Your data is kept. Start again with: ./xeldash.sh start" ;;
  restart)  check_docker; docker compose restart; ok "Restarted." ;;
  status)   check_docker; docker compose ps ;;
  logs)     shift; check_docker; docker compose logs -f --tail 100 "$@" ;;
  open)     open_url "http://localhost:$(web_port)/" ;;
  token)    t="$(get_env XELDASH_ADMIN_TOKEN)"; [ -n "$t" ] && say "$t" || die "No admin password is set in .env." ;;
  lan)      shift; cmd_lan "$@" ;;
  update)   cmd_update ;;
  _finish-update) shift; cmd_finish_update "$@" ;;
  cluster)  shift; cmd_cluster "$@" ;;
  frontdoor) shift; cmd_frontdoor "$@" ;;
  backup)   cmd_backup ;;
  restore)  shift; cmd_restore "$@" ;;
  help|-h|--help) usage ;;
  *)        say "Unknown command: $1"; usage; exit 1 ;;
esac
