#!/bin/sh
# Start (or restart) the Poki MCP daemon in a container on an iStoreOS router.
set -eu
# The token is written below; do not create it world-readable even for a moment.
umask 077

BASE_DIR=${BASE_DIR:-/mnt/data/poki}
STATE_DIR=${STATE_DIR:-$BASE_DIR/state}
SRC_DIR=${SRC_DIR:-$BASE_DIR/src}
TOKEN_FILE=${TOKEN_FILE:-$BASE_DIR/token}
ENV_FILE=${ENV_FILE:-$BASE_DIR/poki.env}
TLS_DIR=${TLS_DIR:-$BASE_DIR/tls}

# Bind to the router's own LAN address without hard-coding one. With --network host,
# 0.0.0.0 would answer on the WAN side too, so loopback is the fallback instead.
# POKI_BIND_HOST may be a comma-separated list; the daemon adds loopback itself.
LAN_IP=$(ip -4 -o addr show br-lan 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
BIND_HOST=${POKI_BIND_HOST:-${LAN_IP:-127.0.0.1}}
# Only `127.0.0.1` covers the local clients: src/stdio.mjs refuses any other hostname in mcp.json,
# so it dials 127.0.0.1 and sends `Host: 127.0.0.1:47825`. Listing `localhost` or `[::1]` as well
# would suggest those names work for that request, which they do not.
HOST_ALLOW=${POKI_HOST_ALLOW:-127.0.0.1${LAN_IP:+,$LAN_IP}}

case ",$HOST_ALLOW," in
  *,127.0.0.1,*) ;;
  *) echo "POKI_HOST_ALLOW=$HOST_ALLOW must include 127.0.0.1, or every local client is rejected." >&2; exit 1 ;;
esac

# A bind address outside the allowlist answers 403 to everything: fail here instead. A wildcard
# covers every address, so the daemon accepts it without an entry of its own.
for host in $(echo "$BIND_HOST" | tr ',' ' '); do
  case "$host" in 0.0.0.0|::) continue ;; esac
  case ",$HOST_ALLOW," in
    *",$host,"*) ;;
    *) echo "POKI_BIND_HOST=$host is not covered by POKI_HOST_ALLOW=$HOST_ALLOW." >&2; exit 1 ;;
  esac
done

# Beyond loopback the bearer token would cross the LAN in plain HTTP, so the daemon serves HTTPS there
# from $TLS_DIR/cert.pem and key.pem. Without them it refuses a LAN address unless
# POKI_ALLOW_PLAINTEXT_BIND=1 says the network is already encrypted end to end (a tailnet).
SCHEME=http
TLS_ARGS=""
if [ -s "$TLS_DIR/cert.pem" ] && [ -s "$TLS_DIR/key.pem" ]; then
  SCHEME=https
  TLS_ARGS="-v $TLS_DIR:/tls:ro"
elif [ "$BIND_HOST" != 127.0.0.1 ] && [ "${POKI_ALLOW_PLAINTEXT_BIND:-}" != 1 ]; then
  echo "POKI_BIND_HOST=$BIND_HOST would send the bearer token over the LAN in plain HTTP." >&2
  echo "Put a certificate and key at $TLS_DIR/cert.pem and $TLS_DIR/key.pem (see README.md, section 3)," >&2
  echo "or set POKI_ALLOW_PLAINTEXT_BIND=1 only when every client reaches the router over an encrypted tunnel." >&2
  exit 1
fi

mkdir -p "$STATE_DIR" "$SRC_DIR/build" "$BASE_DIR/lockdown"
chmod 700 "$STATE_DIR"

if [ ! -s "$TOKEN_FILE" ]; then
  docker run --rm poki:linux node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi

# `docker run -e` would put the token on the command line, where history and `ps` collect it.
# An env file keeps it out of both. It does not hide it from `docker inspect`, which lists
# Config.Env: anyone who can run docker on this router can already read the token file.
{
  echo "POKI_MCP_STATE_DIR=/state"
  echo "POKI_MCP_TOKEN=$(cat "$TOKEN_FILE")"
  echo "POKI_BIND_HOST=$BIND_HOST"
  echo "POKI_HOST_ALLOW=$HOST_ALLOW"
  if [ "$SCHEME" = https ]; then
    echo "POKI_TLS_CERT=/tls/cert.pem"
    echo "POKI_TLS_KEY=/tls/key.pem"
  elif [ "${POKI_ALLOW_PLAINTEXT_BIND:-}" = 1 ]; then
    echo "POKI_ALLOW_PLAINTEXT_BIND=1"
  fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

docker rm -f poki >/dev/null 2>&1 || true

USB_ARGS=""
if [ -S /var/run/usbmuxd ]; then
  USB_ARGS="-v /var/run/usbmuxd:/var/run/usbmuxd"
fi

# shellcheck disable=SC2086
docker run -d --name poki \
  --network host \
  --restart unless-stopped \
  -v "$SRC_DIR":/app -w /app \
  -v "$STATE_DIR":/state \
  -v "$BASE_DIR/lockdown:/var/lib/lockdown" \
  $USB_ARGS \
  $TLS_ARGS \
  --env-file "$ENV_FILE" \
  poki:linux node src/daemon.mjs >/dev/null

sleep 4
docker logs poki 2>&1 | tail -20
echo "--- endpoint ---"
# The endpoint file repeats the bearer token, so only its path is printed here.
echo "$STATE_DIR/mcp.json (bearer token: $TOKEN_FILE, mode 0600)"
echo "Listening on $SCHEME://$BIND_HOST:47825 and http://127.0.0.1:47825; Host allowlist: $HOST_ALLOW"
