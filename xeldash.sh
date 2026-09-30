#!/usr/bin/env bash
# xelDash launcher for Linux and macOS: set it up, start it, stop it, update it.
#
#   ./xeldash.sh            first time: guided setup; afterwards: shows what is running
#   ./xeldash.sh install    guided setup (creates .env, starts xelDash, opens the dashboard)
#   ./xeldash.sh start | stop | restart | status | logs [service] | open | token
#   ./xeldash.sh lan on|off|status    let other computers on your network use xelDash
#   ./xeldash.sh update     get the newest xelDash and restart it
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

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

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
  help|-h|--help) usage ;;
  *)        say "Unknown command: $1"; usage; exit 1 ;;
esac
