#!/bin/sh
# keepalived runs this every few seconds: exit 0 only while this server can give miners work
# (a node is ready and the database answers). Failing it makes this server give up the shared address.
exec curl -sf --max-time 2 "http://127.0.0.1:${1:-8096}/healthz" > /dev/null
