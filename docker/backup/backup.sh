#!/bin/sh
# Periodic pg_dump for the optional `backup` Compose service. Writes custom-format dumps to
# /backups and keeps the newest BACKUP_KEEP. A dump is written to a .partial file first and
# only renamed when pg_dump succeeds, so a failed run never replaces a good backup.
set -eu
# Dumps hold miner addresses and IPs: owner-only files.
umask 077

interval_hours="${BACKUP_INTERVAL_HOURS:-24}"
keep="${BACKUP_KEEP:-7}"

while true; do
  file="/backups/xeldash-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if pg_dump --format=custom --file="$file.partial"; then
    mv "$file.partial" "$file"
    echo "backup: wrote $file ($(du -h "$file" | cut -f1))"
  else
    rm -f "$file.partial"
    echo "backup: pg_dump failed; keeping the previous backups" >&2
  fi
  ls -1t /backups/xeldash-*.dump 2>/dev/null | tail -n "+$((keep + 1))" | xargs -r rm -f
  sleep "$((interval_hours * 3600))"
done
