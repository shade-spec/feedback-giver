import QRCode from "qrcode";
import LOGIN_HTML from "./views/login.html" with { type: "text" };
import DASHBOARD_HTML from "./views/dashboard.html" with { type: "text" };
import {
  initWireGuard,
  shutdownWireGuard,
  generateKeyPair,
  generatePsk,
  allocateIp,
  addPeer,
  removePeer,
  setPeerEnabled,
  generateClientConfig,
  getEndpoint,
  SERVER_IP,
} from "./wireguard";
import { db, getSetting } from "./db";
import {
  verifyCredentials,
  createSession,
  verifySession,
  getSessionCookieFromRequest,
  COOKIE_NAME,
} from "./auth";
import {
  startStatsPoller,
  startRetentionJanitor,
  getLiveStats,
  getRecentHours,
  getTotalAllTime,
  getTotalForPeer,
  getMonthTotals,
} from "./stats";
import { formatBytes, formatRate, formatUptime, uid } from "./util";

const PORT = parseInt(process.env.DASHBOARD_PORT || "3000", 10);
const startedAt = Math.floor(Date.now() / 1000);

// ============ Aide HTTP ============

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "cache-control": "no-store",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function badRequest(message: string) {
  return json({ error: message }, { status: 400 });
}

function unauthorized() {
  return json({ error: "Non authentifié" }, { status: 401 });
}

function isAuthed(req: Request): boolean {
  return verifySession(getSessionCookieFromRequest(req));
}

// ============ Routes API ============

