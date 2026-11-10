#!/bin/sh
set -eu

: "${LICENSE_DOMAIN:?LICENSE_DOMAIN is required}"
: "${NGINX_MAX_BODY_SIZE:=2048m}"

HTTP_TEMPLATE=/etc/nginx/ust-templates/http.conf.template
HTTPS_TEMPLATE=/etc/nginx/ust-templates/https.conf.template
ACTIVE_CONFIG=/etc/nginx/conf.d/default.conf
CERTIFICATE=/etc/letsencrypt/live/${LICENSE_DOMAIN}/fullchain.pem
RELOAD_MARKER=/var/www/certbot/.nginx-reload

render_config() {
    template="$HTTP_TEMPLATE"
    if [ -s "$CERTIFICATE" ]; then
        template="$HTTPS_TEMPLATE"
    fi

    temporary_config="${ACTIVE_CONFIG}.new"
    envsubst '${LICENSE_DOMAIN} ${NGINX_MAX_BODY_SIZE}' < "$template" > "$temporary_config"

    if [ ! -f "$ACTIVE_CONFIG" ] || ! cmp -s "$temporary_config" "$ACTIVE_CONFIG"; then
        mv "$temporary_config" "$ACTIVE_CONFIG"
        return 0
    fi

    rm -f "$temporary_config"
    return 1
}

render_config || true
nginx -t

(
    last_reload_marker=""
    while true; do
        sleep 30
        should_reload=0

        if render_config; then
            should_reload=1
        fi

        current_reload_marker=""
        if [ -f "$RELOAD_MARKER" ]; then
            current_reload_marker="$(cat "$RELOAD_MARKER")"
        fi
        if [ -n "$current_reload_marker" ] && [ "$current_reload_marker" != "$last_reload_marker" ]; then
            last_reload_marker="$current_reload_marker"
            should_reload=1
        fi

        if [ "$should_reload" -eq 1 ] && nginx -t; then
            nginx -s reload
        fi
    done
) &

exec nginx -g 'daemon off;'
