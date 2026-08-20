import { randomBytes } from "node:crypto";

/**
 * Exécute une commande en argument list (pas de shell -> pas d'injection).
 * Renvoie stdout en string.
 */
export async function exec(
  cmd: string[],
  opts: { allowFailure?: boolean; input?: string } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.input ? "pipe" : "ignore",
  });

  if (opts.input && proc.stdin) {
    proc.stdin.write(opts.input);
    proc.stdin.end();
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const code = await proc.exited;
  if (code !== 0 && !opts.allowFailure) {
    throw new Error(
      `Commande échouée (${code}): ${cmd.join(" ")}\n${stderr.trim()}`
    );
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

export function uid(prefix = ""): string {
  return prefix + randomBytes(8).toString("hex");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Écrit un fichier atomiquement (tmp + rename). */
export async function writeFileAtomic(path: string, content: string) {
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");
  await Bun.write(tmp, content);
  await exec(["mv", tmp, path]);
}

// ===== Formatage de taille / débit =====

const UNITS = ["o", "Ko", "Mo", "Go", "To"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 o";
  if (bytes < 1024) return `${Math.round(bytes)} o`;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${UNITS[i]}`;
}

export function formatRate(bps: number): string {
  return formatBytes(bps) + "/s";
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  seconds = Math.floor(seconds);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}j`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
}

/**
 * Parse la sortie de `wg show <iface> dump`.
 * Renvoie les métadonnées de l'interface + la liste des pairs.
 */
export interface WgPeerDump {
  publicKey: string;
  psk: string | null;
  endpoint: string | null;
  allowedIps: string;
  latestHandshake: number; // epoch secondes
  rxBytes: number;
  txBytes: number;
  persistentKeepalive: string;
}

export interface WgDump {
  privateKey: string;
  publicKey: string;
  listenPort: number;
  fwmark: string;
  peers: WgPeerDump[];
}

export function parseWgDump(output: string): WgDump {
  const lines = output.split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new Error("Sortie wg show dump vide");
  }

  // Première ligne = interface
  const [privKey, pubKey, listenPort, fwmark] = lines[0].split("\t");

  const peers: WgPeerDump[] = lines.slice(1).map((line) => {
    const [
      publicKey,
      psk,
      endpoint,
      allowedIps,
      latestHandshake,
      rxBytes,
      txBytes,
      persistentKeepalive,
    ] = line.split("\t");
    return {
      publicKey,
      psk: psk === "(none)" ? null : psk,
      endpoint: endpoint === "(none)" ? null : endpoint,
      allowedIps: allowedIps || "",
      latestHandshake: parseInt(latestHandshake, 10) || 0,
      rxBytes: parseInt(rxBytes, 10) || 0,
      txBytes: parseInt(txBytes, 10) || 0,
      persistentKeepalive: persistentKeepalive || "off",
    };
  });

  return {
    privateKey: privKey,
    publicKey: pubKey,
    listenPort: parseInt(listenPort, 10) || 0,
    fwmark: fwmark || "off",
    peers,
  };
}
