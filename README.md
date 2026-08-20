# WG-BUN-VPN

Serveur **VPN WireGuard** avec tableau de bord web en **Bun**, dans une **seule image Docker**.

- 🔐 Vrai VPN (WireGuard dans le noyau) — tout le trafic de l'appareil est tunnelisé
- 🔑 Authentification par clés publique/privée WireGuard nativement
- 👤 Dashboard protégé par nom d'utilisateur + mot de passe
- 📊 Comptage de bande passante par appareil, historique horaire, graphiques en temps réel
- 📱 QR code à flasher pour ajouter un téléphone en 2 secondes
- 🗄️ Persistance SQLite dans `./data`

## Ressources consommées

| Ressource | Usage approximatif |
|---|---|
| RAM | 50–100 Mo (WireGuard ~10 Mo, Bun ~30–50 Mo) |
| CPU | < 5 % d'1 vCPU à 100 Mbps |
| Disque | < 200 Mo image + ~1 Mo de données |
| Réseau | dépend du VPS (Hetzner = 20 To, OVH = 1–5 To…) |

Un VPS à 4–6 €/mois (1 vCPU / 1 Go RAM) convient largement.

## Démarrage rapide

### 1. Prérequis sur le serveur

- Linux avec noyau ≥ 5.6 (WireGuard intégré) — Ubuntu 20.04+, Debian 11+
- Docker + Docker Compose plugin
- Ports ouverts : **51820/udp** (VPN) et **3000/tcp** (dashboard)

### 2. Installer

```bash
git clone <ce-dépôt>
cd feedback-giver

cp .env.example .env
# Édite .env : mets un vrai ADMIN_PASSWORD (sinon un mot de passe aléatoire
# est généré dans data/initial-password.txt)

docker compose up -d --build
```

### 3. Se connecter au dashboard

Ouvre `http://IP_DU_SERVEUR:3000` dans un navigateur.
Identifiants par défaut : `admin` / la valeur de `ADMIN_PASSWORD` (ou le contenu de `data/initial-password.txt`).

### 4. Ajouter un appareil

1. Clique sur **+ Ajouter**, donne un nom (ex. « iPhone »).
2. Un QR code s'affiche.
3. Sur l'appareil :
   - **iOS/Android** : installe l'app officielle *WireGuard*, scanne le QR code.
   - **Windows/macOS/Linux** : clique sur *Copier la config*, importe le fichier dans le client WireGuard.
4. Active le tunnel. Tout le trafic passe par le serveur.

## Commandes utiles

```bash
docker compose logs -f           # Voir les logs
docker compose restart           # Redémarrer
docker compose down              # Arrêter
docker compose up -d --build     # Reconstruire après un git pull
docker compose exec vpn wg show  # Voir l'état WireGuard en direct
```

## Sécurité

- Le dashboard utilise un cookie de session signé HMAC-SHA256.
- Les clés privées des pairs sont stockées en SQLite (dans `./data`, monté en volume).
- **Le dashboard est servi en HTTP** pour rester simple. Pour un accès depuis Internet :
  - Option recommandée : mettre le dashboard derrière **Caddy** ou **Nginx** avec Let's Encrypt (HTTPS).
  - Ou restreindre le port 3000 à ton IP via le firewall et n'ouvrir que 51820/udp.
  - Ou accéder au dashboard via un tunnel SSH : `ssh -L 3000:localhost:3000 user@serveur`.

Exemple Caddy (dans un autre conteneur ou sur l'hôte) :

```
vpn.ton-domaine.com {
    reverse_proxy vpn:3000
}
```

## Configuration (.env)

| Variable | Défaut | Description |
|---|---|---|
| `ADMIN_USER` | `admin` | Nom d'utilisateur du dashboard |
| `ADMIN_PASSWORD` | (généré) | Mot de passe — mets le tien sinon il est généré |
| `DASHBOARD_PORT` | `3000` | Port interne du dashboard |
| `PUBLIC_IP` | (auto) | IP publique du serveur (auto-détectée sinon) |
| `WG_PORT` | `51820` | Port UDP de WireGuard |
| `WG_SUBNET` | `10.13.13.0/24` | Sous-réseau interne du VPN |
| `WG_SERVER_IP` | `10.13.13.1` | IP du serveur dans le VPN |
| `WG_DNS` | `1.1.1.1,1.0.0.1` | DNS poussés aux clients |

## Architecture

```
┌──────────────────────────────────────────────┐
│               CONTENEUR DOCKER                │
│                                               │
│  ┌─────────────┐    ┌──────────────────────┐ │
│  │  WireGuard  │◄───┤      Serveur Bun     │ │
│  │  (noyau)    │    │  ┌────────────────┐  │ │
│  │  :51820/udp │    │  │  API + Stats   │  │ │
│  │             │    │  │  (SQLite)      │  │ │
│  │  wg show    │───►│  └────────────────┘  │ │
│  │  (compteurs)│    │  :3000 (dashboard)  │ │
│  └──────┬──────┘    └──────────────────────┘ │
│         │ NAT                                 │
└─────────┼─────────────────────────────────────┘
          ▼
       Internet
```

Toutes les 5 secondes, Bun lit `wg show wg0 dump` pour récupérer les octets
échangés par chaque pair, calcule les débits et agrège dans `hourly_traffic`.
Le dashboard poll ces données et les affiche.

## Développement local (sans Docker)

Nécessite que `wireguard-tools` soit installé et que Bun soit disponible :

```bash
bun install
sudo -E DATA_DIR=./data bun run src/server.ts
```

(Lancer en root est nécessaire pour `wg-quick` / iptables.)

## Licence

MIT
