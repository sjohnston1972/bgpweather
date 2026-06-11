# BGP Weather Channel — Build Spec

# repo - https://github.com/sjohnston1972/bgpweather

# cloudflare url - https://bgpweather.clydeford.net

An AI commentator that watches the global BGP routing system in real time and narrates interesting events — hijacks, leaks, withdrawal storms, outages — like a weather presenter. Runs entirely on Cloudflare (Workers + Durable Objects), with a live dashboard and a replay mode for famous historical incidents.

**Audience for this spec:** Claude Code. Build it phase by phase. The owner (Steven) is an experienced network engineer but not a developer — explain non-obvious code decisions in comments and keep the structure simple and readable over clever.

---

## 1. Goals

- Connect to the RIPE RIS Live BGP stream and detect "interesting" routing events using cheap heuristics.
- When an event fires, generate short, characterful AI commentary (weather-presenter tone) via the Anthropic API.
- Serve a live dashboard: scrolling event feed, severity colours, an "internet conditions" summary, and live stats.
- Replay mode: re-run famous historical incidents (e.g. the Facebook 2021 withdrawal) from bundled JSON fixtures through the same pipeline, for demos on calm days.
- Stay within Cloudflare free/cheap tiers and keep Anthropic token spend tightly capped.

## 2. Non-goals (v1)

- No consumption of the full RIS firehose (thousands of msgs/sec — too much for a Durable Object). We use **filtered subscriptions** instead.
- No RPKI validation pipeline (phase 3 candidate).
- No persistent multi-year history; D1 keeps a rolling window.
- No auth — it's a public demo dashboard.

## 3. Architecture

```
RIPE RIS Live (wss://ris-live.ripe.net/v1/ws/)
        │  filtered subscriptions
        ▼
┌────────────────────────────┐
│ Durable Object: Watcher    │  maintains outbound WebSocket,
│  - heuristics engine       │  runs detection, owns baselines
│  - event queue + rate caps │
└──────┬──────────────┬──────┘
       │ events       │ live fan-out (inbound WebSockets)
       ▼              ▼
   D1 (event log)   Browser dashboard (served as static assets
       ▲              by the Worker, connects WS to the DO)
       │
  Anthropic API (commentary, called from DO with strict caps)
```

**Components:**

| Piece | Cloudflare feature | Purpose |
|---|---|---|
| `Watcher` | Durable Object | Holds the outbound WS to RIS Live, runs heuristics, fans out to dashboard clients over inbound WS |
| Event log | D1 | Rolling history of detected events + commentary (30-day retention, cron cleanup) |
| Baselines/state | DO storage | Per-prefix expected origin AS, last-seen paths, counters |
| Dashboard | Worker static assets | Single-page app, vanilla JS or small React build |
| Cron trigger | Workers Cron | (a) hourly "internet conditions" summary on calm days, (b) daily D1 cleanup, (c) watchdog that pings the DO so it reconnects if the WS dropped |
| Secrets | `ANTHROPIC_API_KEY` via wrangler secrets | Commentary generation |

**Why a Durable Object:** plain Workers are stateless and short-lived; a DO gives us a single long-lived place to own the upstream WebSocket, keep in-memory baselines, and broadcast to connected dashboards. Note: holding an outbound WebSocket prevents DO hibernation — that's accepted and is the main running cost. Use WebSocket Hibernation API for the *inbound* (dashboard) sockets.

## 4. Data source: RIS Live

- Endpoint: `wss://ris-live.ripe.net/v1/ws/?client=bgp-weather-channel`
- After connect, send one `ris_subscribe` JSON message per subscription, e.g.:

```json
{"type": "ris_subscribe", "data": {"prefix": "1.1.1.0/24", "moreSpecific": true, "type": "UPDATE"}}
```

- Incoming messages have `type: "ris_message"`; the payload (`data`) includes: `peer`, `peer_asn`, `host` (collector), `type` ("UPDATE"), `path` (AS path array — may contain nested arrays for AS-sets; flatten them), `origin`, `announcements` (array of `{next_hop, prefixes[]}`), and `withdrawals` (array of prefixes).
- Implement reconnect with exponential backoff (1s → 60s cap) and resubscribe on reconnect. Also send `{"type": "ping"}` every 30s; treat 2 missed pongs/messages-silence >90s as dead and reconnect.
- Be a good citizen: keep total subscriptions modest (the watchlist below is ~30–60 prefixes).

### Watchlist (config file `watchlist.json`)

Ship a curated list of well-known prefixes with metadata, e.g.:

