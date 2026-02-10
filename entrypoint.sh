#!/bin/bash
set -e

echo "[entrypoint] Starting openclaw container..."

# ========== Configure openclaw directories ==========
# Set state directory to persistent volume
export OPENCLAW_STATE_DIR=/data

# Create symlink from ~/.openclaw to /data/.openclaw
# This ensures OpenClaw can find config regardless of lookup path
mkdir -p /data/.openclaw
if [ ! -L "$HOME/.openclaw" ]; then
  ln -sf /data/.openclaw "$HOME/.openclaw"
fi

# ========== Start cloudflared (Named Tunnel) ==========
if [ -n "$TUNNEL_TOKEN" ]; then
  echo "[entrypoint] Starting cloudflared tunnel..."

  # Generate cloudflared config file with ingress rules
  # The Cloudflare API doesn't support configuring ingress via API tokens,
  # so we configure it locally here.
  CLOUDFLARED_CONFIG="/tmp/cloudflared-config.yml"

  if [ -n "$TUNNEL_HOSTNAME" ]; then
    echo "[entrypoint] Configuring tunnel for hostname: $TUNNEL_HOSTNAME"
    cat > "$CLOUDFLARED_CONFIG" << EOF
tunnel: auto
ingress:
  - hostname: $TUNNEL_HOSTNAME
    service: http://localhost:18789
  - service: http_status:404
EOF
    cloudflared tunnel --no-autoupdate --config "$CLOUDFLARED_CONFIG" run --token "$TUNNEL_TOKEN" &
  else
    # Fallback: run without config (may not work if remote config not set)
    echo "[entrypoint] Warning: No TUNNEL_HOSTNAME provided, running with default config"
    cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" &
  fi

  CLOUDFLARED_PID=$!
  sleep 2

  if ! kill -0 $CLOUDFLARED_PID 2>/dev/null; then
    echo "[entrypoint] ERROR: cloudflared failed to start"
    exit 1
  fi
  echo "[entrypoint] cloudflared started (PID: $CLOUDFLARED_PID)"
else
  echo "[entrypoint] No TUNNEL_TOKEN provided, skipping cloudflared"
fi

# ========== Initialize data directory ==========
if [ ! -f "/data/.openclaw-initialized" ]; then
  echo "[entrypoint] Initializing data directory..."
  mkdir -p /data/.openclaw /data/agents /data/workspace
  touch /data/.openclaw-initialized
fi

# ========== Start openclaw gateway ==========
echo "[entrypoint] Starting openclaw gateway..."

# Generate internal token for gateway authentication
# This is used internally; external access goes through Cloudflare Tunnel
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  export OPENCLAW_GATEWAY_TOKEN="internal-$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
  echo "[entrypoint] Generated internal gateway token"
fi

cd /app
exec node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789