async function handleLogin(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
  };
  if (!body.username || !body.password) return badRequest("Champs manquants");

  if (!verifyCredentials(body.username, body.password)) {
    return json({ error: "Identifiants invalides" }, { status: 401 });
  }

  const session = createSession();
  return json(
    { ok: true },
    {
      headers: {
        "set-cookie":
          `${COOKIE_NAME}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
      },
    }
  );
}

function handleLogout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      "set-cookie": `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`,
      location: "/login",
    },
  });
}

interface PeerRow {
  id: string;
  name: string;
  public_key: string;
  private_key: string;
  psk: string | null;
  assigned_ip: string;
  enabled: number;
  created_at: number;
  last_seen_at: number | null;
  total_rx: number;
  total_tx: number;
}

async function handlePeersList(): Promise<Response> {
  const peers = db
    .prepare(
      `SELECT id, name, public_key, psk, assigned_ip, enabled,
              created_at, last_seen_at, total_rx, total_tx
       FROM peers ORDER BY created_at ASC`
    )
    .all() as Omit<PeerRow, "private_key">[];

  const liveByKey = new Map(getLiveStats().map((l) => [l.publicKey, l]));
  const now = Math.floor(Date.now() / 1000);

  return json({
    peers: peers.map((p) => {
      const live = liveByKey.get(p.public_key);
      return {
        id: p.id,
        name: p.name,
        publicKey: p.public_key,
        assignedIp: p.assigned_ip,
        enabled: p.enabled === 1,
        createdAt: p.created_at,
        lastSeenAt: p.last_seen_at ?? null,
        lastHandshake: live?.latestHandshake ?? 0,
        online:
          live?.latestHandshake != null &&
          now - live.latestHandshake < 180,
        endpoint: live?.endpoint ?? null,
        rxRate: live?.rxRate ?? 0,
        txRate: live?.txRate ?? 0,
        rxTotal: p.total_rx,
        txTotal: p.total_tx,
      };
    }),
  });
}

async function handlePeerCreate(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    name?: string;
  } | null;
  const name = (body?.name || "").trim();
  if (!name || name.length > 64) {
    return badRequest("Nom invalide (1-64 caractères)");
  }

  const kp = await generateKeyPair();
  const psk = await generatePsk();
  const ip = allocateIp();
  const id = uid("peer_");
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO peers
      (id, name, public_key, private_key, psk, assigned_ip, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, name, kp.publicKey, kp.privateKey, psk, ip, now);

  await addPeer(kp.publicKey, psk, ip);

  const serverPub = getSetting("server_public_key")!;
  const clientConf = await generateClientConfig({
    clientPrivateKey: kp.privateKey,
    clientAddress: ip,
    psk,
    serverPublicKey: serverPub,
  });

  const qrDataUrl = await QRCode.toDataURL(clientConf, {
    width: 320,
    margin: 1,
  });

  return json({
    id,
    name,
    publicKey: kp.publicKey,
    assignedIp: ip,
    config: clientConf,
    qrCode: qrDataUrl,
  });
}

async function handlePeerConfig(id: string): Promise<Response> {
  const peer = db
    .prepare("SELECT * FROM peers WHERE id = ?")
    .get(id) as PeerRow | undefined;
  if (!peer) return new Response("Pair introuvable", { status: 404 });

  const serverPub = getSetting("server_public_key")!;
  const clientConf = await generateClientConfig({
    clientPrivateKey: peer.private_key,
    clientAddress: peer.assigned_ip,
    psk: peer.psk,
    serverPublicKey: serverPub,
  });
  const qrDataUrl = await QRCode.toDataURL(clientConf, {
    width: 320,
    margin: 1,
  });
  return json({
    name: peer.name,
    config: clientConf,
    qrCode: qrDataUrl,
  });
}

async function handlePeerDelete(id: string): Promise<Response> {
  const peer = db
    .prepare("SELECT public_key FROM peers WHERE id = ?")
    .get(id) as { public_key: string } | undefined;
  if (!peer) return new Response("Pair introuvable", { status: 404 });

  await removePeer(peer.public_key);
  db.prepare("DELETE FROM peers WHERE id = ?").run(id);
  return json({ ok: true });
}

async function handlePeerToggle(id: string): Promise<Response> {
  const peer = db
    .prepare("SELECT public_key, psk, assigned_ip, enabled FROM peers WHERE id = ?")
    .get(id) as
    | {
        public_key: string;
        psk: string | null;
        assigned_ip: string;
        enabled: number;
      }
    | undefined;
  if (!peer) return new Response("Pair introuvable", { status: 404 });

  const newEnabled = peer.enabled === 1 ? 0 : 1;
  await setPeerEnabled(
    peer.public_key,
    newEnabled === 1,
    peer.psk,
    peer.assigned_ip
  );
  db.prepare("UPDATE peers SET enabled = ? WHERE id = ?").run(newEnabled, id);
  return json({ ok: true, enabled: newEnabled === 1 });
}

function handleSummary(): Response {
  const totalsAll = getTotalAllTime();
  const totalsMonth = getMonthTotals();
  const live = getLiveStats();
  const now = Math.floor(Date.now() / 1000);

  let rxRate = 0;
  let txRate = 0;
  let onlineCount = 0;
  for (const l of live) {
    rxRate += l.rxRate;
    txRate += l.txRate;
    if (now - l.latestHandshake < 180) onlineCount++;
  }

  const peerCount = (
    db.prepare("SELECT COUNT(*) as c FROM peers").get() as { c: number }
  ).c;

  return json({
    allTime: totalsAll,
    month: totalsMonth,
    rxRate,
    txRate,
    onlinePeers: onlineCount,
    totalPeers: peerCount,
    serverIp: SERVER_IP,
    endpoint: getEndpoint(),
    uptime: now - startedAt,
    startedAt,
  });
}

function handleHistory(hours = 24): Response {
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
    hours = 24;
  }
  const points = getRecentHours(hours);
  return json({ points });
}

// ============ Routes statiques / HTML ============

async function serveStatic(
  path: string,
  contentType: string
): Promise<Response> {
  const file = Bun.file(`public/${path}`);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(file, { headers: { "content-type": contentType } });
}

function renderLogin(): Response {
  return new Response(LOGIN_HTML as unknown as string, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderDashboard(): Response {
  return new Response(DASHBOARD_HTML as unknown as string, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ============ Routeur principal ============

async function router(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Healthcheck
  if (path === "/healthz") return new Response("ok");

  // Login / logout
  if (path === "/login" && req.method === "GET") return renderLogin();
  if (path === "/api/login" && req.method === "POST") return handleLogin(req);
  if (path === "/logout") return handleLogout();

  // Assets statiques (non protégés — css/js du login, sans donnée sensible)
  if (path.startsWith("/static/")) {
    const rest = path.slice("/static/".length);
    if (rest.endsWith(".css"))
      return serveStatic(rest, "text/css; charset=utf-8");
    if (rest.endsWith(".js"))
      return serveStatic(rest, "application/javascript; charset=utf-8");
    return new Response("Not found", { status: 404 });
  }

  // Tout le reste nécessite une session valide
  if (!isAuthed(req)) {
    if (path.startsWith("/api/")) return unauthorized();
    return Response.redirect(new URL("/login", req.url).toString(), 302);
  }

  // Dashboard HTML
  if (path === "/" || path === "/index.html") return renderDashboard();

  // API
  if (path === "/api/summary") return handleSummary();
  if (path === "/api/history") {
    const h = parseInt(url.searchParams.get("hours") || "24", 10);
    return handleHistory(h);
  }
  if (path === "/api/peers" && req.method === "GET") return handlePeersList();
  if (path === "/api/peers" && req.method === "POST") return handlePeerCreate(req);

  const peerMatch = path.match(/^\/api\/peers\/([a-zA-Z0-9_-]+)(\/(config|delete|toggle))?$/);
  if (peerMatch) {
    const [, id, , action] = peerMatch;
    if (action === "config") return handlePeerConfig(id);
    if (action === "delete" && req.method === "POST") return handlePeerDelete(id);
    if (action === "toggle" && req.method === "POST") return handlePeerToggle(id);
  }

  return new Response("Not found", { status: 404 });
}

// ============ Démarrage ============

async function main() {
  console.log("=".repeat(60));
  console.log(" WG-BUN-VPN");
  console.log("=".repeat(60));
  await initWireGuard();
  startStatsPoller(5000);
  startRetentionJanitor(90);

  const server = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    fetch: router,
  });

  console.log(`\n[dashboard] http://0.0.0.0:${server.port}`);
  const endpoint = await getEndpoint().catch(() => "SERVER_IP");
  console.log(`[dashboard] endpoint WireGuard : ${endpoint}:51820`);
  console.log(
    `[auth] utilisateur admin : ${process.env.ADMIN_USER || "admin"}`
  );
  if (!process.env.ADMIN_PASSWORD) {
    console.log(
      `[auth] mot de passe initial dans /data/initial-password.txt`
    );
  }

  const shutdown = async (sig: string) => {
    console.log(`\n[main] ${sig} reçu, arrêt propre...`);
    await shutdownWireGuard().catch(() => {});
    server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("ERREUR FATALE :", e);
  process.exit(1);
});

// Exposé utile pour tests / debug
export { formatBytes, formatRate, formatUptime };
