// Worker entry: static assets in public/ are served automatically for matching
// paths; everything else lands here and is routed to the single Watcher DO,
// D1, or the cron handlers.

import { CONFIG } from "./config";
import { rowToEvent } from "./util";
import type { Env } from "./types";
import watchlistJson from "../watchlist.json";

export { Watcher } from "./watcher";

function watcherStub(env: Env) {
  // One global watcher for the whole deployment — idFromName is deterministic.
  return env.WATCHER.get(env.WATCHER.idFromName("singleton"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // Pass the original request through so the Upgrade header survives.
      return watcherStub(env).fetch(request);
    }

    if (url.pathname === "/api/status") {
      return watcherStub(env).fetch("https://do/status");
    }

    if (url.pathname === "/api/events") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 200);
      const rows = await env.DB.prepare("SELECT * FROM events ORDER BY ts DESC LIMIT ?").bind(limit).all();
      return Response.json(rows.results.map(rowToEvent));
    }

    if (url.pathname === "/api/config") {
      return Response.json({
        rules: CONFIG.rules,
        narration: {
          maxPerHour: CONFIG.narration.maxPerHour,
          calmMaxPerHour: CONFIG.narration.calmMaxPerHour,
          model: CONFIG.narration.model,
        },
        watchlist: watchlistJson,
      });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case "*/5 * * * *":
        // Watchdog: poking the DO wakes it if evicted; its constructor reconnects.
        ctx.waitUntil(watcherStub(env).fetch("https://do/status"));
        break;
      case "0 * * * *":
        // Hourly calm-day summary (the DO checks whether the hour was actually calm).
        ctx.waitUntil(watcherStub(env).fetch("https://do/cron/calm", { method: "POST" }));
        break;
      case "30 3 * * *":
        // Daily retention cleanup.
        ctx.waitUntil(
          env.DB.prepare("DELETE FROM events WHERE ts < ?")
            .bind(Date.now() - CONFIG.retentionDays * 86_400_000).run(),
        );
        break;
    }
  },
} satisfies ExportedHandler<Env>;
