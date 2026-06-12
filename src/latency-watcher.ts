// The latency channel's Durable Object — sibling of the BGP Watcher, with a
// deliberately different lifecycle: no persistent upstream socket, just a DO
// alarm every 120s that polls the curated RIPE Atlas measurements, runs the
// pure rules engine, and fans out frames/events on its own /ws/latency socket.
// It shares D1, the narrator, and the global narration budget with the BGP
// channel — and nothing else (independent failure domains).

import { DurableObject } from "cloudflare:workers";
import { CONFIG } from "./config";
import { aggregateRegion, emptyLatencyState, parseLatest, stepAll, type ParsedMeasurement } from "./latency-rules";
import { canNarrateFromCounts, narrate, templateFor } from "./narrator";
import { getNarrationCounts, ulid } from "./util";
import type {
  AtlasMeasurement, BgpEvent, Env, LatencyFrame, LatencyState, NewEvent, RegionInfo,
} from "./types";
import measurementsJson from "../atlas-measurements.json";
import regionsJson from "../public/regions.json";

const MEASUREMENTS = measurementsJson as AtlasMeasurement[];
const REGIONS = regionsJson as Record<string, RegionInfo>;

// Compact per-cycle history point for the 24h ring buffers (sparklines).
interface HistoryPoint { ts: number; level: number; medianRtt: number | null; lossPct: number; samples: number }

