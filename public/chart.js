// Mini graphique en canvas — sans dépendance externe.
// Axe X temporel (heures), deux séries empilées en aires (down/up).
(function () {
  function createChart(canvas) {
    const ctx = canvas.getContext("2d");
    let pointsRX = [];
    let pointsTX = [];
    let labels = [];

    function setupSize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function niceMax(v) {
      if (v <= 0) return 1;
      const exp = Math.floor(Math.log10(v));
      const base = Math.pow(10, exp);
      const m = v / base;
      let step;
      if (m <= 1) step = 1;
      else if (m <= 2) step = 2;
      else if (m <= 5) step = 5;
      else step = 10;
      return step * base;
    }

    function formatBytesShort(b) {
      if (b < 1024) return b + " o";
      const u = ["o", "Ko", "Mo", "Go", "To"];
      let i = 0;
      while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
      return b.toFixed(b >= 100 ? 0 : b >= 10 ? 1 : 2) + " " + u[i];
    }

    function draw() {
      const rect = canvas.getBoundingClientRect();
      const W = rect.width, H = rect.height;
      ctx.clearRect(0, 0, W, H);

      const padL = 56, padR = 12, padT = 14, padB = 28;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;

      const maxVal = niceMax(Math.max(1, ...pointsRX, ...pointsTX) * 1.1);

      // Grille horizontale + labels
      ctx.font = "11px -apple-system, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.fillStyle = "#8b93a7";
      ctx.lineWidth = 1;
      const gridLines = 4;
      for (let i = 0; i <= gridLines; i++) {
        const y = padT + (plotH * i) / gridLines;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(W - padR, y);
        ctx.stroke();
        const val = maxVal * (1 - i / gridLines);
        ctx.fillText(formatBytesShort(val), 6, y);
      }

      if (pointsRX.length === 0) {
        ctx.fillStyle = "#8b93a7";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("En attente de données…", W / 2, H / 2);
        return;
      }

      const n = pointsRX.length;
      function xFor(i) {
        if (n === 1) return padL + plotW / 2;
        return padL + (plotW * i) / (n - 1);
      }
      function yFor(v) {
        return padT + plotH * (1 - v / maxVal);
      }

      // Aire RX (download)
      function drawArea(data, colorTop, colorFill) {
        ctx.beginPath();
        ctx.moveTo(xFor(0), padT + plotH);
        for (let i = 0; i < n; i++) ctx.lineTo(xFor(i), yFor(data[i]));
        ctx.lineTo(xFor(n - 1), padT + plotH);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, colorFill);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(xFor(0), yFor(data[0]));
        for (let i = 1; i < n; i++) ctx.lineTo(xFor(i), yFor(data[i]));
        ctx.strokeStyle = colorTop;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      drawArea(pointsTX, "#38bdf8", "rgba(56,189,248,.28)");
      drawArea(pointsRX, "#5eead4", "rgba(94,234,212,.28)");

      // Labels X (quelques heures)
      ctx.fillStyle = "#8b93a7";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const step = Math.max(1, Math.floor(n / 6));
      for (let i = 0; i < n; i += step) {
        const x = xFor(i);
        ctx.fillText(labels[i] || "", x, padT + plotH + 8);
      }
    }

    function setData(points) {
      pointsRX = points.map((p) => p.rx);
      pointsTX = points.map((p) => p.tx);
      labels = points.map((p) => {
        // "2026-08-20T14:00:00Z" -> "14h"
        const m = p.hour.match(/T(\d{2}):/);
        return m ? m[1] + "h" : "";
      });
      draw();
    }

    function onResize() { setupSize(); draw(); }
    setupSize();
    window.addEventListener("resize", onResize);

    return { setData, redraw: draw, destroy() { window.removeEventListener("resize", onResize); } };
  }

  window.LineChart = { create: createChart };
})();
