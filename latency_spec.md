# Latency Weather Map — Extension Spec for the BGP Weather Channel

A second "channel" for the existing BGP Weather broadcast: live global latency conditions measured by the RIPE Atlas probe network, rendered as weather over the same globe, narrated by the same AI presenter. BGP channel = "is the internet's routing healthy?"; Latency channel = "how does the internet *feel* right now, and where?"

**Audience for this spec:** Claude Code, working inside the **existing bgp-weather repo**. This is an extension, not a new app. Reuse the existing patterns (Durable Object, D1 event log, narrator with caps, globe dashboard, replay/NOC conventions). Where this spec names files/types from the original spec, adapt to whatever the implemented codebase actually calls them — read the repo first.

---

## 1. Goals

- Continuously sample real-world latency and packet loss between RIPE Atlas anchors/probes worldwide — using only **free, public, read-only** Atlas data (no credits required).
- Aggregate into regional "weather": Clear / Breezy / Unsettled / Stormy per region, with baselines so weather means *deviation from normal*, not absolute RTT.
- Detect events (regional latency storms, packet-loss squalls, recoveries) and feed them into the **existing event pipeline and AI narrator**, extended with a forecast-style persona.
- Render a latency layer on the existing globe: coloured regional cells and animated "weather fronts," with a channel switcher (BGP / Latency / Both).

## 2. Non-goals (v1)

- No Atlas measurement *creation* (costs credits). Read-only consumption of existing public measurements. (Phase 4 option: Steven hosts a software probe on the homelab to earn credits, unlocking custom measurements — note this in the README.)
- No per-probe real-time streaming in v1 — weather-granularity polling is sufficient and far simpler (see §3.3).
- No attempt to diagnose *causes*; the narrator hedges like a weather presenter, same as the BGP channel.

## 3. Data source: RIPE Atlas

### 3.1 What it is

RIPE Atlas is a global measurement network of ~12,000 small hardware/software probes plus several hundred "anchors" (well-connected reference nodes). Probes continuously run **built-in measurements** (e.g. pings to DNS root servers) and anchors run a **mesh of pings between each other**. Results of public measurements are fetchable by anyone via REST API.

Base URL: `https://atlas.ripe.net/api/v2/`

### 3.2 Which measurements to consume

At **build time**, generate a curated `atlas-measurements.json` (committed to the repo) by querying the API:

1. **Anchor mesh pings** — discover via `GET /api/v2/measurements/?type=ping&description__startswith=Anchoring&status=2&page_size=...` (verify exact filter syntax against the live API; the goal is ongoing anchor-to-anchor ping measurements). Select ~20–40 measurements whose targets give good geographic spread (anchors in: UK, W. Europe, E. Europe, US East, US West, Brazil, South Africa, Middle East, India, SE Asia, Japan, Australia — aim for 2–3 anchors per region).
2. **Built-in root-server pings** as a fallback/supplement — discover via the API rather than hardcoding IDs (built-in measurement IDs exist but **verify them live; do not trust memory**).

For each selected measurement, also resolve and bake in: target anchor's location (lat/long, country, city) from `GET /api/v2/anchors/` or the measurement's target metadata.

Write a small `scripts/generate-atlas-config.ts` (run locally with Node, not in the Worker) that produces `atlas-measurements.json` — so the curation is reproducible and refreshable.

### 3.3 Polling, not streaming (v1 decision)

Atlas offers a result-streaming service, but it speaks Socket.IO/engine.io framing — extra protocol work inside a Worker for little gain, since weather only needs minute-level granularity. **v1 polls instead:**

- `GET /api/v2/measurements/{id}/latest/` returns the most recent result per probe for that measurement — one call per measurement per cycle.
- Poll cycle: every **120s**, fetch all configured measurements (sequentially or small batches; ~20–40 HTTP GETs per cycle is trivial).
- **Auth:** create a free RIPE Atlas account and API key; send it as `Authorization: Key <ATLAS_API_KEY>` (wrangler secret). Anonymous access works but is rate-limited more aggressively — the key is just politeness headroom.
- Respect rate limits: if a 429 appears, back off the cycle to 300s and emit a status warning.

Stretch goal (Phase 4): implement the streaming connection for sub-minute reactivity, behind a flag.

