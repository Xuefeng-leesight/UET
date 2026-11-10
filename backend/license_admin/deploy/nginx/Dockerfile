FROM nginx:stable-alpine

COPY http.conf.template /etc/nginx/ust-templates/http.conf.template
COPY https.conf.template /etc/nginx/ust-templates/https.conf.template
COPY start.sh /usr/local/bin/ust-nginx-start

RUN chmod 0755 /usr/local/bin/ust-nginx-start \
    && rm -f /etc/nginx/conf.d/default.conf

ENTRYPOINT ["/usr/local/bin/ust-nginx-start"]
