# 🌐 BGP Weather Channel

**Live at [bgpweather.clydeford.net](https://bgpweather.clydeford.net)**

An AI commentator that watches the global internet in real time and narrates interesting
events like a weather presenter. Two channels, one broadcast:

- **BGP channel** — *is the internet's routing healthy?* Watches the RIPE RIS Live stream
  for hijacks, leaks, withdrawal storms and flaps on ~36 well-known prefixes.
- **Latency channel** — *how does the internet feel right now, and where?* Polls the RIPE
  Atlas anchor mesh and turns regional round-trip times and packet loss into weather:
  Clear / Breezy / Unsettled / Stormy per region, always measured against that region's
  own normal.

Runs entirely on Cloudflare (Workers + Durable Objects), with a live dashboard built around
a rotating 3D globe: collector beacons pulse with live traffic, BGP events draw
severity-coloured arcs, latency regions render as translucent weather cells, and a region
strip shows sparklines of each region's recent round-trip history.

> *"More-specific prefix announced inside watched 208.65.152.0/22 by AS17557. Could be
> traffic engineering; could be mischief. Detected — unconfirmed."*

---

## How it works, in one paragraph

A single long-lived process (a Cloudflare **Durable Object**) holds a WebSocket to
[RIPE RIS Live](https://ris-live.ripe.net/), which streams BGP updates seen by route
collectors around the world. We subscribe to ~36 well-known prefixes (DNS root servers,
public resolvers, big CDNs). Every update runs through a handful of cheap heuristic rules —
plain code, no AI — and when a rule fires, an event is written to a database, pushed to
every open dashboard, and (within strict cost caps) handed to Claude to narrate in a
weather-presenter voice.

## What each file does

| File | What it is |
|---|---|
| `wrangler.toml` | The Cloudflare deployment config: bindings, cron schedules, custom domain |
| `src/index.ts` | The Worker entry point: routes web requests, runs the cron jobs |
| `src/watcher.ts` | BGP Durable Object: holds the RIS Live connection, fans out to browsers |
| `src/latency-watcher.ts` | Latency Durable Object: polls RIPE Atlas every 2 min on a DO alarm |
| `src/heuristics.ts` | The BGP detection rules — pure functions, fully unit-tested |
| `src/latency-rules.ts` | The latency weather rules — pure functions, fully unit-tested |
| `src/narrator.ts` | The Anthropic API call, the persona prompt, the cost caps, the template fallbacks |
| `src/prefix.ts` | IPv4 prefix maths ("is this /24 inside that /22?") |
| `src/config.ts` | Every threshold and cap in one place — tune here |
| `src/types.ts` | Shared type definitions |
| `src/util.ts` | Small helpers (sortable event IDs, database row mapping) |
| `public/` | The dashboard: one HTML page, one CSS file, two JS files + globe.gl from a CDN |
| `public/latency-layer.js` | The latency channel UI: region cells, sparkline strip, channel switcher |
| `public/rrc-locations.json` | RIS route-collector cities (hardcoded at build time) for the globe beacons |
| `public/prefix-geo.json` | Watchlist prefix → home lat/long, baked at build time (`scripts/make-prefix-geo.mjs`) |
| `public/regions.json` | The 14 latency regions: names + positions for the globe cells |
| `atlas-measurements.json` | Curated Atlas anchor-mesh measurements (generated, committed) |
| `scripts/generate-atlas-config.mjs` | Re-curates the Atlas measurement set against the live API |
| `watchlist.json` | The prefixes we watch and who is allowed to announce them |
| `migrations/` | The D1 database schema |
| `test/` | Unit tests (vitest) for the heuristics, narrator caps, and prefix maths |
| `scripts/verify-watchlist.mjs` | Checks every watchlist entry against live RIPEstat data |

## Teaching notes

**Why a Durable Object instead of a normal Worker?** A normal Cloudflare Worker is
stateless and short-lived: it wakes up to answer one request and then disappears, which
makes it impossible to *hold open* a connection to RIS Live or remember anything between
messages. A Durable Object is the opposite: Cloudflare guarantees there is exactly one
instance of it, it can stay alive holding a WebSocket, and it has its own private storage.
That makes it the natural home for the stream connection, the in-memory baselines, and the
list of connected dashboard browsers. The one weak spot is that Cloudflare may still evict
an idle-looking object — so a cron job pokes it every five minutes, and its startup code
reconnects automatically.

**Why is detection plain code and only narration AI?** Three reasons. *Cost*: the stream
delivers many updates per second, and sending each one to a language model would cost real
money for no benefit. *Latency*: comparing an origin AS number against an expected list
takes microseconds; an API call takes seconds. *Reliability*: a rule like "ten distinct
peers withdrew this route within sixty seconds" either fired or it didn't — there's nothing
to hallucinate. The AI is used only where it genuinely adds value: turning a dry event
record into two sentences of colour commentary. And if the AI is unavailable or the hourly
cap is spent, a plain template string is used instead — the pipeline never depends on it.

**Why are the heuristics "pure functions", and why does that matter?** Every function in
`heuristics.ts` takes its inputs as arguments — the BGP message, the current state, the
config, even the current time — and touches nothing else: no network, no database, no
clock. That means a test can hand it a crafted message and a fake timestamp and check
exactly what comes out, with no Cloudflare environment needed. The whole detection engine
is tested in milliseconds with `npm test`. The latency channel's `latency-rules.ts` follows
exactly the same pattern, and its tests replay a real captured Atlas response.

**Why does the latency channel poll instead of streaming?** Atlas does offer a streaming
service, but it speaks Socket.IO framing — real protocol work inside a Worker — and weather
only needs minute-level granularity anyway. One cheap HTTP poll of each measurement every
two minutes gives the same picture for a fraction of the complexity. (If a region's weather
changes, it changes over minutes, not milliseconds.)

**What's an EWMA baseline, and why "deviation from normal"?** Tokyo→London is *always*
~200 ms — that's physics, not a storm. So each region keeps an exponentially-weighted
moving average of its own median round-trip time (every new sample nudges the average by
5%), and weather levels are defined as *percentage deviation from that baseline*: +25% is
Breezy, +60% Unsettled, +150% Stormy. A region only gets weather when it's behaving unlike
*itself*. New regions spend their first ~7 hours "calibrating" before any events can fire.

## Running it

```sh
npm install
npm test            # unit tests (vitest)
npx wrangler dev    # local dev server
npx wrangler deploy # deploy to Cloudflare
```

Deployment needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment
(this repo reads them from an untracked `.env`).

### Atlas API key (optional but polite)

The latency channel polls anonymously by default, which Atlas rate-limits more
aggressively. A free RIPE Atlas account gives you an API key for politeness headroom:

```sh
npx wrangler secret put ATLAS_API_KEY
```

If Atlas ever returns 429, the poll cycle automatically backs off from 120s to 300s until
a clean cycle. **Phase 4 option:** host a software probe on the homelab to earn Atlas
credits, which unlocks *creating* custom measurements rather than just reading public ones.

### Turning on AI narration

Narration falls back to plain template text until an Anthropic API key is set:

```sh
npx wrangler secret put ANTHROPIC_API_KEY
```

Cost is capped in code (`src/config.ts`): at most 12 narrated events per hour (severity-3
events get priority), at most 1 calm-day summary per hour, ~300 tokens each. Kill switch:
set the `NARRATION_ENABLED` var to `"false"` in `wrangler.toml` and redeploy.

### Tuning

- **Thresholds** all live in `src/config.ts` — debounce windows, storm peer counts, flap
  counts, path-length ratios, narration caps, replay speed.
- **Watchlist** is `watchlist.json`. Each entry: the `prefix`, the `expected_origins` ASNs
  (an array — anycast prefixes like the A-root legitimately have several), a human `label`,
  and two optional flags: `"aggregate": true` means "same-origin more-specifics are routine
  here, don't alert" (for big CDN blocks), and `"muted": true` switches an entry off
  entirely. Akamai's block ships muted: they delegate subnets to so many ASNs and partner
  caches that it false-alarms constantly — we learned that from live traffic within minutes
  of first deploy.
- **Verify origins** after editing: `node scripts/verify-watchlist.mjs` checks every entry
  against live RIPEstat data.
- **Globe geography**: collector beacon positions live in `public/rrc-locations.json`;
  prefix "home" positions are baked by `npm run geo` (no geolocation API is called at
  runtime — the dashboard only fetches two tiny static JSON files).

## API

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Dashboard |
| `/ws` | GET | WebSocket: history + live events + stats |
| `/api/events?limit=50` | GET | Recent events, both channels (JSON) |
| `/api/status` | GET | BGP health: connected? msgs/sec, subscriptions |
| `/api/config` | GET | Current thresholds + watchlist (read-only) |
| `/ws/latency` | GET | WebSocket: latency frames + latency events |
| `/api/latency/status` | GET | Latency health: last cycle, fetch counts, backoff state |
| `/api/latency/grid` | GET | Most recent regional weather frame (JSON) |
| `/api/latency/history?points=120` | GET | Downsampled 24h history per region (sparklines) |
| `/api/latency/region/:id` | GET | One region: current stats + 24h ring buffer |

The dashboard honours `?channel=bgp`, `?channel=latency`, or `?channel=both` (default).

## Honesty notes

Severity-3 events display **"detected — unconfirmed"**. The heuristics see symptoms, not
causes: an "origin change" might be a hijack, or a typo, or a business arrangement the
watchlist doesn't know about. This is a weather channel, not an attribution service.
