FROM oven/bun:1

# WireGuard (wg, wg-quick), iptables (NAT), outils réseau
RUN apt-get update && apt-get install -y --no-install-recommends \
    wireguard-tools \
    iptables \
    curl \
    kmod \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json bun.lock* ./
RUN bun install --production

# Copy source
COPY . .

RUN chmod +x scripts/entrypoint.sh

# Dashboard HTTP + WireGuard UDP
EXPOSE 3000 51820/udp

ENTRYPOINT ["./scripts/entrypoint.sh"]
