import { exec, writeFileAtomic, parseWgDump, type WgDump } from "./util";
import { db } from "./db";

const IFACE = process.env.WG_IFACE || "wg0";
const PORT = parseInt(process.env.WG_PORT || "51820", 10);
const SUBNET = process.env.WG_SUBNET || "10.13.13.0/24";
const SERVER_IP = process.env.WG_SERVER_IP || "10.13.13.1";
const DNS = process.env.WG_DNS || "1.1.1.1,1.0.0.1";
const CONFIG_PATH = `/data/${IFACE}.conf`;

let detectedEndpoint: string | null = null;

/** Récupère l'IP publique du serveur (auto-détection). */
async function getEndpoint(): Promise<string> {
  if (process.env.PUBLIC_IP) return process.env.PUBLIC_IP;
  if (detectedEndpoint) return detectedEndpoint;

  for (const url of [
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
    "https://ipv4.icanhazip.com",
  ]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const ip = (await r.text()).trim();
      if (ip) {
        detectedEndpoint = ip;
        return ip;
      }
    } catch {
      // essaie le suivant
    }
  }
  console.warn("[wg] impossible de détecter l'IP publique");
  return "SERVER_IP";
}

/** Génère une paire de clés WireGuard. */
export async function generateKeyPair(): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  const { stdout: privateKey } = await exec(["wg", "genkey"]);
  const { stdout: publicKey } = await exec(["wg", "pubkey"], {
    input: privateKey,
  });
  return { privateKey, publicKey };
}

/** Génère une pre-shared key (sécurité post-quantique). */
export async function generatePsk(): Promise<string> {
  const { stdout } = await exec(["wg", "genpsk"]);
  return stdout;
}

/** Trouve la prochaine IP disponible dans le sous-réseau VPN. */
export function allocateIp(): string {
  const used = new Set<string>();
  for (const row of db
    .prepare("SELECT assigned_ip FROM peers")
    .all() as { assigned_ip: string }[]) {
    used.add(row.assigned_ip);
  }
  used.add(SERVER_IP);

  // Format 10.13.13.x
  const base = SERVER_IP.split(".").slice(0, 3).join(".");
  for (let i = 2; i <= 254; i++) {
    const ip = `${base}.${i}`;
    if (!used.has(ip)) return ip;
  }
  throw new Error("Plus d'IP disponible dans le sous-réseau VPN");
}

/** Génère le fichier wgX.conf à partir de la DB. */
async function writeConfig(): Promise<void> {
  const privKey = db
    .prepare("SELECT value FROM settings WHERE key = 'server_private_key'")
    .get() as { value: string } | null;
  if (!privKey) throw new Error("Clé serveur absente");

  // Interface de sortie par défaut pour le NAT
  const { stdout: outIf } = await exec(
    ["sh", "-c", "ip route show default | awk '/default/ {print $5; exit}'"],
    { allowFailure: true }
  );
  const outIface = outIf || "eth0";

  const peers = db
    .prepare(
      `SELECT public_key, psk, assigned_ip FROM peers WHERE enabled = 1`
    )
    .all() as { public_key: string; psk: string | null; assigned_ip: string }[];

  let conf = `[Interface]
PrivateKey = ${privKey.value}
Address = ${SERVER_IP}/24
ListenPort = ${PORT}
SaveConfig = false
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -o ${outIface} -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -o ${outIface} -j MASQUERADE

`;

  for (const p of peers) {
    conf += `[Peer]\nPublicKey = ${p.public_key}\n`;
    if (p.psk) conf += `PresharedKey = ${p.psk}\n`;
    conf += `AllowedIPs = ${p.assigned_ip}/32\n\n`;
  }

  await writeFileAtomic(CONFIG_PATH, conf);
  await exec(["chmod", "600", CONFIG_PATH]);
}

/** Génère le fichier de configuration client (.conf). */
export async function generateClientConfig(opts: {
  clientPrivateKey: string;
  clientAddress: string;
  clientDns?: string;
  psk?: string | null;
  serverPublicKey: string;
}): Promise<string> {
  const endpoint = await getEndpoint();
  const dns = opts.clientDns || DNS;
  return `[Interface]
PrivateKey = ${opts.clientPrivateKey}
Address = ${opts.clientAddress}/32
DNS = ${dns}

[Peer]
PublicKey = ${opts.serverPublicKey}
${opts.psk ? `PresharedKey = ${opts.psk}\n` : ""}AllowedIPs = 0.0.0.0/0
Endpoint = ${endpoint}:${PORT}
PersistentKeepalive = 25
`;
}