export class LatencyWatcher extends DurableObject<Env> {
  private state: LatencyState = emptyLatencyState();
  private lastFrame: LatencyFrame | null = null;
  private history: Record<string, HistoryPoint[]> = {};
  private lastCycle = { ts: 0, durMs: 0, fetched: 0, failed: 0, rateLimited: false };
  private backoff = false;
  private cycleRunning = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const st = await ctx.storage.get<LatencyState>("latencyState");
      if (st) this.state = st;
      const frame = await ctx.storage.get<LatencyFrame>("lastFrame");
      if (frame) this.lastFrame = frame;
      const hist = await ctx.storage.get<Record<string, HistoryPoint[]>>("history");
      if (hist) this.history = hist;
      // Arm the poll loop if it isn't already.
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + 5_000);
      }
    });
  }

  async alarm(): Promise<void> {
    try {
      await this.runCycle();
    } catch (err) {
      console.log("latency cycle failed:", err);
    }
    const interval = this.backoff ? CONFIG.latency.backoffIntervalMs : CONFIG.latency.pollIntervalMs;
    await this.ctx.storage.setAlarm(Date.now() + interval);
  }

  // ---- HTTP entry points -----------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws/latency") return this.handleWsUpgrade(request);
    if (url.pathname === "/status") {
      // The cron watchdog hits this; it also self-heals a lost alarm.
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + 1_000);
      }
      return Response.json(this.statusBody());
    }
    if (url.pathname === "/grid") {
      return Response.json(this.lastFrame ?? { ts: 0, ready: false, frontActive: false, regions: [] });
    }
    if (url.pathname.startsWith("/region/")) {
      const id = url.pathname.split("/")[2] ?? "";
      const info = REGIONS[id];
      if (!info) return Response.json({ error: "unknown region", available: Object.keys(REGIONS) }, { status: 404 });
      return Response.json({
        id, ...info,
        current: this.lastFrame?.regions.find((r) => r.id === id) ?? null,
        history: this.history[id] ?? [],
      });
    }
    if (url.pathname === "/history") {
      // All-region downsampled history for the dashboard sparklines.
      const points = Math.min(Number(url.searchParams.get("points") ?? "120") || 120, CONFIG.latency.historyPoints);
      const out: Record<string, HistoryPoint[]> = {};
      for (const [id, hist] of Object.entries(this.history)) {
        const stride = Math.max(1, Math.ceil(hist.length / points));
        out[id] = hist.filter((_, i) => (hist.length - 1 - i) % stride === 0);
      }
      return Response.json(out);
    }
    return new Response("not found", { status: 404 });
  }

  private async handleWsUpgrade(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (this.lastFrame) pair[1].send(JSON.stringify({ type: "latency", frame: this.lastFrame }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (message === "ping") ws.send("pong");
  }
  async webSocketClose(): Promise<void> { /* auto-cleaned */ }

  private broadcast(obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* client gone */ }
    }
  }

  // ---- the poll cycle ----------------------------------------------------------

  private async runCycle(): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    const started = Date.now();
    let fetched = 0, failed = 0, rateLimited = false;

    try {
      // Fetch every measurement's /latest/, a few at a time (subrequest budget).
      const byRegion: Record<string, ParsedMeasurement[]> = {};
      const queue = [...MEASUREMENTS];
      const workers = Array.from({ length: CONFIG.latency.fetchConcurrency }, async () => {
        for (let m = queue.shift(); m; m = queue.shift()) {
          try {
            const url = `https://atlas.ripe.net/api/v2/measurements/${m.msmId}/latest/?format=json&probe_ids=${m.probeIds.join(",")}`;
            const headers: Record<string, string> = {};
            if (this.env.ATLAS_API_KEY) headers.Authorization = `Key ${this.env.ATLAS_API_KEY}`;
            const resp = await fetch(url, { headers });
            if (resp.status === 429) { rateLimited = true; failed++; continue; }
            if (!resp.ok) { failed++; continue; }
            const json = (await resp.json()) as unknown[];
            const parsed = parseLatest(json, Date.now() / 1000, CONFIG.latency.staleResultMaxAgeS);
            (byRegion[m.region] ??= []).push(parsed);
            fetched++;
          } catch (err) {
            console.log(`atlas fetch failed (msm ${m.msmId}):`, err);
            failed++;
          }
        }
      });
      await Promise.all(workers);

      // Aggregate + run the pure weather rules.
      const statsByRegion = Object.fromEntries(
        Object.entries(byRegion).map(([region, parts]) => [region, aggregateRegion(parts)]),
      );
      const now = Date.now();
      const { frame, events } = stepAll(statsByRegion, this.state, REGIONS, CONFIG, now);
      this.lastFrame = frame;

      // Ring buffers for sparklines / region detail (24h at 120s cycles).
      for (const cell of frame.regions) {
        const hist = (this.history[cell.id] ??= []);
        hist.push({ ts: now, level: cell.level, medianRtt: cell.medianRtt, lossPct: cell.lossPct, samples: cell.samples });
        if (hist.length > CONFIG.latency.historyPoints) hist.splice(0, hist.length - CONFIG.latency.historyPoints);
      }

      await this.ctx.storage.put("latencyState", this.state);
      await this.ctx.storage.put("lastFrame", frame);
      await this.ctx.storage.put("history", this.history);

      this.broadcast({ type: "latency", frame });
      for (const ev of events) await this.publishEvent(ev);

      // Backoff while Atlas is rate-limiting us; recover on a clean cycle.
      this.backoff = rateLimited;
      if (rateLimited) console.log("atlas 429 seen — backing off to slow cycle");
    } finally {
      this.lastCycle = { ts: started, durMs: Date.now() - started, fetched, failed, rateLimited };
      this.cycleRunning = false;
    }
  }

  // Mirrors the BGP watcher's publish path: D1 insert, broadcast, narrate
  // within the shared (D1-ledger) budget, then broadcast the AI text.
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
    this.broadcast({ type: "event", event });
    const counts = await getNarrationCounts(this.env.DB, Date.now());
    const result = await narrate(event, {
      apiKey: this.env.ANTHROPIC_API_KEY,
      enabled: this.env.NARRATION_ENABLED !== "false",
      allowed: canNarrateFromCounts(counts, event.severity, event.kind),
    });
    if (result.narrated) {
      try {
        await this.env.DB.prepare("UPDATE events SET commentary = ?, narrated = 1 WHERE id = ?")
          .bind(result.text, event.id).run();
      } catch (err) {
        console.log("D1 commentary update failed:", err);
      }
      this.broadcast({ type: "commentary", id: event.id, commentary: result.text });
    }
  }

  private statusBody() {
    const ready = this.lastFrame?.regions.filter((r) => r.ready).length ?? 0;
    return {
      lastCycleTs: this.lastCycle.ts || null,
      lastCycleDurMs: this.lastCycle.durMs,
      measurementsFetched: this.lastCycle.fetched,
      measurementsFailed: this.lastCycle.failed,
      backoff: this.backoff,
      pollIntervalMs: this.backoff ? CONFIG.latency.backoffIntervalMs : CONFIG.latency.pollIntervalMs,
      regionsReporting: this.lastFrame?.regions.filter((r) => !r.lowData).length ?? 0,
      regionsBaselineReady: ready,
      regionsTotal: Object.keys(REGIONS).length,
      frontActive: this.state.frontActive,
      clients: this.ctx.getWebSockets().length,
    };
  }
}
