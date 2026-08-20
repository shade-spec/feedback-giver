import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const DATA_DIR = process.env.DATA_DIR || "/data";
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(`${DATA_DIR}/vpn.db`);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS peers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT UNIQUE NOT NULL,
  private_key TEXT NOT NULL,
  psk TEXT,
  assigned_ip TEXT UNIQUE NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  total_rx INTEGER NOT NULL DEFAULT 0,
  total_tx INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hourly_traffic (
  hour TEXT NOT NULL,
  peer_id TEXT,
  rx INTEGER NOT NULL DEFAULT 0,
  tx INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, peer_id),
  FOREIGN KEY (peer_id) REFERENCES peers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hourly_hour ON hourly_traffic(hour);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---- Helpers typés ----

export function getSetting(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
