const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function fmtBytes(b) {
  if (!Number.isFinite(b) || b < 0) return "—";
  const u = ["o", "Ko", "Mo", "Go", "To"];
  if (b < 1024) return b + " o";
  let v = b, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + " " + u[i];
}
function fmtRate(bps) { return fmtBytes(bps) + "/s"; }
function fmtUptime(s) {
  s = Math.floor(s);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const p = [];
  if (d) p.push(d + "j");
  if (h) p.push(h + "h");
  if (m && !d) p.push(m + "m");
  if (!d && !h && !m) p.push(s + "s");
  return p.join(" ") || "—";
}
function timeAgo(epoch) {
  if (!epoch) return "jamais";
  const s = Math.floor(Date.now() / 1000) - epoch;
  if (s < 60) return "il y a qq sec";
  if (s < 3600) return "il y a " + Math.floor(s / 60) + " min";
  if (s < 86400) return "il y a " + Math.floor(s / 3600) + " h";
  return "il y a " + Math.floor(s / 86400) + " j";
}

async function api(path, opts) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  if (r.status === 401) { window.location.href = "/login"; throw new Error("auth"); }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || ("HTTP " + r.status));
  }
  return r.json();
}

const chart = window.LineChart.create($("#chart"));

async function refreshSummary() {
  try {
    const s = await api("/api/summary");
    $("#endpoint").textContent = s.endpoint ? s.endpoint + ":51820" : "—";
    $("#server-ip").textContent = s.serverIp;
    $("#uptime").textContent = fmtUptime(s.uptime);

    $("#stat-rx").textContent = fmtBytes(s.allTime.rx);
    $("#stat-tx").textContent = fmtBytes(s.allTime.tx);
    $("#rate-rx").textContent = fmtRate(s.rxRate);
    $("#rate-tx").textContent = fmtRate(s.txRate);

    $("#stat-month").textContent = fmtBytes(s.month.total);
    $("#stat-month-split").textContent =
      "▼ " + fmtBytes(s.month.rx) + " · ▲ " + fmtBytes(s.month.tx);

    $("#stat-online").innerHTML =
      s.onlinePeers + '<span class="unit">/' + s.totalPeers + "</span>";
  } catch (e) { if (e.message !== "auth") console.error(e); }
}

async function refreshHistory() {
  try {
    const d = await api("/api/history?hours=24");
    chart.setData(d.points);
  } catch (e) { if (e.message !== "auth") console.error(e); }
}

async function refreshPeers() {
  try {
    const d = await api("/api/peers");
    const body = $("#peers-body");
    if (d.peers.length === 0) {
      body.innerHTML =
        '<tr><td colspan="8" style="text-align:center; color:var(--muted); padding:28px">' +
        "Aucun pair. Ajoute ton premier appareil avec le formulaire ci-dessus." +
        "</td></tr>";
      return;
    }
    body.innerHTML = d.peers.map((p) => {
      let statePill;
      if (!p.enabled) statePill = '<span class="pill disabled">désactivé</span>';
      else if (p.online) statePill = '<span class="pill online">en ligne</span>';
      else statePill = '<span class="pill offline">hors ligne</span>';

      const rate =
        p.rxRate > 0 || p.txRate > 0
          ? '<span style="color:var(--accent)">▼ ' + fmtRate(p.rxRate) +
            '</span> · <span style="color:var(--accent-2)">▲ ' + fmtRate(p.txRate) + "</span>"
          : '<span style="color:var(--muted)">—</span>';

      return (
        "<tr>" +
        "<td><strong>" + escapeHtml(p.name) + "</strong>" +
        '<div class="mono" style="color:var(--muted); margin-top:2px">' +
        p.publicKey.slice(0, 16) + "…</div></td>" +
        '<td class="mono">' + p.assignedIp + "</td>" +
        "<td>" + statePill + "</td>" +
        "<td>" + fmtBytes(p.rxTotal) + "</td>" +
        "<td>" + fmtBytes(p.txTotal) + "</td>" +
        "<td>" + rate + "</td>" +
        "<td>" + timeAgo(p.lastHandshake || p.lastSeenAt) + "</td>" +
        '<td><div class="row-actions">' +
        '<button class="secondary" data-act="config" data-id="' + p.id + '">Config</button>' +
        '<button class="secondary" data-act="toggle" data-id="' + p.id + '">' +
          (p.enabled ? "Désactiver" : "Activer") + "</button>" +
        '<button class="danger" data-act="delete" data-id="' + p.id + '">Suppr.</button>' +
        "</div></td>" +
        "</tr>"
      );
    }).join("");
  } catch (e) { if (e.message !== "auth") console.error(e); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ===== Actions sur les pairs (délégation d'événements) =====
$("#peers-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === "config") {
    try {
      const d = await api("/api/peers/" + id + "/config");
      openModal(d.name, d.qrCode, d.config);
    } catch (err) { alert(err.message); }
  } else if (act === "toggle") {
    btn.disabled = true;
    try {
      await api("/api/peers/" + id + "/toggle", { method: "POST" });
      await refreshPeers();
    } catch (err) { alert(err.message); }
  } else if (act === "delete") {
    if (!confirm("Supprimer ce pair ? L'accès VPN sera révoqué immédiatement.")) return;
    btn.disabled = true;
    try {
      await api("/api/peers/" + id + "/delete", { method: "POST" });
      await refreshPeers();
      await refreshSummary();
    } catch (err) { alert(err.message); }
  }
});

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#new-name");
  const name = input.value.trim();
  if (!name) return;
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const d = await api("/api/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    input.value = "";
    await refreshPeers();
    await refreshSummary();
    openModal(name, d.qrCode, d.config);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ===== Modal =====
let currentConfig = "";
function openModal(title, qr, config) {
  currentConfig = config;
  $("#modal-title").textContent = "Configuration — " + title;
  $("#modal-qr").src = qr;
  $("#modal-config").textContent = config;
  $("#modal-bg").classList.add("open");
}
function closeModal() { $("#modal-bg").classList.remove("open"); }
$("#close-btn").addEventListener("click", closeModal);
$("#modal-bg").addEventListener("click", (e) => {
  if (e.target.id === "modal-bg") closeModal();
});
$("#copy-btn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentConfig);
    const b = $("#copy-btn");
    const old = b.textContent;
    b.textContent = "Copié ✓";
    setTimeout(() => (b.textContent = old), 1500);
  } catch { alert("Copie impossible"); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ===== Rafraîchissement =====
refreshSummary();
refreshHistory();
refreshPeers();
setInterval(refreshSummary, 5000);
setInterval(refreshPeers, 5000);
setInterval(refreshHistory, 60000);
