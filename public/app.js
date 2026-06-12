/* BGP Weather Channel — dashboard client.
   Connects to the Watcher Durable Object over WebSocket, renders the live
   feed, derives the "internet weather" from recent event severities, and
   drives the 3D globe centrepiece (globe.gl). Vanilla JS. */

(() => {
  "use strict";

  const MAX_CARDS = 100;                 // cap the DOM; D1 keeps the real history
  const STORMY_WINDOW = 30 * 60_000;     // sev3 within 30 min  -> Stormy
  const UNSETTLED_WINDOW = 60 * 60_000;  // sev2 within 60 min  -> Unsettled
  const ARC_TTL = 30_000;                // event arcs fade out after ~30s

  const SEV_COLORS = { 1: "#4da3ff", 2: "#ffb547", 3: "#ff4d5e" };
  const COND_COLORS = { calm: "#69e2b8", unsettled: "#ffb547", stormy: "#ff4d5e" };

  const $ = (id) => document.getElementById(id);
  const feed = $("feed");
  const feedEmpty = $("feed-empty");

  let events = [];   // newest-first; drives the conditions computation

  // ── UTC clock ────────────────────────────────────────────────────────────
  function tickClock() {
    $("utc-time").textContent = new Date().toISOString().slice(11, 19);
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ═══ GLOBE ════════════════════════════════════════════════════════════════
  // All globe access goes through this tiny facade so the rest of the app
  // works identically when WebGL/globe.gl is unavailable (old phones, etc.).
  const globeApi = {
    ready: false,
    setCondition() {}, addEventArc() {}, setRate() {},
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

    const collectors = Object.entries(rrc).map(([id, c]) => ({ id, ...c }));

    // Ambient "breathing": one slow repeating ring per collector. Event
    // ripples ride in the same layer as one-shot entries.
    let ambientPeriod = 6000;
    const ambient = collectors.map((c) => ({
      lat: c.lat, lng: c.lng, kind: "ambient",
      maxR: 2.4, speed: 1.1, repeat: ambientPeriod, rgb: "61,220,151", alpha: 0.28,
    }));
    let ripples = [];
    let arcs = [];

    globe
      .globeImageUrl("https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg")
      .bumpImageUrl("https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-topology.png")
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(true)
      .atmosphereColor(COND_COLORS.calm)
      .atmosphereAltitude(0.18)
      .pointsData(collectors)
      .pointLat("lat").pointLng("lng")
      .pointColor(() => "rgba(61,220,151,0.9)")
      .pointAltitude(0.012).pointRadius(0.35)
      .pointLabel((d) => `${d.id} · ${d.city}`)
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
      // On touch screens the globe is scenery: never trap page scrolling.
      controls.enabled = false;
      el.classList.add("globe-static");
    }
    globe.pointOfView({ lat: 25, lng: -20, altitude: 2.2 }, 0);

    // Keep the canvas matched to its container.
    const size = () => { globe.width(el.clientWidth).height(el.clientHeight); };
    size();
    new ResizeObserver(size).observe(el);

    const pushRings = () => globe.ringsData([...ambient, ...ripples]);
    const pushArcs = () => globe.arcsData([...arcs]);

    // Prune fading entries a few times a minute.
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

    // Ambient pulse cadence follows msgs/sec: busier stream = faster breathing.
    globeApi.setRate = (msgsPerSec) => {
      const period = Math.round(Math.max(1500, Math.min(8000, 6000 / (1 + (msgsPerSec || 0)))));
      // Re-seeding ringsData restarts animations — only do it when the cadence
      // meaningfully changes (quantized to 500ms buckets).
      if (Math.abs(period - ambientPeriod) < 500) return;
      ambientPeriod = period;
      for (const a of ambient) a.repeat = period;
      pushRings();
    };

    globeApi.addEventArc = (ev) => {
      const d = ev.details ?? {};
      const collectorId = String(d.collector ?? "").replace(".ripe.net", "");
      const from = rrc[collectorId];
      const home = geo[d.watchedPrefix] ?? geo[ev.prefix];
      if (!home) return;
      const rgb = hexToRgb(SEV_COLORS[ev.severity] ?? SEV_COLORS[1]);
      const now = Date.now();

      if (from) {
        arcs.push({
          startLat: from.lat, startLng: from.lng,
          endLat: home.lat, endLng: home.lng,
          rgb, born: now,
          alt: 0.2 + ev.severity * 0.06,
          stroke: 0.35 + ev.severity * 0.18,
        });
        pushArcs();
      }
      // Ripple ring where the trouble lives.
      ripples.push({
        lat: home.lat, lng: home.lng, kind: "ripple", born: now,
        maxR: 3 + ev.severity * 1.6, speed: 2.4, repeat: 9999, rgb, alpha: 0.6,
      });
      pushRings();

      // Severity 3: swing the camera to face the event. Maximum drama.
      if (ev.severity >= 3 && !reduceMotion) {
        controls.autoRotate = false;
        globe.pointOfView({ lat: home.lat, lng: home.lng, altitude: 1.9 }, 1200);
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => { controls.autoRotate = true; }, 5000);
      }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void initGlobe());
  } else {
    void initGlobe();
  }

  // ── websocket with reconnect ────────────────────────────────────────────
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
        events.unshift(msg.event);
        if (events.length > 500) events.length = 500;
        feed.prepend(renderCard(msg.event, true));
        trimFeed();
        updateEmpty();
        updateConditions();
        globeApi.addEventArc(msg.event);
        break;
      case "commentary": {
        const el = feed.querySelector(`[data-id="${CSS.escape(msg.id)}"] .card-text`);
        if (el) {
          el.textContent = msg.commentary;
          el.classList.add("is-ai");
        }
        const known = events.find((e) => e.id === msg.id);
        if (known) { known.commentary = msg.commentary; known.narrated = true; }
        if (known && known.kind === "CALM_SUMMARY") updateConditions();
        break;
      }
      case "stats":
        renderStats(msg.stats);
        break;
    }
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

  // ── conditions ───────────────────────────────────────────────────────────
  function updateConditions() {
    const now = Date.now();
    const stormy = events.some((e) => e.severity >= 3 && now - e.ts < STORMY_WINDOW);
    const unsettled = events.some((e) => e.severity >= 2 && now - e.ts < UNSETTLED_WINDOW);
    const state = stormy ? "stormy" : unsettled ? "unsettled" : "calm";

    const hero = $("hero");
    hero.className = `hero hero-${state}`;
    $("conditions-word").textContent = state[0].toUpperCase() + state.slice(1);

    const text = $("conditions-text");
    if (stormy) {
      const worst = events.find((e) => e.severity >= 3 && now - e.ts < STORMY_WINDOW);
      text.textContent = worst?.commentary || "Severe routing weather detected in the last half hour.";
    } else if (unsettled) {
      const recent = events.find((e) => e.severity >= 2 && now - e.ts < UNSETTLED_WINDOW);
      text.textContent = recent?.commentary || "Some notable routing activity in the last hour.";
    } else {
      const calm = events.find((e) => e.kind === "CALM_SUMMARY");
      text.textContent = calm?.commentary
        || "No notable disturbances on the watchlist. The routing table turns quietly beneath us.";
    }

    $("r-events").textContent = events.filter((e) => e.ts > now - 3_600_000).length;
    globeApi.setCondition(state);
  }
  setInterval(updateConditions, 60_000); // windows slide even with no new events

  // ── event cards ──────────────────────────────────────────────────────────
  function renderCard(ev, isNew) {
    const card = document.createElement("article");
    card.className = `card card-sev${ev.severity}${isNew ? " is-new" : ""}`;
    card.dataset.id = ev.id;

    const head = document.createElement("div");
    head.className = "card-head";

    const kind = document.createElement("span");
    kind.className = "badge";
    kind.textContent = ev.kind;
    head.appendChild(kind);

    if (ev.severity >= 3) {
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

  connect();
})();
