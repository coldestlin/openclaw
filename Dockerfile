FROM node:22-bookworm

# ========== System Dependencies ==========
# Note: cloudflared removed - using Fly-Force-Instance-Id routing instead
# See: https://fly.io/docs/networking/private-networking/#fly-force-instance-id

# Python3 + pip + common packages for scripts and tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    ffmpeg \
    sqlite3 \
    git \
    vim-common \
    jq \
    curl \
    wget \
    telnet \
    netcat-openbsd \
    dnsutils \
    iputils-ping \
    net-tools \
    iproute2 \
    procps \
    file \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages (break-system-packages for Debian 12+)
RUN pip3 install --no-cache-dir --break-system-packages \
    requests beautifulsoup4 pillow \
    httpx aiohttp

# ========== Playwright + Chromium ==========
# Install Playwright system dependencies for Chromium
RUN npx playwright install-deps chromium
# Install Chromium browser
RUN npx playwright install chromium


# ========== Original openclaw build ==========
# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# ========== Default Configuration ==========
# Copy default config template for SaaS deployment
# This will be copied to /data/.openclaw/openclaw.json on first container startup
COPY openclaw.default.json /opt/openclaw/openclaw.default.json

# ========== Data Directory ==========
# Create data directories for Fly Volume mount
RUN mkdir -p /data/.openclaw /data/clawd /data/workspace

# ========== CLI Commands ==========
# Add openclaw command to PATH
RUN ln -s /app/openclaw.mjs /usr/local/bin/openclaw && \
    chmod +x /app/openclaw.mjs

# Install clawhub CLI
RUN npm install -g clawhub

# ========== Entrypoint ==========
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app

# Expose openclaw gateway port
EXPOSE 18789

ENTRYPOINT ["/entrypoint.sh"]
