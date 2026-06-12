/* Latency weather layer — second channel of the broadcast.
   Owns the /ws/latency socket, the globe's region cells & front band (via the
   window.BGPW bridge), the region strip with sparklines, and the banner's
   latency line. Vanilla JS, no dependencies. */

(() => {
  "use strict";

  const LEVEL_NAMES = ["Clear", "Breezy", "Unsettled", "Stormy"];
  const LEVEL_COLORS = ["#4da3ff", "#2dd4a7", "#ffb547", "#ff4d5e"];
  const SPARK_POINTS = 100;

  const strip = document.getElementById("region-strip");
  let regions = {};
  let sparks = {};        // region id -> medianRtt history (for sparklines)
  let lastFrame = null;

  // ── boot: static region metadata + sparkline seed from the 24h ring buffer ─
  async function boot() {
    try {
      regions = await fetch("/regions.json").then((r) => r.json());
      window.BGPW._regions = regions;
    } catch { return; }
    try {
      const hist = await fetch(`/api/latency/history?points=${SPARK_POINTS}`).then((r) => r.json());
      for (const [id, points] of Object.entries(hist)) {
        sparks[id] = points.map((p) => p.medianRtt).filter((v) => v !== null);
      }
    } catch { /* sparklines fill from live frames instead */ }
    connect();
  }

  // ── websocket (mirrors app.js reconnect pattern) ──────────────────────────
  let ws = null;
  let backoff = 1000;
  let pingTimer = null;

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/latency`);
    ws.onopen = () => {
      backoff = 1000;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.send("ping"); } catch { /* noop */ } }, 25_000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "latency") onFrame(msg.frame);
      else if (msg.type === "event") window.BGPW.addEvent(msg.event);
      else if (msg.type === "commentary") window.BGPW.applyCommentary(msg.id, msg.commentary);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    ws.onerror = () => ws.close();
  }

  // ── frame handling ─────────────────────────────────────────────────────────
  function onFrame(frame) {
    if (!frame) return;
    lastFrame = frame;
    window.BGPW._lastFrame = frame;

    for (const cell of frame.regions) {
      if (cell.medianRtt === null) continue;
      const s = (sparks[cell.id] ??= []);
      s.push(cell.medianRtt);
      if (s.length > SPARK_POINTS) s.splice(0, s.length - SPARK_POINTS);
    }

    const degraded = frame.regions
      .filter((c) => c.ready && c.level >= 2)
      .map((c) => ({ ...c, info: regions[c.id] }))
      .filter((c) => c.info);

    window.BGPW._lastFront = frame.frontActive ? degraded.map((c) => c.info) : [];
    window.BGPW.globeApi.setRegionCells(frame, regions);
    window.BGPW.globeApi.setFront(window.BGPW._lastFront);

    // Banner line 2.
    if (!frame.ready) {
      window.BGPW.setLatencyLine("LATENCY · calibrating baselines against RIPE Atlas…");
    } else if (degraded.length === 0) {
      window.BGPW.setLatencyLine("LATENCY · clear worldwide");
    } else {
      const names = degraded.map((c) => c.info.name).slice(0, 4).join(", ");
      window.BGPW.setLatencyLine(`LATENCY · ${frame.frontActive ? "widespread front — " : "heavy over "}${names}`);
    }

    renderStrip(frame);
  }

  // ── region strip with sparklines ──────────────────────────────────────────
  function sparklineSvg(values, color) {
    if (!values || values.length < 2) return "<svg class='spark' viewBox='0 0 90 24'></svg>";
    const min = Math.min(...values), max = Math.max(...values);
    const span = Math.max(max - min, 0.001);
    const pts = values.map((v, i) =>
      `${((i / (values.length - 1)) * 88 + 1).toFixed(1)},${(22 - ((v - min) / span) * 18 + 1).toFixed(1)}`,
    ).join(" ");
    return `<svg class="spark" viewBox="0 0 90 24" preserveAspectRatio="none">` +
      `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" ` +
      `stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/></svg>`;
  }

  function renderStrip(frame) {
    if (!strip) return;
    strip.hidden = window.BGPW.getChannel() === "bgp";
    const cells = [...frame.regions].sort((a, b) => b.level - a.level || (b.deltaPct ?? 0) - (a.deltaPct ?? 0));
    strip.innerHTML = cells.map((cell) => {
      const info = regions[cell.id];
      if (!info) return "";
      const color = cell.ready ? LEVEL_COLORS[cell.level] : "#4d5668";
      const delta = cell.deltaPct !== null ? `${cell.deltaPct > 0 ? "+" : ""}${Math.round(cell.deltaPct)}%` : "…";
      const rtt = cell.medianRtt !== null ? `${Math.round(cell.medianRtt)}ms` : "—";
      const stateTxt = cell.ready ? LEVEL_NAMES[cell.level] : "calibrating";
      return `<div class="region-chip" data-level="${cell.ready ? cell.level : "warm"}" title="${info.name} · ${stateTxt} · loss ${cell.lossPct}% · ${cell.samples} probes">` +
        `<span class="chip-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>` +
        `<span class="chip-name">${info.name}</span>` +
        sparklineSvg(sparks[cell.id], color) +
        `<span class="chip-rtt mono">${rtt}</span>` +
        `<span class="chip-delta mono" style="color:${color}">${delta}</span>` +
        `</div>`;
    }).join("");
  }

  // Channel switch: show/hide strip + latency line (globe layers handled in app.js).
  window.BGPW.onChannel(() => {
    if (strip) strip.hidden = window.BGPW.getChannel() === "bgp" || !lastFrame;
    if (lastFrame) onFrame(lastFrame);
  });

  boot();
})();
