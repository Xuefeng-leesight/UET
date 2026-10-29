#!/bin/sh
set -eu

: "${LICENSE_DOMAIN:?LICENSE_DOMAIN is required}"
: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL is required}"

WEBROOT=/var/www/certbot
CERTIFICATE=/etc/letsencrypt/live/${LICENSE_DOMAIN}/fullchain.pem
RELOAD_MARKER=${WEBROOT}/.nginx-reload

while [ ! -s "$CERTIFICATE" ]; do
    if certbot certonly \
        --webroot \
        --webroot-path "$WEBROOT" \
        --domain "$LICENSE_DOMAIN" \
        --cert-name "$LICENSE_DOMAIN" \
        --email "$LETSENCRYPT_EMAIL" \
        --agree-tos \
        --no-eff-email \
        --non-interactive; then
        date +%s > "$RELOAD_MARKER"
        break
    fi

    echo "证书首次签发失败，30 分钟后重试。请检查 DNS 以及 80 端口。" >&2
    sleep 1800
done

while true; do
    certbot renew \
        --webroot \
        --webroot-path "$WEBROOT" \
        --deploy-hook "date +%s > $RELOAD_MARKER" \
        --non-interactive || true
    sleep 43200
done
