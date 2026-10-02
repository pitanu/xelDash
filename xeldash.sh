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

cmd_update() {
  [ -f .env ] || die "xelDash is not set up yet. Run ./xeldash.sh first."
  check_docker
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

cluster_join() {
  local code="${1:-}"
  [ -n "$code" ] || die "Say which cluster to join: ./xeldash.sh cluster join xelcluster1:..."
  check_docker; cluster_need_linux
  case "$code" in xelcluster1:*) ;; *) die "That is not a cluster code. It starts with xelcluster1:" ;; esac
  local json; json="$(printf '%s' "${code#xelcluster1:}" | base64 -d 2>/dev/null)" || die "The cluster code is damaged. Copy it again in full."
  local vip id secret network address primary name
  vip="$(printf '%s' "$json" | json_get vip)"; id="$(printf '%s' "$json" | json_get id)"; secret="$(printf '%s' "$json" | json_get secret)"
  network="$(printf '%s' "$json" | json_get network)"; address="$(printf '%s' "$json" | json_get address)"
  primary="$(printf '%s' "$json" | json_get primary)"; name="$(printf '%s' "$json" | json_get name)"
  [ -n "$vip" ] && [ -n "$id" ] && [ -n "$secret" ] && [ -n "$primary" ] || die "The cluster code is incomplete. Copy it again in full."
  [ -f .env ] || cp .env.example .env
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

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

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
  cluster)  shift; cmd_cluster "$@" ;;
  backup)   cmd_backup ;;
  restore)  shift; cmd_restore "$@" ;;
  help|-h|--help) usage ;;
  *)        say "Unknown command: $1"; usage; exit 1 ;;
esac