## 4. Architecture

```
RIPE Atlas REST API  ◄── alarm-driven polling every 120s
        │
┌──────────────────────────────┐
│ Durable Object: LatencyWatcher │  (new DO, sibling of the BGP watcher)
│  - poll cycle via DO alarms    │
│  - regional aggregation        │
│  - baselines (EWMA + variance) │
│  - weather rules → Events      │
└──────┬───────────────┬────────┘
       │ events        │ latency grid broadcasts
       ▼               ▼
  existing D1      dashboard clients (same /ws fan-out pattern;
  event log         either route latency frames through the existing
       ▲            socket or a parallel /ws/latency — match repo style)
       │
  existing narrator (extended persona)
```

**Why a separate DO** rather than extending the BGP watcher: different lifecycle (alarm-driven polling vs persistent upstream WebSocket), independent failure domains, and it keeps each file comprehensible. They share types, D1, and the narrator module.

Use **DO alarms** for the poll loop (`storage.setAlarm`), re-arming at the end of each cycle. The existing cron watchdog should also ping `/api/latency/status` to resurrect the DO if needed.

## 5. Aggregation & data model

### 5.1 Regions

Bucket the world into **named regions** (not raw geohashes — the narrator needs names): a static `regions.json` mapping each configured anchor/target to a region like `"uk-ireland"`, `"us-east"`, `"japan-korea"`, etc. (~12–16 regions matching the anchor curation in §3.2). Each region entry includes a display name and a representative lat/long + radius for rendering.

### 5.2 Per-cycle computation

Each poll cycle, for each region:

