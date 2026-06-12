# Latency Weather Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement latency_spec.md — a second "latency weather" channel fed by RIPE Atlas anchor-mesh pings, with a new `LatencyWatcher` DO, regional weather aggregation, four new event kinds through the existing D1+narrator pipeline, and a region-cell layer + channel switcher on the existing globe.

**Architecture:** New alarm-driven `LatencyWatcher` DO polls ~28 Atlas measurements every 120s, aggregates per-region stats against EWMA baselines (pure `latency-rules.ts`), broadcasts `LatencyFrame`s on its own `/ws/latency` socket, and writes events to the shared D1 log. Narration caps become genuinely global by deriving the budget from D1 (`narrated=1` rows in the past hour) instead of per-DO memory. Dashboard merges both sockets; regions render as translucent polygon cells on the globe.

**Tech stack:** existing repo conventions throughout; globe cells via globe.gl `polygonsData` (circle GeoJSON generated client-side); Atlas REST v2 polled anonymously with optional `ATLAS_API_KEY` secret.

**Spec adaptations (deliberate):** no NOC mode / sonification / lower-third (don't exist in this codebase — spec says adapt); curation script is `.mjs` like the repo's other scripts; LATENCY_CALM = latency aggregates added to the existing Watcher calm summary via a read-only stub fetch of the latency grid.

---

### Task 1: Curation (spec Phase 1)

- [ ] `scripts/generate-atlas-config.mjs`: probe the live Atlas API (capture real shapes first — `GET /api/v2/anchors/?country=GB`, `GET /api/v2/measurements/?search=<anchor fqdn>&type=ping&status=2`, `GET /api/v2/measurements/{id}/latest/`); for each of 14 regions (uk-ireland, west-europe, nordics, east-europe, south-europe, us-east, us-west, brazil, south-africa, middle-east, india, se-asia, japan-korea, australia) pick 2 anchors and resolve their IPv4 anchoring-mesh ping measurement id + lat/lng/city.
- [ ] Write `atlas-measurements.json` (repo root: `[{msmId, target, anchor, city, country, lat, lng, region}]`) and `public/regions.json` (`{id: {name, lat, lng, radius}}`).
- [ ] Capture one real `/latest/` response (trimmed) as `test/atlas-latest.fixture.json`.
- [ ] Verify: ≥ 12 regions covered, every msmId returns fresh results. Commit.

### Task 2: Pure rules engine (TDD)

- [ ] `src/latency-rules.ts`: `parseLatest(results, nowS, maxAgeS)` → per-probe `{rttMs|null}` (median of result[].rtt, `*`/missing = loss, drop stale >10min, drop rtt<0); `aggregate(byRegion samples)` → `{medianRtt,p90Rtt,lossPct,samples}`; `step(regionStats, state, cfg, now)` → mutates per-region state (EWMA α=0.05 of median + EWMA of |deviation|, cycle count, level with sample floor ≥5 and "samples collapsed <30% of normal" clause, levelSince/degradedSince) and returns `{frame: LatencyFrame, events: NewEvent[]}` implementing LATENCY_STORM (sev3 stormy/sev2 unsettled, debounce 60min per region+level), LOSS_SQUALL (Δloss ≥10pts vs previous cycle, sev2/3 at ≥25pts), CLEARING (back to Clear after ≥30min degraded, sev1), GLOBAL_FRONT (≥3 regions level≥2, sev3, debounce 2h), all gated on `cycles ≥ cfg.baselineReadyCycles` (200).
- [ ] `test/latency-rules.test.ts`: parse fixture; baseline warmup gating; each rule fires/debounces; sample-floor hold; storm-by-collapse.
- [ ] Types in `types.ts`: new EventKinds `LATENCY_STORM|LOSS_SQUALL|CLEARING|GLOBAL_FRONT`, `LatencyFrame`, `RegionState`, `AtlasMeasurement`; `Env` gains `LATENCY: DurableObjectNamespace` + `ATLAS_API_KEY?`. Thresholds in `config.ts` under `latency`.

### Task 3: Shared narration budget (refactor, TDD)

- [ ] narrator.ts: replace `NarrationBudget` with pure `canNarrateFromCounts(counts {total, nonSev3, calm}, sev, kind)` (12/hr total, 8/hr non-sev3, calm kinds 1/hr — CALM_SUMMARY counts as calm). `narrate()` takes `allowed: boolean` instead of a budget (recording = the existing `narrated=1` D1 update, which makes the events table the shared ledger).
- [ ] Watcher: query counts from D1 before narrating (`SELECT COUNT(*) ... narrated=1 AND ts>now-1h` split by severity/kind); drop budget persistence. Same helper used by LatencyWatcher.
- [ ] Forecast register added to the persona prompt + glossary/template entries for the four new kinds. Update narrator tests.

### Task 4: LatencyWatcher DO + routes

- [ ] `src/latency-watcher.ts`: alarm loop (120s, backoff to 300s on any 429 until a clean cycle); fetch each measurement's `/latest/` with concurrency 5, optional `Authorization: Key`; run rules; persist state + per-region 24h ring buffer (720 pts); publish events (D1 insert + narrate via shared budget + broadcast on own sockets); hibernation-API `/ws/latency` (on connect: latest frame); `/status`, `/grid`, `/region/:id`.
- [ ] `index.ts`: routes `/api/latency/status|grid|region/:id`, `/ws/latency`; watchdog cron also pings latency status; Watcher calm summary enriched with latency aggregates via `env.LATENCY` stub (best/worst region, global median — omit on failure).
- [ ] `wrangler.toml`: `LATENCY` binding, migration tag v2 `new_sqlite_classes=["LatencyWatcher"]`.

### Task 5: Dashboard (spec Phase 4, adapted)

- [ ] `public/latency-layer.js`: second WS with same reconnect pattern; region cells = `polygonsData` circle GeoJSON (36-segment) filled by level (Clear faint blue / Breezy teal / Unsettled amber / Stormy red + repeating red ring pulse via the shared rings array); cell labels (name, median, Δ%, loss, samples); GLOBAL_FRONT = animated amber arcs chaining degraded region centres while active.
- [ ] Channel switcher in header: BGP / LATENCY / BOTH (default BOTH, honour `?channel=`, persist localStorage). Filters feed cards (`data-channel`) and globe layers.
- [ ] Conditions banner second line when BOTH: "LATENCY: heavy over {worst regions} / clear worldwide" (+ "calibrating" while baselines warm). Footer attribution "Latency data: RIPE Atlas".
- [ ] app.js: tag events by channel (new kinds → latency), merge latency events into feed/conditions only when channel visible.

### Task 6: Ship

- [ ] README: channel description, file map additions, teaching notes (polling vs streaming; EWMA deviation-not-absolute; pure rules), homelab-probe Phase-4 note, `ATLAS_API_KEY` secret instructions.
- [ ] Full verification: vitest, tsc, deploy, `/api/latency/status` + `/grid` live sanity, `/ws/latency` probe, dashboard HTML, D1 migration. Commit + push. Flag warmup window (~7h before latency events can fire).
