#!/usr/bin/env bash
# Run Invintel behind nginx on this machine.
#   deploy/nginx/run-local.sh start   build the web app, start nginx on port 8080 (all interfaces)
#   deploy/nginx/run-local.sh stop
#   deploy/nginx/run-local.sh status
# The API must already be running (default 127.0.0.1:3001; set API_PORT to change). Nothing here touches nginx's global config:
# it uses its own prefix directory under ~/.invintel-nginx.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PREFIX="${INVINTEL_NGINX_PREFIX:-$HOME/.invintel-nginx}"
API_PORT="${API_PORT:-3001}"
LISTEN="${LISTEN:-8080}"   # use 127.0.0.1:8080 to keep it to this machine
NGINX="${NGINX:-$(command -v nginx || echo /opt/homebrew/bin/nginx)}"

case "${1:-}" in
  start)
    mkdir -p "$PREFIX"
    (cd "$ROOT" && pnpm --filter @invintel/web build >/dev/null)
    cp "$ROOT/deploy/nginx/proxy.conf" "$PREFIX/proxy.conf"
    sed -e "s|@WEB_ROOT@|$ROOT/apps/web/dist|g" -e "s|@API_PORT@|$API_PORT|g" -e "s|@LISTEN@|$LISTEN|g" -e "s|@PREFIX@|$PREFIX|g" \
      "$ROOT/deploy/nginx/invintel.conf.template" > "$PREFIX/nginx.conf"
    "$NGINX" -t -c "$PREFIX/nginx.conf" -p "$PREFIX"
    if [ -f "$PREFIX/nginx.pid" ] && kill -0 "$(cat "$PREFIX/nginx.pid")" 2>/dev/null; then "$NGINX" -s reload -c "$PREFIX/nginx.conf" -p "$PREFIX"; else "$NGINX" -c "$PREFIX/nginx.conf" -p "$PREFIX"; fi
    echo "Invintel is on port ${LISTEN##*:}. This machine: http://localhost:${LISTEN##*:}  Same network: http://$(ipconfig getifaddr en0 2>/dev/null || hostname):${LISTEN##*:}"
    ;;
  stop)
    if [ -f "$PREFIX/nginx.pid" ]; then "$NGINX" -s stop -c "$PREFIX/nginx.conf" -p "$PREFIX" && echo stopped; else echo "not running"; fi
    ;;
  status)
    if [ -f "$PREFIX/nginx.pid" ] && kill -0 "$(cat "$PREFIX/nginx.pid")" 2>/dev/null; then echo "running (pid $(cat "$PREFIX/nginx.pid"))"; else echo "not running"; fi
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
