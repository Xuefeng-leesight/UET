#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${ENV_FILE:-${PROJECT_DIR}/.env.production}
COMPOSE_FILE=${PROJECT_DIR}/docker-compose.prod.yml

if [ ! -f "$ENV_FILE" ]; then
    echo "缺少 ${ENV_FILE}；请先复制 .env.production.example 并填写生产配置。" >&2
    exit 1
fi

UST_ENV_FILE="$ENV_FILE" docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    up -d --build --remove-orphans

UST_ENV_FILE="$ENV_FILE" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