```json
[
  {"prefix": "1.1.1.0/24",   "expected_origin": 13335, "label": "Cloudflare DNS"},
  {"prefix": "8.8.8.0/24",   "expected_origin": 15169, "label": "Google DNS"},
  {"prefix": "9.9.9.0/24",   "expected_origin": 19281, "label": "Quad9 DNS"},
  {"prefix": "198.41.0.0/24","expected_origin": 397197, "label": "A-root DNS"}
]
```

Include: the 13 DNS root server prefixes, major public resolvers, a handful of major CDN/cloud and big-brand prefixes (~30–60 total). Each subscription uses `moreSpecific: true` so we also see hijack-style more-specific announcements. `expected_origin` values in the example above are illustrative — **verify each one at build time** against current data (e.g. RIPEstat `announced-prefixes` / `prefix-overview` API) rather than trusting this spec.

## 5. Heuristics engine (the interesting part)

All detection is cheap, in-process logic — **the LLM is never used for detection, only narration.** Each rule emits an `Event`:

```ts
type Event = {
  id: string;            // ulid
  ts: number;
  kind: "ORIGIN_CHANGE" | "MORE_SPECIFIC" | "WITHDRAWAL_STORM" |
        "FLAP" | "PATH_ANOMALY" | "CALM_SUMMARY" | "REPLAY";
  severity: 1 | 2 | 3;   // 1=curiosity, 2=notable, 3=major
  prefix?: string;
  label?: string;        // from watchlist
  details: Record<string, unknown>;  // rule-specific facts for the narrator
};
```

### Rules (v1)

1. **ORIGIN_CHANGE** — an announcement for a watchlist prefix whose origin AS ≠ `expected_origin`. Severity 3. Debounce: one event per (prefix, new_origin) per 30 min. This is the hijack detector.
2. **MORE_SPECIFIC** — an announcement strictly more specific than a watchlist prefix (e.g. a /25 inside a watched /24) from any origin. Severity 3 if origin differs from expected, else 2 (could be legitimate traffic engineering — let the narrator hedge).
3. **WITHDRAWAL_STORM** — withdrawals seen for a watchlist prefix from ≥ N distinct peers within 60s (start N=10). Severity 3. This is the "Facebook moment" detector.
4. **FLAP** — same watchlist prefix announced+withdrawn ≥ 6 times in 5 min. Severity 1–2 by count.
5. **PATH_ANOMALY** — AS path length for a watchlist prefix exceeds its rolling-average length (keep a per-prefix EWMA) by ≥ 2.5×, or path contains the same ASN non-consecutively. Severity 1.
6. **CALM_SUMMARY** — cron-driven, not stream-driven: if no severity ≥2 event in the past hour, emit a summary event carrying aggregate counters (msgs seen, announcements, withdrawals, busiest collector, etc.) so the narrator can do calm-day colour commentary.

Keep all thresholds in a single `config.ts` so they're tunable without spelunking.

**State kept in DO storage:** per-prefix `{lastOrigins: Map, ewmaPathLen, flapWindow: timestamps[], withdrawalWindow: Map<peer, ts>}` plus global counters. Persist lazily (every 60s and on alarm), keep hot copies in memory.

## 6. AI commentary

- Model: call `https://api.anthropic.com/v1/messages` with `claude-sonnet-4-5` (or current Sonnet), `max_tokens: 300`.
- **Persona prompt (system):** a slightly dry, BBC-weather-presenter-meets-network-engineer voice. Technically accurate, lightly witty, never alarmist, always says what the event *might* be (e.g. "could be a leak, could be someone's maintenance window going sideways"). 2–4 sentences. Output plain text only.
- **User message:** the serialized `Event` plus a one-line glossary of the rule that fired.
- **Hard cost caps (enforce in code, not vibes):**
  - Max 12 narrated events/hour; further events get a template fallback string ("Origin change detected on {prefix} ({label}): {old} → {new}") and are still logged/shown.
  - Severity 3 events jump the queue.
  - Calm summaries: max 1/hour.
  - Add a kill switch env var `NARRATION_ENABLED`.
- On Anthropic API failure: log, use the template fallback, never block the pipeline.

## 7. Dashboard

Single page, dark theme, served from Worker static assets. Connects to the DO over WebSocket (`/ws`); on connect, the DO sends the last 50 events from D1, then streams live.

Layout (top to bottom):

