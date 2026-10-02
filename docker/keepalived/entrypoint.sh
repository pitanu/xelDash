#!/bin/sh
# Writes keepalived's configuration from the environment, then runs it in the foreground.
#
#   XELDASH_VIP            the shared address with its prefix length, e.g. 192.168.1.50/24 (required)
#   XELDASH_CLUSTER_ID     1-255; the same on both servers, different from any other VRRP group on the network
#   XELDASH_VIP_INTERFACE  the network interface; found from the default route when empty
#   XELDASH_CLUSTER_PRIORITY  100 on both servers: neither takes the address back from the other (nopreempt)
#   XELDASH_STRATUM_HEALTH_PORT  where Stratum reports whether it can mine (8096)
set -eu

vip="${XELDASH_VIP:-}"
id="${XELDASH_CLUSTER_ID:-}"
[ -n "$vip" ] || { echo "cluster: set XELDASH_VIP (for example 192.168.1.50/24) in .env" >&2; exit 1; }
case "$vip" in */*) ;; *) echo "cluster: XELDASH_VIP needs a prefix length, for example 192.168.1.50/24" >&2; exit 1 ;; esac
case "$id" in ''|*[!0-9]*) echo "cluster: XELDASH_CLUSTER_ID must be a number from 1 to 255" >&2; exit 1 ;; esac
{ [ "$id" -ge 1 ] && [ "$id" -le 255 ]; } || { echo "cluster: XELDASH_CLUSTER_ID must be from 1 to 255" >&2; exit 1; }

iface="${XELDASH_VIP_INTERFACE:-}"
if [ -z "$iface" ]; then
  iface="$(ip -4 route show default | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')"
fi
[ -n "$iface" ] || { echo "cluster: could not find the network interface; set XELDASH_VIP_INTERFACE in .env" >&2; exit 1; }
export XELDASH_VIP_INTERFACE="$iface"

priority="${XELDASH_CLUSTER_PRIORITY:-100}"
port="${XELDASH_STRATUM_HEALTH_PORT:-8096}"

mkdir -p /etc/keepalived
cat > /etc/keepalived/keepalived.conf <<CONF
global_defs {
  router_id xeldash
  enable_script_security
  script_user root
}

# Healthy only while Stratum can give miners work. Three failures in a row (about 6 seconds) make this
# server give up the shared address; two successes bring it back as a standby.
vrrp_script xeldash_can_mine {
  script "/usr/local/bin/check.sh $port"
  interval 2
  timeout 3
  fall 3
  rise 2
}

vrrp_instance xeldash {
  state BACKUP
  interface $iface
  virtual_router_id $id
  priority $priority
  # A server that comes back keeps standing by instead of taking the address back (no second interruption).
  nopreempt
  advert_int 1
  virtual_ipaddress {
    $vip dev $iface
  }
  track_script {
    xeldash_can_mine
  }
  notify /usr/local/bin/notify.sh
}
CONF

echo "cluster: shared address $vip on $iface, group $id, priority $priority"
/usr/local/bin/notify.sh INSTANCE xeldash BACKUP "$priority"
exec keepalived --dont-fork --log-console --log-detail -f /etc/keepalived/keepalived.conf
