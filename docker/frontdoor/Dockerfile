FROM haproxy:3.0-alpine
# HAProxy forwards miners' TCP connections to the main server, or to the local standby Stratum when the main one cannot mine.
USER root
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/entrypoint.sh"]
