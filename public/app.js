/* BGP Weather Channel — dashboard client.
   Connects to the Watcher Durable Object over WebSocket, renders the live
   feed, derives the "internet weather" from recent event severities, and
   drives replay mode. Vanilla JS, no dependencies. */

(() => {
  "use strict";

  const MAX_CARDS = 100;          // cap the DOM; D1 keeps the real history
  const STORMY_WINDOW = 30 * 60_000;   // sev3 within 30 min  -> Stormy
  const UNSETTLED_WINDOW = 60 * 60_000; // sev2 within 60 min -> Unsettled

  const $ = (id) => document.getElementById(id);
  const feed = $("feed");
  const feedEmpty = $("feed-empty");

  // Newest-first list of events we know about (history + live), for the
  // conditions computation. Replay events are excluded from the weather.
  let events = [];
  let replayRunning = false;

  // ── UTC clock ────────────────────────────────────────────────────────────
  function tickClock() {
    $("utc-time").textContent = new Date().toISOString().slice(11, 19);
  }
  tickClock();
  setInterval(tickClock, 1000);

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
        // history arrives newest-first; append in order so newest stays on top
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
      case "replay":
        renderReplay(msg);
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
    if (typeof s.replayActive !== "undefined" && !s.replayActive && replayRunning === "stats-wait") {
      // belt and braces: stats says no replay running any more
      replayDone();
    }
  }

  // ── conditions banner ────────────────────────────────────────────────────
  function updateConditions() {
    const now = Date.now();
    const real = events.filter((e) => !e.replay);
    const stormy = real.some((e) => e.severity >= 3 && now - e.ts < STORMY_WINDOW);
    const unsettled = real.some((e) => e.severity >= 2 && now - e.ts < UNSETTLED_WINDOW);

    const banner = $("conditions");
    const word = $("conditions-word");
    const text = $("conditions-text");

    banner.className = "conditions " + (stormy ? "conditions-stormy" : unsettled ? "conditions-unsettled" : "conditions-calm");
    word.textContent = stormy ? "Stormy" : unsettled ? "Unsettled" : "Calm";

    if (stormy) {
      const worst = real.find((e) => e.severity >= 3 && now - e.ts < STORMY_WINDOW);
      text.textContent = worst?.commentary || "Severe routing weather detected in the last half hour.";
    } else if (unsettled) {
      const recent = real.find((e) => e.severity >= 2 && now - e.ts < UNSETTLED_WINDOW);
      text.textContent = recent?.commentary || "Some notable routing activity in the last hour.";
    } else {
      const calm = real.find((e) => e.kind === "CALM_SUMMARY");
      text.textContent = calm?.commentary
        || "No notable disturbances on the watchlist. The routing table turns quietly beneath us.";
    }

    const hourAgo = now - 3_600_000;
    $("r-events").textContent = real.filter((e) => e.ts > hourAgo).length;
  }
  setInterval(updateConditions, 60_000); // windows slide even with no new events

  // ── event cards ──────────────────────────────────────────────────────────
  function renderCard(ev, isNew) {
    const card = document.createElement("article");
    const sevClass = ev.kind === "REPLAY" ? "card-replay" : `card-sev${ev.severity}`;
    card.className = `card ${sevClass}${isNew ? " is-new" : ""}`;
    card.dataset.id = ev.id;

    const head = document.createElement("div");
    head.className = "card-head";

    const kind = document.createElement("span");
    kind.className = "badge";
    kind.textContent = ev.kind === "REPLAY" ? String(ev.details?.originalKind ?? "EVENT") : ev.kind;
    head.appendChild(kind);

    if (ev.kind === "REPLAY") {
      const tag = document.createElement("span");
      tag.className = "badge badge-replay";
      tag.textContent = "REPLAY";
      tag.title = "Reconstruction of a historical incident — not live data";
      head.appendChild(tag);
    }

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

  // ── replay deck ──────────────────────────────────────────────────────────
  const replayBtn = $("replay-btn");
  const replaySelect = $("replay-select");
  const replayBanner = $("replay-banner");

  replayBtn.addEventListener("click", async () => {
    replayBtn.disabled = true;
    try {
      const resp = await fetch(`/replay/${replaySelect.value}`, { method: "POST" });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        showReplayBanner(`replay unavailable: ${body.error ?? resp.status}`);
        replayBtn.disabled = false;
      }
      // success: the websocket "replay started" broadcast drives the UI
    } catch {
      showReplayBanner("replay request failed — check the connection");
      replayBtn.disabled = false;
    }
  });

  function renderReplay(msg) {
    if (msg.status === "started") {
      replayRunning = true;
      replayBtn.disabled = true;
      const title = msg.title ?? msg.incident;
      const disclaimer = msg.disclaimer ?? "Hand-authored reconstruction.";
      showReplayBanner(`⏪ REPLAY · ${title} — ${disclaimer}`);
    } else if (msg.status === "finished") {
      replayDone();
    }
  }

  function replayDone() {
    replayRunning = false;
    replayBtn.disabled = false;
    showReplayBanner("replay finished — back to the live feed");
    setTimeout(() => { if (!replayRunning) replayBanner.hidden = true; }, 6000);
  }

  function showReplayBanner(textContent) {
    replayBanner.textContent = textContent;
    replayBanner.hidden = false;
  }

  connect();
})();
