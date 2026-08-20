import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { getSetting, setSetting } from "./db";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const PW_FILE = `${DATA_DIR}/initial-password.txt`;

// Secret de signature des cookies. Persistant dans la DB.
function getSessionSecret(): string {
  let secret = process.env.SESSION_SECRET || getSetting("session_secret");
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    setSetting("session_secret", secret);
  }
  return secret;
}

// Récupère / génère le mot de passe admin.
function getAdminPassword(): string {
  if (ADMIN_PASSWORD) return ADMIN_PASSWORD;

  // Déjà généré ?
  let stored = getSetting("admin_password");
  if (stored) return stored;

  if (existsSync(PW_FILE)) {
    stored = readFileSync(PW_FILE, "utf-8").trim();
    if (stored) {
      setSetting("admin_password", stored);
      return stored;
    }
  }

  // Génération d'un mot de passe aléatoire robuste
  const newPw = randomBytes(9).toString("base64url");
  setSetting("admin_password", newPw);
  writeFileSync(
    PW_FILE,
    `\n=== WG-BUN-VPN : mot de passe admin initial ===\n` +
      `Utilisateur : ${ADMIN_USER}\n` +
      `Mot de passe : ${newPw}\n\n` +
      `Connecte-toi sur le dashboard puis change ce mot de passe via ADMIN_PASSWORD dans .env\n` +
      `(ou redéfinis-le dans la base).\n`,
    { mode: 0o600 }
  );
  try {
    chmodSync(PW_FILE, 0o600);
  } catch {}
  return newPw;
}

export function verifyCredentials(user: string, pass: string): boolean {
  const expectedUser = ADMIN_USER;
  const expectedPass = getAdminPassword();

  const userOk = timingSafeEqual(
    Buffer.from(user || ""),
    Buffer.from(expectedUser)
  );
  const passBuf = Buffer.from(pass || "");
  const expectedBuf = Buffer.from(expectedPass);
  // Comparaison de longueurs différentes sans fuiter la longueur
  const passOk =
    passBuf.length === expectedBuf.length &&
    timingSafeEqual(passBuf, expectedBuf);

  return userOk && passOk;
}

// Cookie de session = "<expiry>.<hmac-hex>"
export function createSession(maxAgeSec = 60 * 60 * 24 * 7): string {
  const expiry = Math.floor(Date.now() / 1000) + maxAgeSec;
  const sig = createHmac("sha256", getSessionSecret())
    .update(String(expiry))
    .digest("hex");
  return `${expiry}.${sig}`;
}

export function verifySession(cookie: string | undefined | null): boolean {
  if (!cookie) return false;
  const m = cookie.match(/^(\d+)\.([0-9a-f]+)$/);
  if (!m) return false;
  const [, expStr, sig] = m;
  const expiry = parseInt(expStr, 10);
  if (Date.now() / 1000 > expiry) return false;
  const expected = createHmac("sha256", getSessionSecret())
    .update(expStr)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function getSessionCookieFromRequest(req: Request): string | null {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "wg_session") return v.join("=");
  }
  return null;
}

export const COOKIE_NAME = "wg_session";
