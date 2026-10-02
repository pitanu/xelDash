FROM nginx:1.29-alpine
# The standby server's web page: shows the main server's dashboard through, and an "offline" page that says mining
# continues when the main server cannot be reached. PRIMARY_URL is the main server's dashboard, e.g. http://192.168.1.10:8088.
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY offline.html /usr/share/nginx/html/offline.html
EXPOSE 8080
