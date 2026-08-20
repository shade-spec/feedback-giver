import { db } from "./db";
import { getWgDump } from "./wireguard";

// Compteurs en mémoire vive (rafraîchis par le poller)
export interface LivePeerStats {
  peerId: string;
  publicKey: string;
  rxBytes: number; // cumulatif depuis le dernier démarrage de l'interface
  txBytes: number;
  rxRate: number; // octets/sec
  txRate: number;
  latestHandshake: number;
  endpoint: string | null;
}

const live = new Map<string, LivePeerStats>(); // clé = publicKey
let previousSnapshot = new Map<
  string,
  { rx: number; tx: number; t: number }
>();

function currentHour(): string {
  return new Date().toISOString().slice(0, 13) + ":00:00Z";
}

function upsertHour(
  hour: string,
  peerId: string | null,
  rxDelta: number,
  txDelta: number
) {
  if (rxDelta === 0 && txDelta === 0) return;
  db.prepare(
    `INSERT INTO hourly_traffic (hour, peer_id, rx, tx)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(hour, peer_id) DO UPDATE SET
       rx = rx + excluded.rx,
       tx = tx + excluded.tx`
  ).run(hour, peerId, rxDelta, txDelta);
}

function addPeerTotals(peerId: string, rx: number, tx: number) {
  if (rx === 0 && tx === 0) return;
  db.prepare(
    `UPDATE peers
     SET total_rx = total_rx + ?, total_tx = total_tx + ?,
         last_seen_at = MAX(last_seen_at, ?)
     WHERE id = ?`
  ).run(rx, tx, Math.floor(Date.now() / 1000), peerId);
}

/**
 * Boucle qui lit les compteurs wg toutes les 5s, calcule les débits
 * et agrège dans la DB horaire.
 */
export function startStatsPoller(intervalMs = 5000) {
  const hourPeers = new Map<string, string>(); // pubKey -> peerId
  function refreshPubKeyMap() {
    for (const row of db
      .prepare("SELECT id, public_key FROM peers")
      .all() as { id: string; public_key: string }[]) {
      hourPeers.set(row.public_key, row.id);
    }
  }
  refreshPubKeyMap();
  // Rafraîchir la map régulièrement au cas où des pairs sont ajoutés
  setInterval(refreshPubKeyMap, 10_000);

  async function tick() {
    try {
      const dump = await getWgDump();
      const now = Date.now();
      const hour = currentHour();
      const prev = previousSnapshot;
      const next = new Map<string, { rx: number; tx: number; t: number }>();

      for (const p of dump.peers) {
        const peerId = hourPeers.get(p.publicKey);
        const previous = prev.get(p.publicKey);

        let rxDelta = 0;
        let txDelta = 0;
        let rxRate = 0;
        let txRate = 0;

        if (previous) {
          const dt = (now - previous.t) / 1000;
          if (dt > 0) {
            // Gérer le reset des compteurs (interface redémarrée)
            rxDelta = p.rxBytes >= previous.rx ? p.rxBytes - previous.rx : 0;
            txDelta = p.txBytes >= previous.tx ? p.txBytes - previous.tx : 0;
            rxRate = rxDelta / dt;
            txRate = txDelta / dt;
          }
        }

        next.set(p.publicKey, { rx: p.rxBytes, tx: p.txBytes, t: now });

        if (peerId && (rxDelta || txDelta)) {
          upsertHour(hour, peerId, rxDelta, txDelta);
          addPeerTotals(peerId, rxDelta, txDelta);
        }

        if (p.latestHandshake > 0 && peerId) {
          db.prepare(
            `UPDATE peers SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`
          ).run(p.latestHandshake, peerId, p.latestHandshake);
        }

        live.set(p.publicKey, {
          peerId: peerId || p.publicKey,
          publicKey: p.publicKey,
          rxBytes: p.rxBytes,
          txBytes: p.txBytes,
          rxRate,
          txRate,
          latestHandshake: p.latestHandshake,
          endpoint: p.endpoint,
        });
      }

      // Retirer du cache les pairs qui ne sont plus présents dans wg
      for (const key of live.keys()) {
        if (!next.has(key)) live.delete(key);
      }

      previousSnapshot = next;
    } catch (e) {
      console.error("[stats] tick error:", e);
    }
  }

  // Premier tick immédiat puis toutes les intervalMs
  tick();
  setInterval(tick, intervalMs);
  console.log(`[stats] poller démarré (toutes les ${intervalMs}ms)`);
}

export function getLiveStats(): LivePeerStats[] {
  return Array.from(live.values());
}

// === Nettoyage de l'historique ancien ===

export function startRetentionJanitor(daysToKeep = 90) {
  setInterval(
    () => {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - daysToKeep);
      const cutoffStr = cutoff.toISOString().slice(0, 13) + ":00:00Z";
      try {
        db.prepare("DELETE FROM hourly_traffic WHERE hour < ?").run(cutoffStr);
      } catch (e) {
        console.error("[stats] retention:", e);
      }
    },
    24 * 60 * 60 * 1000
  );
}

// === Requêtes d'agrégat ===

export interface HourPoint {
  hour: string;
  rx: number;
  tx: number;
}

/** Historique des N dernières heures (tous pairs confondus).
 *  Les heures sans trafic sont incluses avec des zéros. */
export function getRecentHours(hours: number): HourPoint[] {
  const now = new Date();
  // Arrondi à l'heure courante
  now.setUTCMinutes(0, 0, 0);

  const cutoff = new Date(now);
  cutoff.setUTCHours(cutoff.getUTCHours() - hours);
  const cutoffStr = cutoff.toISOString().slice(0, 13) + ":00:00Z";

  const rows = db
    .prepare(
      `SELECT hour, SUM(rx) as rx, SUM(tx) as tx
       FROM hourly_traffic
       WHERE hour >= ?
       GROUP BY hour
       ORDER BY hour ASC`
    )
    .all(cutoffStr) as HourPoint[];

  const byHour = new Map(rows.map((r) => [r.hour, r]));

  const result: HourPoint[] = [];
  const cur = new Date(cutoff);
  while (cur <= now) {
    const key = cur.toISOString().slice(0, 13) + ":00:00Z";
    const hit = byHour.get(key);
    result.push({ hour: key, rx: hit?.rx ?? 0, tx: hit?.tx ?? 0 });
    cur.setUTCHours(cur.getUTCHours() + 1);
  }
  return result;
}

export interface Totals {
  rx: number;
  tx: number;
  total: number;
}

export function getTotalAllTime(): Totals {
  const row = db
    .prepare("SELECT COALESCE(SUM(rx),0) as rx, COALESCE(SUM(tx),0) as tx FROM hourly_traffic")
    .get() as { rx: number; tx: number };
  return { rx: row.rx, tx: row.tx, total: row.rx + row.tx };
}

export function getTotalForPeer(peerId: string): Totals {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(rx),0) as rx, COALESCE(SUM(tx),0) as tx FROM hourly_traffic WHERE peer_id = ?"
    )
    .get(peerId) as { rx: number; tx: number };
  return { rx: row.rx, tx: row.tx, total: row.rx + row.tx };
}

export function getMonthTotals(): Totals {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const cutoffStr = monthStart.toISOString().slice(0, 13) + ":00:00Z";
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(rx),0) as rx, COALESCE(SUM(tx),0) as tx FROM hourly_traffic WHERE hour >= ?"
    )
    .get(cutoffStr) as { rx: number; tx: number };
  return { rx: row.rx, tx: row.tx, total: row.rx + row.tx };
}