1. **Conditions banner** — current "internet weather": derived from recent event severities (Calm / Unsettled / Stormy), with the latest AI calm-summary text.
2. **Live ticker** — raw-ish stream stats: msgs/sec, announcements vs withdrawals counters, per-collector activity. Updates every 2s from a stats broadcast. (This is the "it's alive" eye candy.)
3. **Event feed** — cards, newest first: severity colour (1=blue, 2=amber, 3=red), kind badge, prefix + label, timestamp, AI commentary text, expandable raw details JSON.
4. **Replay button** — dropdown of bundled incidents, runs replay mode (below); replayed events are visually tagged `REPLAY` so nobody panics.

Keep it vanilla JS + a single CSS file if possible — fewer moving parts. Make it look good (this is a show-off project): monospace accents, subtle animations on new events, severity glow.

## 8. Replay mode

Real famous incidents come as MRT dumps, which are too heavy to parse in a Worker. Instead:

- Bundle 2–3 incidents as **pre-processed JSON fixtures** in the repo (`/fixtures/*.json`): an array of simplified RIS-style messages with relative timestamps.
- v1 fixtures can be **hand-authored reconstructions** of: (a) Facebook Oct 2021 withdrawal, (b) a classic origin hijack, (c) a path-prepend leak. Mark them clearly as reconstructions in the UI.
- The DO exposes `POST /replay/{incident}`; it feeds fixture messages through the **same heuristics pipeline** at 10–30× speed. Only one replay at a time; replay events get `kind: "REPLAY"` wrapping and are excluded from real stats/baselines.

## 9. API surface (Worker routes)

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Dashboard (static) |
| `/ws` | GET | WebSocket upgrade → DO |
| `/api/events?limit=50` | GET | Recent events from D1 (JSON) |
| `/api/status` | GET | DO health: WS connected?, msgs/sec, uptime, subscription count |
| `/replay/:incident` | POST | Trigger a replay |
| `/api/config` | GET | Current thresholds + watchlist (read-only) |

## 10. Project structure

```
bgp-weather/
├── wrangler.toml          # DO binding, D1 binding, cron triggers, assets dir
├── src/
│   ├── index.ts           # Worker entry: routing, static assets, cron handler
│   ├── watcher.ts         # Durable Object: WS client, fan-out, replay
│   ├── heuristics.ts      # pure functions: (msg, state) -> Event[] — unit-testable
│   ├── narrator.ts        # Anthropic call, persona prompt, caps, fallbacks
│   ├── config.ts          # thresholds, caps, tunables
│   └── types.ts
├── public/                # dashboard (index.html, app.js, style.css)
├── fixtures/              # replay incidents
├── watchlist.json
└── README.md              # include: what each file does, in plain English
```

Keep `heuristics.ts` as pure functions with no Cloudflare imports so it can be unit-tested with plain `vitest` against captured sample messages (commit a few real RIS messages as test fixtures).

## 11. Build phases

**Phase 1 — plumbing (prove the stream):** DO connects to RIS Live with 3 watchlist prefixes, logs messages, `/api/status` works, reconnect logic solid. *Definition of done: leave it running overnight, status still shows connected.*

**Phase 2 — detection:** full watchlist, heuristics 1–4, events into D1, template-text only (no AI yet). Unit tests for heuristics.

**Phase 3 — narration:** Anthropic integration, caps, calm summaries via cron.

**Phase 4 — dashboard:** live WS feed, ticker, conditions banner, polish.

**Phase 5 — replay:** fixtures + replay engine + UI dropdown.

Each phase should be independently deployable and demoable.

## 12. Operational notes & gotchas

- **DO CPU limits:** keep per-message work tiny; no JSON.stringify of large objects on the hot path.
- **DO eviction:** the cron watchdog (every 5 min) fetches `/api/status`; the DO checks its WS and reconnects if dead. Don't rely on the DO staying alive unprompted.
- **Anthropic egress:** `api.anthropic.com` is reachable from Workers; key via `wrangler secret put ANTHROPIC_API_KEY`.
- **D1 retention:** daily cron deletes events older than 30 days.
- **Flappy watchlist entries:** if a prefix generates constant noise, support a `"muted": true` flag in `watchlist.json`.
- **Honesty in UI:** severity-3 events should display "detected — unconfirmed" wording; we're a weather channel, not an attribution service.

## 13. Teaching notes (for the README, written for Steven)

The README should briefly explain, in plain English: what a Durable Object is and why it's used here instead of a normal Worker; why detection is heuristic code and only narration is AI (cost + latency + reliability); and how the pure-function design of `heuristics.ts` makes it testable. One paragraph each, no jargon walls.