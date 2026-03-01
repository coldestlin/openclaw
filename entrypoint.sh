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

# ========== Persist user-installed packages ==========
# Unified persistent storage for all package managers
PERSISTENT_PACKAGES="/data/.packages"

echo "[entrypoint] Setting up persistent storage for packages..."

# Create physical directories
mkdir -p "$PERSISTENT_PACKAGES/npm/bin" "$PERSISTENT_PACKAGES/npm/lib"
mkdir -p "$PERSISTENT_PACKAGES/pnpm"
mkdir -p "$PERSISTENT_PACKAGES/python/bin" "$PERSISTENT_PACKAGES/python/lib"

# Configure NPM persistence (use config instead of symlinks for stability)
# This ensures npm install -g uses the persistent directory
npm config set prefix "$PERSISTENT_PACKAGES/npm"

# Note: Environment variables (PERSISTENT_PACKAGES, NPM_CONFIG_PREFIX, PNPM_HOME,
# PYTHONUSERBASE, PATH) are already set in Dockerfile and will be inherited by
# all child processes via process.env, including SSH sessions.

# ========== Initialize data directory ==========
if [ ! -f "/data/.openclaw-initialized" ]; then
  echo "[entrypoint] Initializing data directory..."
  mkdir -p /data/.openclaw /data/agents /data/workspace
  touch /data/.openclaw-initialized
fi

# ========== Ensure proper permissions ==========
# Create temp directory for openclaw
mkdir -p /tmp/openclaw

# ========== Copy default configuration ==========
# Copy default config for SaaS instances
# OPENCLAW_RESET_CONFIG=true forces overwrite (useful for config updates via image)
DEFAULT_CONFIG="/opt/openclaw/openclaw.default.json"
CONFIG_PATH="/data/.openclaw/openclaw.json"

if [ -f "$DEFAULT_CONFIG" ]; then
  if [ "$OPENCLAW_RESET_CONFIG" = "true" ]; then
    cp "$DEFAULT_CONFIG" "$CONFIG_PATH"
    echo "[entrypoint] Reset configuration (OPENCLAW_RESET_CONFIG=true)"
  elif [ ! -f "$CONFIG_PATH" ]; then
    cp "$DEFAULT_CONFIG" "$CONFIG_PATH"
    echo "[entrypoint] Copied default configuration to $CONFIG_PATH"
  else
    echo "[entrypoint] Using existing configuration at $CONFIG_PATH"
  fi
fi

# ========== Start openclaw gateway ==========
echo "[entrypoint] Starting openclaw gateway..."

# Configure gateway authentication token
# Priority: INSTANCE_SECRET (from SaaS platform) > OPENCLAW_GATEWAY_TOKEN > auto-generated
if [ -n "$INSTANCE_SECRET" ]; then
  # SaaS platform mode: use INSTANCE_SECRET for authentication
  # This allows the Gateway Worker to authenticate via Authorization: Bearer header
  export OPENCLAW_GATEWAY_TOKEN="$INSTANCE_SECRET"
  echo "[entrypoint] Using INSTANCE_SECRET for gateway authentication"
elif [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  # Self-hosted mode: generate internal token
  export OPENCLAW_GATEWAY_TOKEN="internal-$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
  echo "[entrypoint] Generated internal gateway token"
fi

cd /app
exec node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789
