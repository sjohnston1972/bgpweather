/* BGP Weather Channel — dashboard client (BGP channel + shared chrome).
   Connects to the Watcher DO over WebSocket, renders the feed, derives
   routing conditions, and drives the 3D globe. The latency channel lives in
   latency-layer.js and talks to this file through window.BGPW. Vanilla JS. */

(() => {
  "use strict";

  const MAX_CARDS = 100;                 // cap the DOM; D1 keeps the real history
  const STORMY_WINDOW = 30 * 60_000;     // sev3 within 30 min  -> Stormy
  const UNSETTLED_WINDOW = 60 * 60_000;  // sev2 within 60 min  -> Unsettled
  const ARC_TTL = 30_000;                // event arcs fade out after ~30s

  const SEV_COLORS = { 1: "#4da3ff", 2: "#ffb547", 3: "#ff4d5e" };
  const COND_COLORS = { calm: "#69e2b8", unsettled: "#ffb547", stormy: "#ff4d5e" };
  const LATENCY_KINDS = new Set(["LATENCY_STORM", "LOSS_SQUALL", "CLEARING", "GLOBAL_FRONT"]);
  // Region cell fill by level: Clear / Breezy / Unsettled / Stormy.
  const LEVEL_RGBA = [
    "rgba(77,163,255,0.10)", "rgba(45,212,167,0.16)",
    "rgba(255,181,71,0.24)", "rgba(255,77,94,0.32)",
  ];
  const $ = (id) => document.getElementById(id);
  const feed = $("feed");
  const feedEmpty = $("feed-empty");

  let events = [];   // newest-first; latency kinds excluded from routing conditions

  // ── channel switcher (BGP / LATENCY / BOTH) ──────────────────────────────
  const channelListeners = [];
  let channel = (() => {
    const q = new URLSearchParams(location.search).get("channel");
    if (["bgp", "latency", "both"].includes(q)) return q;
    const saved = localStorage.getItem("bgpw-channel");
    return ["bgp", "latency", "both"].includes(saved) ? saved : "both";
  })();

  function setChannel(ch) {
    channel = ch;
    localStorage.setItem("bgpw-channel", ch);
    document.body.className = `ch-${ch}`;
    document.querySelectorAll("#channel-switch button").forEach((b) => {
      b.classList.toggle("active", b.dataset.ch === ch);
    });
    for (const cb of channelListeners) cb(ch);
  }
  document.querySelectorAll("#channel-switch button").forEach((b) => {
    b.addEventListener("click", () => setChannel(b.dataset.ch));
  });

  // ── UTC clock ────────────────────────────────────────────────────────────
  function tickClock() {
    $("utc-time").textContent = new Date().toISOString().slice(11, 19);
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ═══ GLOBE ════════════════════════════════════════════════════════════════
  // Facade so the rest of the app (and latency-layer.js) works identically
  // when WebGL/globe.gl is unavailable.
  const globeApi = {
    ready: false,
    setCondition() {}, addEventArc() {}, setRate() {},
    setRegionCells() {}, setFront() {},
  };

  async function initGlobe() {
    const el = $("globe");
    if (!el || typeof Globe === "undefined") return;

    let rrc = {}, geo = {};
    try {
      [rrc, geo] = await Promise.all([
        fetch("/rrc-locations.json").then((r) => r.json()),
        fetch("/prefix-geo.json").then((r) => r.json()),
      ]);
    } catch { return; }

    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = matchMedia("(pointer: coarse)").matches;

    let globe;
    try {
      globe = new Globe(el, { rendererConfig: { antialias: !coarse, alpha: true }, animateIn: true });
    } catch { return; }

    // Collector beacons and latency region cells share the points layer:
    // a "cell" is just a big, flat, translucent circle on the surface. Each
    // cell gets its own altitude step so overlapping translucent discs
    // (Europe has five!) never sit coplanar and z-fight into spiky artifacts.
    const collectors = Object.entries(rrc).map(([id, c]) => ({
      id, ...c, kind: "rrc", r: 0.35, alt: 0.012,
      color: "rgba(61,220,151,0.9)", label: `${id} · ${c.city}`,
    }));
    let regionCells = [];
    const pushPoints = () => globe.pointsData([...regionCells, ...collectors]);

    let ambientPeriod = 6000;
    const ambient = collectors.map((c) => ({
      lat: c.lat, lng: c.lng,
      maxR: 2.4, speed: 1.1, repeat: ambientPeriod, rgb: "61,220,151", alpha: 0.28,
    }));
    let ripples = [];   // one-shot event ripples
    let stormRings = []; // repeating pulses over Stormy latency regions
    let arcs = [];      // BGP event arcs (TTL-pruned)
    let frontArcs = []; // latency GLOBAL_FRONT band (persists while active)

    globe
      .globeImageUrl("/earth-night.jpg")          // self-hosted: no CDN dependency at runtime
      .bumpImageUrl("/earth-topology.png")
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(true)
      .atmosphereColor(COND_COLORS.calm)
      .atmosphereAltitude(0.18)
      .pointsData(collectors)
      .pointLat("lat").pointLng("lng")
      .pointColor("color")
      .pointAltitude("alt").pointRadius("r")
      .pointLabel("label")
      .pointsTransitionDuration(0)
      .ringsData(ambient)
      .ringLat("lat").ringLng("lng")
      .ringColor((d) => (t) => `rgba(${d.rgb},${(d.alpha * (1 - t)).toFixed(3)})`)
      .ringMaxRadius("maxR")
      .ringPropagationSpeed("speed")
      .ringRepeatPeriod("repeat")
      .ringAltitude(0.011)
      .arcsData([])
      .arcStartLat("startLat").arcStartLng("startLng")
      .arcEndLat("endLat").arcEndLng("endLng")
      .arcColor((d) => [`rgba(${d.rgb},0.15)`, `rgba(${d.rgb},0.95)`])
      .arcAltitude("alt")
      .arcStroke("stroke")
      .arcDashLength(0.45).arcDashGap(0.7).arcDashInitialGap(1)
      .arcDashAnimateTime(1600);

    const controls = globe.controls();
    controls.autoRotate = !reduceMotion;
    controls.autoRotateSpeed = 0.55;
    controls.enableZoom = false;
    if (coarse) {
      controls.enabled = false;       // touch: scenery, never traps page scroll
      el.classList.add("globe-static");
    }
    globe.pointOfView({ lat: 25, lng: -20, altitude: 2.2 }, 0);

    const size = () => { globe.width(el.clientWidth).height(el.clientHeight); };
    size();
    new ResizeObserver(size).observe(el);

    const pushRings = () => globe.ringsData([...ambient, ...stormRings, ...ripples]);
    const pushArcs = () => globe.arcsData([...arcs, ...frontArcs]);

    setInterval(() => {
      const now = Date.now();
      const beforeA = arcs.length, beforeR = ripples.length;
      arcs = arcs.filter((a) => now - a.born < ARC_TTL);
      ripples = ripples.filter((r) => now - r.born < 8000);
      if (arcs.length !== beforeA) pushArcs();
      if (ripples.length !== beforeR) pushRings();
    }, 5000);

    const hexToRgb = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    };

    let focusTimer = null;
    globeApi.ready = true;

    globeApi.setCondition = (state) => {
      globe.atmosphereColor(COND_COLORS[state] ?? COND_COLORS.calm);
    };

    globeApi.setRate = (msgsPerSec) => {
      const period = Math.round(Math.max(1500, Math.min(8000, 6000 / (1 + (msgsPerSec || 0)))));
      if (Math.abs(period - ambientPeriod) < 500) return;
      ambientPeriod = period;
      for (const a of ambient) a.repeat = period;
      pushRings();
    };

    globeApi.addEventArc = (ev) => {
      if (channel === "latency") return; // BGP theatre hidden on the latency channel
      const d = ev.details ?? {};
      const collectorId = String(d.collector ?? "").replace(".ripe.net", "");
      const from = rrc[collectorId];
      const home = geo[d.watchedPrefix] ?? geo[ev.prefix];
      if (!home) return;
      const rgb = hexToRgb(SEV_COLORS[ev.severity] ?? SEV_COLORS[1]);
      const now = Date.now();
      if (from) {
        arcs.push({
          startLat: from.lat, startLng: from.lng, endLat: home.lat, endLng: home.lng,
          rgb, born: now, alt: 0.2 + ev.severity * 0.06, stroke: 0.35 + ev.severity * 0.18,
        });
        pushArcs();
      }
      ripples.push({
        lat: home.lat, lng: home.lng, born: now,
        maxR: 3 + ev.severity * 1.6, speed: 2.4, repeat: 9999, rgb, alpha: 0.6,
      });
      pushRings();
      if (ev.severity >= 3 && !reduceMotion) {
        controls.autoRotate = false;
        globe.pointOfView({ lat: home.lat, lng: home.lng, altitude: 1.9 }, 1200);
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => { controls.autoRotate = true; }, 5000);
      }
    };

    // Latency layer: translucent region cells (flat discs) + storm pulses.
    globeApi.setRegionCells = (frame, regions) => {
      if (channel === "bgp" || !frame) {
        regionCells = [];
        stormRings = [];
        pushPoints();
        pushRings();
        return;
      }
      stormRings = [];
      // Largest discs lowest in the stack so smaller neighbours stay visible.
      const ordered = [...frame.regions]
        .filter((c) => regions[c.id])
        .sort((a, b) => regions[b.id].radius - regions[a.id].radius);
      regionCells = ordered.map((cell, i) => {
        const info = regions[cell.id];
        const warming = !cell.ready;
        const label =
          `<div class="cell-tip"><b>${info.name}</b><br>` +
          (cell.medianRtt !== null ? `median ${cell.medianRtt} ms` : "no data") +
          (cell.deltaPct !== null ? ` · ${cell.deltaPct > 0 ? "+" : ""}${cell.deltaPct}% vs normal` : "") +
          `<br>loss ${cell.lossPct}% · ${cell.samples} probes` +
          (warming ? "<br><i>baseline calibrating…</i>" : "") +
          (cell.lowData ? "<br><i>low data</i>" : "") + `</div>`;
        if (cell.ready && cell.level === 3) {
          stormRings.push({
            lat: info.lat, lng: info.lng,
            maxR: info.radius * 0.9, speed: 1.6, repeat: 2400, rgb: "255,77,94", alpha: 0.5,
          });
        }
        return {
          kind: "cell", lat: info.lat, lng: info.lng,
          r: info.radius, alt: 0.002 + i * 0.0006,  // unique altitude per disc: no z-fighting
          color: warming ? "rgba(216,222,233,0.06)" : LEVEL_RGBA[cell.level],
          label,
        };
      });
      pushPoints();
      pushRings();
    };

    // GLOBAL_FRONT theatre: an amber band chained through the disturbed regions.
    globeApi.setFront = (degradedCentres) => {
      frontArcs = [];
      if (channel !== "bgp" && degradedCentres && degradedCentres.length >= 2) {
        for (let i = 0; i < degradedCentres.length - 1; i++) {
          frontArcs.push({
            startLat: degradedCentres[i].lat, startLng: degradedCentres[i].lng,
            endLat: degradedCentres[i + 1].lat, endLng: degradedCentres[i + 1].lng,
            rgb: "255,181,71", alt: 0.35, stroke: 0.5, born: Infinity,
          });
        }
      }
      pushArcs();
    };

    channelListeners.push(() => {
      // re-apply layer visibility on channel change
      if (window.BGPW._lastFrame) globeApi.setRegionCells(window.BGPW._lastFrame, window.BGPW._regions ?? {});
      else if (channel === "bgp") globeApi.setRegionCells(null);
      globeApi.setFront(window.BGPW._lastFront ?? []);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void initGlobe());
  } else {
    void initGlobe();
  }

  // ── websocket with reconnect (BGP channel) ───────────────────────────────
  let ws = null;
  let backoff = 1000;
  let pingTimer = null;

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = 1000;
      setConn(true);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.send("ping"); } catch { /* noop */ } }, 25_000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => {
      setConn(false);
      clearInterval(pingTimer);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    ws.onerror = () => ws.close();
  }

  function setConn(up) {
    $("conn-dot").className = `dot ${up ? "dot-on" : "dot-off"}`;
    const label = $("onair-label");
    label.textContent = up ? "ON AIR" : "RECONNECTING";
    label.classList.toggle("is-live", up);
  }

  // ── message handling ─────────────────────────────────────────────────────
  function handle(msg) {
    switch (msg.type) {
      case "history":
        events = msg.events ?? [];
        feed.querySelectorAll(".card").forEach((c) => c.remove());
        for (const ev of events) feed.appendChild(renderCard(ev, false));
        updateEmpty();
        updateConditions();
        break;
      case "event":
        addEvent(msg.event, { arc: true });
        break;
      case "commentary":
        applyCommentary(msg.id, msg.commentary);
        break;
      case "stats":
        renderStats(msg.stats);
        break;
    }
  }

  // Shared event ingestion — used by both channels (latency-layer calls this).
  function addEvent(ev, { arc = false } = {}) {
    events.unshift(ev);
    if (events.length > 500) events.length = 500;
    feed.prepend(renderCard(ev, true));
    trimFeed();
    updateEmpty();
    updateConditions();
    if (arc && !LATENCY_KINDS.has(ev.kind)) globeApi.addEventArc(ev);
  }

  function applyCommentary(id, commentary) {
    const el = feed.querySelector(`[data-id="${CSS.escape(id)}"] .card-text`);
    if (el) {
      el.textContent = commentary;
      el.classList.add("is-ai");
    }
    const known = events.find((e) => e.id === id);
    if (known) { known.commentary = commentary; known.narrated = true; }
    if (known && known.kind === "CALM_SUMMARY") updateConditions();
  }

  // ── stats ticker ─────────────────────────────────────────────────────────
  const fmt = new Intl.NumberFormat("en-GB");
  function renderStats(s) {
    if (!s) return;
    $("r-rate").textContent = s.msgsPerSec ?? 0;
    $("r-ann").textContent = fmt.format(s.announcements ?? 0);
    $("r-wd").textContent = fmt.format(s.withdrawals ?? 0);
    $("t-total").textContent = fmt.format(s.totalMessages ?? 0);
    $("t-ann").textContent = fmt.format(s.announcements ?? 0);
    $("t-wd").textContent = fmt.format(s.withdrawals ?? 0);
    $("t-clients").textContent = s.clients ?? 0;
    $("t-collectors").textContent = (s.topCollectors ?? [])
      .map((c) => `${c.host.replace(".ripe.net", "")}:${fmt.format(c.msgs)}`)
      .join("  ") || "—";
    setConn(!!s.connected);
    globeApi.setRate(s.msgsPerSec ?? 0);
  }

  // ── conditions (line 1: routing weather — BGP events only) ──────────────
  function updateConditions() {
    const now = Date.now();
    const bgp = events.filter((e) => !LATENCY_KINDS.has(e.kind));
    const stormy = bgp.some((e) => e.severity >= 3 && now - e.ts < STORMY_WINDOW);
    const unsettled = bgp.some((e) => e.severity >= 2 && now - e.ts < UNSETTLED_WINDOW);
    const state = stormy ? "stormy" : unsettled ? "unsettled" : "calm";

    $("hero").className = `hero hero-${state}`;
    $("conditions-word").textContent = state[0].toUpperCase() + state.slice(1);

    const text = $("conditions-text");
    if (stormy) {
      const worst = bgp.find((e) => e.severity >= 3 && now - e.ts < STORMY_WINDOW);
      text.textContent = worst?.commentary || "Severe routing weather detected in the last half hour.";
    } else if (unsettled) {
      const recent = bgp.find((e) => e.severity >= 2 && now - e.ts < UNSETTLED_WINDOW);
      text.textContent = recent?.commentary || "Some notable routing activity in the last hour.";
    } else {
      const calm = bgp.find((e) => e.kind === "CALM_SUMMARY");
      text.textContent = calm?.commentary
        || "No notable disturbances on the watchlist. The routing table turns quietly beneath us.";
    }

    $("r-events").textContent = events.filter((e) => e.ts > now - 3_600_000).length;
    globeApi.setCondition(state);
  }
  setInterval(updateConditions, 60_000);

  // ── event cards ──────────────────────────────────────────────────────────
  function renderCard(ev, isNew) {
    const card = document.createElement("article");
    card.className = `card card-sev${ev.severity}${isNew ? " is-new" : ""}`;
    card.dataset.id = ev.id;
    card.dataset.channel = LATENCY_KINDS.has(ev.kind) ? "latency" : "bgp";

    const head = document.createElement("div");
    head.className = "card-head";

    const kind = document.createElement("span");
    kind.className = "badge";
    kind.textContent = ev.kind;
    head.appendChild(kind);

    if (ev.severity >= 3 && !LATENCY_KINDS.has(ev.kind)) {
      const unc = document.createElement("span");
      unc.className = "badge badge-unconfirmed";
      unc.textContent = "detected — unconfirmed";
      head.appendChild(unc);
    }

    if (ev.prefix) {
      const pfx = document.createElement("span");
      pfx.className = "card-prefix";
      pfx.textContent = ev.prefix;
      head.appendChild(pfx);
    }
    if (ev.label) {
      const lbl = document.createElement("span");
      lbl.className = "card-label";
      lbl.textContent = ev.label;
      head.appendChild(lbl);
    }

    const time = document.createElement("span");
    time.className = "card-time";
    time.textContent = new Date(ev.ts).toISOString().slice(11, 19) + " UTC";
    time.title = new Date(ev.ts).toLocaleString();
    head.appendChild(time);

    const text = document.createElement("p");
    text.className = "card-text" + (ev.narrated ? " is-ai" : "");
    text.textContent = ev.commentary || "";

    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "raw details";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(ev.details ?? {}, null, 2);
    det.append(sum, pre);

    card.append(head, text, det);
    return card;
  }

  function trimFeed() {
    const cards = feed.querySelectorAll(".card");
    for (let i = MAX_CARDS; i < cards.length; i++) cards[i].remove();
  }

  function updateEmpty() {
    feedEmpty.hidden = feed.querySelector(".card") !== null;
  }

  // ── bridge for latency-layer.js ──────────────────────────────────────────
  window.BGPW = {
    addEvent,
    applyCommentary,
    globeApi,
    getChannel: () => channel,
    onChannel: (cb) => channelListeners.push(cb),
    setLatencyLine: (text) => {
      const el = $("latency-line");
      if (!el) return;
      el.textContent = text ?? "";
      el.hidden = !text || channel === "bgp";
    },
    _lastFrame: null, _regions: null, _lastFront: [],
  };

  setChannel(channel);
  connect();
})();