/** Initialise le serveur WireGuard au démarrage. */
export async function initWireGuard() {
  // Générer les clés serveur si absentes
  let privKey = getSettingSync("server_private_key");
  let pubKey = getSettingSync("server_public_key");
  if (!privKey || !pubKey) {
    console.log("[wg] Génération des clés du serveur...");
    const kp = await generateKeyPair();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('server_private_key', ?)"
    ).run(kp.privateKey);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('server_public_key', ?)"
    ).run(kp.publicKey);
    privKey = kp.privateKey;
    pubKey = kp.publicKey;
  }

  await writeConfig();

  // Vérifier si l'interface tourne déjà
  const { code } = await exec(["wg", "show", IFACE], { allowFailure: true });
  if (code === 0) {
    console.log(`[wg] interface ${IFACE} déjà active, syncconf...`);
    // syncconf nécessite un fichier stripped (sans PostUp/Address)
    const { stdout: stripped } = await exec([
      "wg-quick",
      "strip",
      CONFIG_PATH,
    ]);
    const tmpConf = `/tmp/${IFACE}-sync.conf`;
    await Bun.write(tmpConf, stripped);
    await exec(["wg", "syncconf", IFACE, tmpConf]);
    await exec(["rm", "-f", tmpConf]);
  } else {
    console.log(`[wg] démarrage de ${IFACE} via wg-quick...`);
    try {
      await exec(["wg-quick", "up", CONFIG_PATH]);
    } catch (e) {
      console.error(
        "[wg] Échec du démarrage de WireGuard. Vérifie que /dev/net/tun est " +
          "accessible et que NET_ADMIN est accordé (voir docker-compose.yml).",
        e
      );
      throw e;
    }
  }

  console.log(`[wg] prêt sur le port ${PORT} (sous-réseau ${SUBNET})`);
  console.log(`[wg] clé publique serveur : ${pubKey}`);
}

function getSettingSync(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

/** Arrête proprement l'interface à l'arrêt du conteneur. */
export async function shutdownWireGuard() {
  const { code } = await exec(["wg", "show", IFACE], { allowFailure: true });
  if (code === 0) {
    console.log(`[wg] arrêt de ${IFACE}...`);
    await exec(["wg-quick", "down", CONFIG_PATH], { allowFailure: true });
  }
}

export async function getWgDump(): Promise<WgDump> {
  const { stdout } = await exec(["wg", "show", IFACE, "dump"]);
  return parseWgDump(stdout);
}

/** Applique immédiatement la nouvelle liste de pairs via wg set. */
async function syncPeers() {
  const peers = db
    .prepare(
      "SELECT public_key, psk, assigned_ip, enabled FROM peers"
    )
    .all() as {
    public_key: string;
    psk: string | null;
    assigned_ip: string;
    enabled: number;
  }[];

  const args: string[] = ["wg", "set", IFACE];
  const tmpFiles: string[] = [];

  for (const p of peers) {
    if (!p.enabled) {
      args.push("peer", p.public_key, "remove");
    } else {
      args.push("peer", p.public_key);
      if (p.psk) {
        // Passer la PSK via un fichier temporaire (évite qu'elle fuie dans ps)
        const tmp = `/tmp/psk-${p.public_key.slice(0, 8)}.tmp`;
        await Bun.write(tmp, p.psk);
        await exec(["chmod", "600", tmp]);
        args.push("preshared-key", tmp);
        tmpFiles.push(tmp);
      }
      args.push("allowed-ips", `${p.assigned_ip}/32`);
    }
  }

  await exec(args);
  for (const f of tmpFiles) await exec(["rm", "-f", f], { allowFailure: true });

  // Réécrire la conf persistante
  await writeConfig();
}

/** Écrit la PSK dans un fichier temporaire 0600 et renvoie son chemin. */
async function writePskTmp(psk: string): Promise<string> {
  const tmp = `/data/psk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await Bun.write(tmp, psk);
  await exec(["chmod", "600", tmp]);
  return tmp;
}

export async function addPeer(pubKey: string, psk: string | null, ip: string) {
  const args = ["wg", "set", IFACE, "peer", pubKey];
  let tmp: string | null = null;
  if (psk) {
    tmp = await writePskTmp(psk);
    args.push("preshared-key", tmp);
  }
  args.push("allowed-ips", `${ip}/32`);
  try {
    await exec(args);
  } finally {
    if (tmp) await exec(["rm", "-f", tmp], { allowFailure: true });
  }
  await writeConfig();
}

export async function removePeer(pubKey: string) {
  await exec(["wg", "set", IFACE, "peer", pubKey, "remove"], {
    allowFailure: true,
  });
  await writeConfig();
}

export async function setPeerEnabled(
  pubKey: string,
  enabled: boolean,
  psk: string | null,
  ip: string
) {
  if (enabled) {
    const args = ["wg", "set", IFACE, "peer", pubKey];
    let tmp: string | null = null;
    if (psk) {
      tmp = await writePskTmp(psk);
      args.push("preshared-key", tmp);
    }
    args.push("allowed-ips", `${ip}/32`);
    try {
      await exec(args);
    } finally {
      if (tmp) await exec(["rm", "-f", tmp], { allowFailure: true });
    }
  } else {
    await exec(["wg", "set", IFACE, "peer", pubKey, "remove"], {
      allowFailure: true,
    });
  }
  await writeConfig();
}

export { getEndpoint, syncPeers, IFACE, PORT, SUBNET, SERVER_IP, DNS };