- Collect all RTT samples from results whose **target** is in that region (median of each probe's reported RTTs; ignore probes reporting from impossible RTT < 0 or missing).
- Compute: `medianRtt`, `p90Rtt`, `lossPct` (probes with 100% loss ÷ probes reporting), `sampleCount`.
- Update baselines kept in DO storage: EWMA of medianRtt (`α = 0.05`) and an EWMA of absolute deviation (acts as a robust stddev). Baselines persist across restarts.
- Derive **weather level** per region:

| Level | Condition (vs baseline) |
|---|---|
| Clear | medianRtt within +25% of EWMA and loss < 2% |
| Breezy | +25–60% or loss 2–5% |
| Unsettled | +60–150% or loss 5–15% |
| Stormy | > +150%, or loss > 15%, or sampleCount collapsed to < 30% of normal |

Thresholds live in the shared `config.ts`. Require `sampleCount >= 5` to change a region's level (otherwise hold previous level and mark "low data").

### 5.3 Broadcast frame

After each cycle, broadcast a compact grid to dashboard clients:

```ts
type LatencyFrame = {
  ts: number;
  regions: Array<{ id: string; level: 0|1|2|3; medianRtt: number;
                   deltaPct: number; lossPct: number; samples: number }>;
}
```

## 6. Event rules (feed the existing pipeline)

New `Event.kind` values, same Event shape, same D1 table, same severity/debounce conventions as the BGP channel:

1. **LATENCY_STORM** — a region enters Stormy (severity 3) or Unsettled (severity 2). Debounce: one event per region per level per 60 min. `details` carries region name, medianRtt vs baseline, loss, sample count.
2. **LOSS_SQUALL** — lossPct jumps ≥ 10 percentage points vs previous cycle in one region (severity 2–3 by magnitude) even if RTT looks fine.
3. **CLEARING** — a region returns to Clear after ≥ 30 min of Unsettled/Stormy (severity 1; presenters love a recovery story).
4. **GLOBAL_FRONT** — ≥ 3 regions Unsettled+ simultaneously (severity 3): "a widespread front." Debounce 2h.
5. **LATENCY_CALM** — folded into the existing hourly calm-summary cron: include latency aggregates (global median RTT, best/worst region) so calm commentary can cover both channels.

## 7. Narrator extensions

- Extend the existing persona prompt with a **forecast register** used for latency events: regional weather language ("a band of heavy latency moving across US-East this evening, round-trips up forty percent on seasonal norms; expect sluggish conditions if your packets are travelling that way"). Keep the same dryness, hedging, and 2–4 sentence limit.
- Latency events share the **same narration rate caps** as BGP events (one global budget — do not double the spend). GLOBAL_FRONT and Stormy jump the queue alongside BGP severity-3s.
- Template fallbacks per kind, as before.

## 8. Dashboard integration

### 8.1 Channel switcher

Header control: **BGP / LATENCY / BOTH** (default BOTH). NOC mode honours `?channel=`.

### 8.2 Latency layer on the globe

- Each region rendered as a **translucent cell** (circle/hex at its representative point, radius from `regions.json`), filled by level: Clear = faint blue, Breezy = teal, Unsettled = amber, Stormy = red with a slow pulse.
- **Weather fronts:** when GLOBAL_FRONT is active, draw an animated arc/band sweeping through the affected regions — pure cosmetic theatre, derived from which regions are degraded.
- Cell tooltips/tap: region name, median RTT, Δ vs normal, loss, samples.
- Latency events appear in the existing lower-third feed and presenter card; sonification: reuse the existing stinger palette, plus a soft "rain" texture (filtered noise) while any region is Stormy.

### 8.3 Conditions banner

Banner becomes two-line when BOTH: routing conditions (existing) + "LATENCY: heavy over {worst regions} / clear worldwide."

## 9. New API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/latency/status` | GET | DO health: last cycle ts, cycle duration, regions reporting, backoff state |
| `/api/latency/grid` | GET | Most recent LatencyFrame (JSON) |
| `/api/latency/region/:id` | GET | Region detail: current stats + last 24h of cycle history (keep a rolling ring buffer in DO storage, ~720 points) |

## 10. Repo additions

```
src/
  latency-watcher.ts    # new DO: alarm loop, polling, aggregation, rules
  latency-rules.ts      # pure functions: (frame, baselines) -> Event[] — unit-testable
public/
  latency-layer.js      # globe cells, fronts, channel switcher glue
  regions.json
atlas-measurements.json # generated, committed
scripts/
  generate-atlas-config.ts  # local Node script: curates measurements + regions
```

Add the `LatencyWatcher` DO binding and `ATLAS_API_KEY` secret to `wrangler.toml`/secrets. Keep `latency-rules.ts` pure and unit-test it with captured `/latest/` responses committed as fixtures.

## 11. Build phases

**Phase 1 — curation:** write `generate-atlas-config.ts`, produce `atlas-measurements.json` + `regions.json` with real verified measurement IDs and anchor locations. *Done when: the script runs locally and the JSON covers ≥ 12 regions.*

**Phase 2 — polling & aggregation:** LatencyWatcher polls, computes regional stats + baselines, `/api/latency/grid` returns sane data. Let baselines warm up for ~24h before trusting weather levels (gate event emission behind a `baselineReady` flag: ≥ 200 cycles observed per region).

**Phase 3 — events & narration:** rules 1–5 live, events in D1 and the feed, narrator forecast register, shared rate caps.

**Phase 4 — globe layer & theatre:** cells, fronts, channel switcher, banner, rain texture. Stretch: Atlas streaming behind a flag; homelab software probe + credits for custom measurements.

## 12. Gotchas

- **Verify everything against the live API** — measurement filters, result schemas, and built-in IDs in this spec are directional, not gospel. Capture real responses early and shape parsing around them.
- **Result schema variance:** ping results report RTTs as an array of `{rtt}` objects with `*` / missing for losses; some probes return errors or stale results — drop anything older than 10 min from a `/latest/` response.
- **Probe churn:** sampleCount swings are normal; that's why level changes require a minimum sample floor and Stormy includes the "samples collapsed" clause (a regional probe blackout is itself weather).
- **Subrequest limits:** keep the poll cycle's fetch count well under Workers' per-invocation subrequest cap; batch sequentially with modest concurrency (e.g. 5 at a time).
- **Don't pollute BGP baselines or stats** — channels share the event log and narrator, nothing else.
- **Attribution:** add "Latency data: RIPE Atlas" to the dashboard footer; it's required-courtesy for Atlas data use.

## 13. Teaching notes (README additions, plain English)

One paragraph each: why polling beats streaming here (granularity needed vs protocol complexity); what an EWMA baseline is and why "weather" must mean deviation-from-normal rather than raw milliseconds (Tokyo→London is *always* 200ms — that's not a storm); and why the rules engine is pure functions again (same testability story as the BGP heuristics).