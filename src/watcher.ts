// The heart of the system: a single Durable Object that
//   1. holds the outbound WebSocket to RIS Live (this is why a DO and not a
//      plain Worker — Workers are stateless and die between requests),
//   2. runs every message through the heuristics engine,
//   3. writes events to D1 and fans them out to dashboard browsers.
// Holding the outbound socket keeps the DO awake — that's the accepted cost.

import { DurableObject } from "cloudflare:workers";
import { CONFIG } from "./config";
import {
  buildCalmSummary, compileWatchlist, diffCounters, emptyCounters, emptyState,
  processMessage, pruneState,
} from "./heuristics";
import { NarrationBudget, narrate, templateFor } from "./narrator";
import { rowToEvent, ulid } from "./util";
import type {
  BgpEvent, Counters, Env, HeuristicsState, NewEvent, RisUpdate, WatchlistEntry,
} from "./types";
import watchlistJson from "../watchlist.json";

export class Watcher extends DurableObject<Env> {
  private risWs: WebSocket | null = null;
  private connecting = false;
  private reconnectPending = false;
  private backoffMs: number = CONFIG.ris.backoffInitialMs;
  private lastMsgTs = 0;
  private connectedSince = 0;
  private bornAt = Date.now();
  private state: HeuristicsState = emptyState(Date.now());
  private hourlySnapshot: Counters = emptyCounters(Date.now());
  private budget: NarrationBudget = new NarrationBudget();
  private dirty = false;
  private compiled = compileWatchlist(watchlistJson as WatchlistEntry[]);
  private timersStarted = false;
  private statsLastCount = 0;
  private statsLastTs = Date.now();
  private msgsPerSec = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Load persisted detection state before handling any request.
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<HeuristicsState>("heuristics");
      if (saved) this.state = saved;
      const snap = await ctx.storage.get<Counters>("hourlySnapshot");
      if (snap) this.hourlySnapshot = snap;
      this.budget = NarrationBudget.fromJSON(
        await ctx.storage.get<{ stamps: { ts: number; sev: 1 | 2 | 3 }[]; calm: number[] }>("budget"),
      );
      // The alarm is our belt-and-braces heartbeat: persist + reconnect check.
      await ctx.storage.setAlarm(Date.now() + CONFIG.persistIntervalMs);
    });
    this.ensureTimers();
    void this.ensureConnected();
  }

  // ---- HTTP entry points (reached via the Worker) ---------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.handleWsUpgrade(request);
    if (url.pathname === "/status") return Response.json(this.statusBody());
    if (url.pathname === "/cron/calm") {
      await this.maybeCalmSummary();
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.persist();
    this.ensureTimers();
    void this.ensureConnected();
    await this.ctx.storage.setAlarm(Date.now() + CONFIG.persistIntervalMs);
  }

  // ---- dashboard WebSockets -------------------------------------------------

  private async handleWsUpgrade(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    // Hibernation-aware accept (good practice even though the outbound RIS
    // socket keeps this DO awake anyway).
    this.ctx.acceptWebSocket(pair[1]);
    try {
      const rows = await this.env.DB.prepare(
        "SELECT * FROM events ORDER BY ts DESC LIMIT 50",
      ).all();
      pair[1].send(JSON.stringify({ type: "history", events: rows.results.map(rowToEvent) }));
    } catch (err) {
      console.log("history query failed:", err);
      pair[1].send(JSON.stringify({ type: "history", events: [] }));
    }
    pair[1].send(JSON.stringify({ type: "stats", stats: this.statsBody() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (message === "ping") ws.send("pong"); // simple client keepalive
  }

  async webSocketClose(): Promise<void> {
    /* nothing to do — ctx.getWebSockets() drops closed sockets automatically */
  }

  private broadcast(obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* client gone */ }
    }
  }

  // ---- RIS Live upstream connection -----------------------------------------

  private async ensureConnected(): Promise<void> {
    if (this.connecting) return;
    const silent = this.lastMsgTs > 0 && Date.now() - this.lastMsgTs > CONFIG.ris.silenceTimeoutMs;
    if (this.risWs && !silent) return; // looks healthy
    this.closeRis();
    this.connecting = true;
    try {
      // Outbound WebSocket from a Worker/DO = fetch with an Upgrade header.
      const resp = await fetch(CONFIG.ris.url, { headers: { Upgrade: "websocket" } });
      const ws = resp.webSocket;
      if (!ws) throw new Error(`no websocket in response (HTTP ${resp.status})`);
      ws.accept();
      this.risWs = ws;
      this.lastMsgTs = Date.now();
      this.connectedSince = Date.now();
      this.backoffMs = CONFIG.ris.backoffInitialMs; // reset backoff on success
      for (const w of this.compiled) {
        ws.send(JSON.stringify({
          type: "ris_subscribe",
          data: { prefix: w.entry.prefix, moreSpecific: true, type: "UPDATE" },
        }));
      }
      ws.addEventListener("message", (e) => this.onRisMessage(e));
      ws.addEventListener("close", () => this.scheduleReconnect());
      ws.addEventListener("error", () => this.scheduleReconnect());
      console.log(`RIS connected, ${this.compiled.length} subscriptions`);
    } catch (err) {
      console.log("RIS connect failed:", err);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private closeRis(): void {
    if (this.risWs) {
      try { this.risWs.close(); } catch { /* already dead */ }
      this.risWs = null;
    }
  }

  private scheduleReconnect(): void {
    this.closeRis();
    if (this.reconnectPending) return; // close + error can both fire — queue one
    this.reconnectPending = true;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, CONFIG.ris.backoffMaxMs); // exponential, capped
    setTimeout(() => {
      this.reconnectPending = false;
      void this.ensureConnected();
    }, delay);
  }

  private onRisMessage(e: MessageEvent): void {
    this.lastMsgTs = Date.now();
    let parsed: { type?: string; data?: RisUpdate };
    try {
      const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.type !== "ris_message" || !parsed.data) return;
    // Keep per-message work tiny (DO CPU limits): pure heuristics + counters only.
    const events = processMessage(parsed.data, this.compiled, this.state, CONFIG, Date.now());
    this.dirty = true;
    for (const ev of events) void this.publishEvent(ev);
  }

  // ---- event publication ------------------------------------------------------

  private async publishEvent(ev: NewEvent): Promise<void> {
    const event: BgpEvent = { ...ev, id: ulid(), commentary: templateFor(ev), narrated: false };
    try {
      await this.env.DB.prepare(
        "INSERT INTO events (id, ts, kind, severity, prefix, label, details, commentary, narrated) VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind(
        event.id, event.ts, event.kind, event.severity, event.prefix ?? null, event.label ?? null,
        JSON.stringify(event.details), event.commentary, 0,
      ).run();
    } catch (err) {
      console.log("D1 insert failed:", err);
    }
    // Broadcast immediately with the template; AI text replaces it when ready.
    this.broadcast({ type: "event", event });
    const result = await narrate(event, {
      apiKey: this.env.ANTHROPIC_API_KEY,
      enabled: this.env.NARRATION_ENABLED !== "false", // kill switch
      budget: this.budget,
      now: Date.now(),
    });
    if (result.narrated) {
      event.commentary = result.text;
      event.narrated = true;
      try {
        await this.env.DB.prepare("UPDATE events SET commentary = ?, narrated = 1 WHERE id = ?")
          .bind(result.text, event.id).run();
      } catch (err) {
        console.log("D1 commentary update failed:", err);
      }
      this.broadcast({ type: "commentary", id: event.id, commentary: result.text });
      await this.ctx.storage.put("budget", this.budget.toJSON());
    }
  }

  // ---- calm summary (hourly cron) ----------------------------------------------

  private async maybeCalmSummary(): Promise<void> {
    const now = Date.now();
    const hourly = diffCounters(this.state.counters, this.hourlySnapshot);
    // Snapshot first so next hour diffs from here even if we emit nothing.
    this.hourlySnapshot = structuredClone(this.state.counters);
    await this.ctx.storage.put("hourlySnapshot", this.hourlySnapshot);
    try {
      const row = await this.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE ts > ? AND severity >= 2",
      ).bind(now - 3_600_000).first<{ n: number }>();
      if ((row?.n ?? 0) > 0) return; // not a calm hour — no summary
    } catch (err) {
      console.log("calm summary query failed:", err);
      return;
    }
    if (hourly.messages === 0 && !this.risWs) return; // offline and nothing to say
    await this.publishEvent(buildCalmSummary(hourly, now));
  }

  // ---- stats, status, timers, persistence ------------------------------------------

  private ensureTimers(): void {
    if (this.timersStarted) return;
    this.timersStarted = true;
    // The outbound RIS socket keeps the DO alive, so plain intervals are fine.
    // If the DO is evicted, the constructor + alarm + cron watchdog rebuild all this.
    setInterval(() => this.pingTick(), CONFIG.ris.pingIntervalMs);
    setInterval(() => this.statsTick(), CONFIG.statsBroadcastMs);
  }

  private pingTick(): void {
    if (!this.risWs) return;
    if (Date.now() - this.lastMsgTs > CONFIG.ris.silenceTimeoutMs) {
      console.log("RIS silent too long — reconnecting");
      this.scheduleReconnect();
      return;
    }
    try { this.risWs.send(JSON.stringify({ type: "ping" })); } catch { this.scheduleReconnect(); }
  }

  private statsTick(): void {
    const now = Date.now();
    const elapsed = (now - this.statsLastTs) / 1000;
    if (elapsed > 0) {
      this.msgsPerSec = Math.round(((this.state.counters.messages - this.statsLastCount) / elapsed) * 10) / 10;
    }
    this.statsLastCount = this.state.counters.messages;
    this.statsLastTs = now;
    if (this.ctx.getWebSockets().length > 0) {
      this.broadcast({ type: "stats", stats: this.statsBody() });
    }
  }

  private statsBody() {
    const top = Object.entries(this.state.counters.perCollector)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([host, msgs]) => ({ host, msgs }));
    return {
      connected: !!this.risWs,
      msgsPerSec: this.msgsPerSec,
      totalMessages: this.state.counters.messages,
      announcements: this.state.counters.announcements,
      withdrawals: this.state.counters.withdrawals,
      topCollectors: top,
      clients: this.ctx.getWebSockets().length,
    };
  }

  private statusBody() {
    return {
      ...this.statsBody(),
      lastMessageAgoMs: this.lastMsgTs ? Date.now() - this.lastMsgTs : null,
      connectedSince: this.connectedSince || null,
      uptimeMs: Date.now() - this.bornAt,
      subscriptions: this.compiled.length,
      narrationsRemainingThisHour: this.budget.remaining(Date.now()),
      eventsByKind: this.state.counters.eventsByKind,
    };
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    pruneState(this.state, CONFIG, Date.now()); // keep debounce maps from growing forever
    await this.ctx.storage.put("heuristics", this.state);
    await this.ctx.storage.put("budget", this.budget.toJSON());
  }
}
