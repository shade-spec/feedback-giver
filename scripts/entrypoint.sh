#!/bin/bash
set -e

echo "[entrypoint] Préparation du conteneur WireGuard + Bun..."

# Créer le device TUN si nécessaire
mkdir -p /dev/net
if [ ! -c /dev/net/tun ]; then
  echo "[entrypoint] Création de /dev/net/tun"
  mknod /dev/net/tun c 10 200
  chmod 600 /dev/net/tun
fi

# Charger le module noyau WireGuard (sans échec si built-in)
modprobe wireguard 2>/dev/null || true

# Activer le routage IPv4 (la sysctl du compose.yml le fait aussi)
sysctl -w net.ipv4.ip_forward=1 2>/dev/null || true
sysctl -w net.ipv4.conf.all.forwarding=1 2>/dev/null || true

# Vérifier que wg est disponible
if ! command -v wg >/dev/null 2>&1; then
  echo "[entrypoint] ERREUR: wireguard-tools n'est pas installé dans l'image"
  exit 1
fi

mkdir -p /data

echo "[entrypoint] Démarrage du serveur Bun..."
exec bun run src/server.ts
