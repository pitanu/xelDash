FROM nginx:1.31-alpine
# The standby server's web page: shows the main server's dashboard through, and an "offline" page that says mining
# continues when the main server cannot be reached. PRIMARY_URL is the main server's dashboard, e.g. http://192.168.1.10:8088.
# Built from the repository root: the host names it answers to come from the dashboard's own script (docker/web/42-allowed-hosts.sh).
COPY docker/standby-web/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/standby-web/offline.html /usr/share/nginx/html/offline.html
COPY --chmod=755 docker/web/42-allowed-hosts.sh /docker-entrypoint.d/42-allowed-hosts.sh
RUN mkdir -p /etc/nginx/snippets
EXPOSE 8080
