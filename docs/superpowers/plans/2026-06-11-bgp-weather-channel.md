# BGP Weather Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the BGP Weather Channel per `spec.md`: a Cloudflare Worker + Durable Object that watches RIPE RIS Live, detects routing events with pure-function heuristics, narrates them via the Anthropic API (with hard caps and template fallbacks), serves a live dashboard at https://bgpweather.clydeford.net, and supports replay of three reconstructed historical incidents.

**Architecture:** One Worker (`src/index.ts`) routes API/WS traffic to a single named Durable Object (`Watcher`) that owns the outbound WebSocket to RIS Live, runs detection, writes events to D1, and fans out to dashboard browsers over inbound WebSockets. Detection (`heuristics.ts`) and narration budgeting (`narrator.ts`) are pure/CF-free so vitest can test them directly. Static dashboard served from Worker assets.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite-backed) + D1 + Workers Cron + static assets; TypeScript bundled by wrangler; vitest for unit tests; vanilla JS/CSS dashboard; Anthropic Messages API (`claude-sonnet-4-6`).

**Key facts established before planning (do not re-derive):**
- `.env` has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (wrangler reads both from env vars). **`.env` must be gitignored — it holds a live token.**
- No `ANTHROPIC_API_KEY` available; narration must degrade gracefully to templates. Flag `npx wrangler secret put ANTHROPIC_API_KEY` to the owner at the end.
- GitHub repo `sjohnston1972/bgpweather` exists, default branch `main`, contains only `README.md`.
- Watchlist origins verified 2026-06-11 via RIPEstat (see Task 1 for the full verified list). A-root and J-root are anycast from **multiple** Verisign ASNs → watchlist schema uses `expected_origins: number[]`. Big aggregates (Apple /8, Akamai /13, etc.) routinely announce same-origin more-specifics → `aggregate: true` flag suppresses same-origin MORE_SPECIFIC events for those entries.
- Wrangler not installed globally → project devDependency, run via `npx wrangler`.
- Every wrangler command in PowerShell must first load `.env`:
  `Get-Content .env | ForEach-Object { if ($_ -match '^(\w+)=(.+)$') { Set-Item "env:$($Matches[1])" $Matches[2] } }`

---

### Task 0: Git + project scaffolding

**Files:**
- Create: `.gitignore`, `package.json`, `tsconfig.json`, `wrangler.toml`, `migrations/0001_init.sql`

- [ ] **Step 0.1: Initialise git and connect the existing repo**

```powershell
git init -b main
git remote add origin https://github.com/sjohnston1972/bgpweather.git
git fetch origin
git merge origin/main --allow-unrelated-histories
```
Expected: working tree now also contains the repo's `README.md`.

- [ ] **Step 0.2: Create `.gitignore`** (CRITICAL: before any commit — `.env` holds a live Cloudflare token)

```
node_modules/
.wrangler/
.env
.dev.vars
dist/
```

- [ ] **Step 0.3: Create `package.json`**

```json
{
  "name": "bgp-weather",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "fixtures": "node scripts/make-fixtures.mjs"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260601.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

Run: `npm install` — expected: installs cleanly (adjust ^versions to whatever npm resolves; exact pins not required).

- [ ] **Step 0.4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 0.5: Create `wrangler.toml`**

```toml
name = "bgp-weather"
main = "src/index.ts"
compatibility_date = "2026-06-01"

# Dashboard files in public/ are served directly; anything else falls through to the Worker.
[assets]
directory = "public"
binding = "ASSETS"

[[durable_objects.bindings]]
name = "WATCHER"
class_name = "Watcher"

# SQLite-backed DO class — required for the free plan and the modern default.
[[migrations]]
tag = "v1"
new_sqlite_classes = ["Watcher"]

[[d1_databases]]
binding = "DB"
database_name = "bgp-weather"
database_id = "FILLED-IN-TASK-8"   # paste from `wrangler d1 create` output in Task 8

[triggers]
# 1) watchdog ping so the DO reconnects if evicted, 2) hourly calm summary, 3) daily D1 cleanup
crons = ["*/5 * * * *", "0 * * * *", "30 3 * * *"]

[vars]
NARRATION_ENABLED = "true"

routes = [
  { pattern = "bgpweather.clydeford.net", custom_domain = true }
]

[observability]
enabled = true
```

- [ ] **Step 0.6: Create `migrations/0001_init.sql`**

```sql
-- Rolling event log. details is a JSON blob of rule-specific facts.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,            -- ulid: sortable by creation time
  ts INTEGER NOT NULL,            -- epoch ms
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL,
  prefix TEXT,
  label TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  commentary TEXT,
  narrated INTEGER NOT NULL DEFAULT 0,  -- 1 = AI text, 0 = template fallback
  replay INTEGER NOT NULL DEFAULT 0     -- 1 = replayed incident, excluded from "real" queries
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);
```

- [ ] **Step 0.7: Create `public/.gitkeep`** (empty placeholder so wrangler's assets dir exists before Task 9), then commit

```powershell
git add -A
git commit -m "chore: scaffold project (wrangler, tsconfig, D1 migration)"
```

### Task 1: Verified watchlist

**Files:**
- Create: `watchlist.json`
- Keep: `scripts/verify-watchlist.mjs` (already written; commit it)

- [ ] **Step 1.1: Create `watchlist.json`** with the RIPEstat-verified data (verified 2026-06-11):

```json
[
  {"prefix": "198.41.0.0/24",    "expected_origins": [396549, 396566, 396555, 397197, 19836], "label": "A-root DNS (Verisign)"},
  {"prefix": "170.247.170.0/24", "expected_origins": [394353], "label": "B-root DNS (USC-ISI)"},
  {"prefix": "192.33.4.0/24",    "expected_origins": [2149],   "label": "C-root DNS (Cogent)"},
  {"prefix": "199.7.91.0/24",    "expected_origins": [10886],  "label": "D-root DNS (UMD)"},
  {"prefix": "192.203.230.0/24", "expected_origins": [21556],  "label": "E-root DNS (NASA)"},
  {"prefix": "192.5.5.0/24",     "expected_origins": [3557],   "label": "F-root DNS (ISC)"},
  {"prefix": "192.112.36.0/24",  "expected_origins": [5927],   "label": "G-root DNS (US DoD)"},
  {"prefix": "198.97.190.0/24",  "expected_origins": [1508],   "label": "H-root DNS (US Army)"},
  {"prefix": "192.36.148.0/24",  "expected_origins": [29216],  "label": "I-root DNS (Netnod)"},
  {"prefix": "192.58.128.0/24",  "expected_origins": [396566, 396761, 397197, 396688, 396707, 396748, 396549, 396661], "label": "J-root DNS (Verisign)"},
  {"prefix": "193.0.14.0/24",    "expected_origins": [25152],  "label": "K-root DNS (RIPE NCC)"},
  {"prefix": "199.7.83.0/24",    "expected_origins": [20144],  "label": "L-root DNS (ICANN)"},
  {"prefix": "202.12.27.0/24",   "expected_origins": [7500],   "label": "M-root DNS (WIDE)"},
  {"prefix": "1.1.1.0/24",       "expected_origins": [13335],  "label": "Cloudflare DNS (1.1.1.1)"},
  {"prefix": "1.0.0.0/24",       "expected_origins": [13335],  "label": "Cloudflare DNS (1.0.0.1)"},
  {"prefix": "8.8.8.0/24",       "expected_origins": [15169],  "label": "Google DNS (8.8.8.8)"},
  {"prefix": "8.8.4.0/24",       "expected_origins": [15169],  "label": "Google DNS (8.8.4.4)"},
  {"prefix": "9.9.9.0/24",       "expected_origins": [19281],  "label": "Quad9 DNS (9.9.9.9)"},
  {"prefix": "149.112.112.0/24", "expected_origins": [19281],  "label": "Quad9 DNS (secondary)"},
  {"prefix": "208.67.222.0/24",  "expected_origins": [36692],  "label": "OpenDNS / Cisco Umbrella"},
  {"prefix": "94.140.14.0/24",   "expected_origins": [212772], "label": "AdGuard DNS"},
  {"prefix": "104.16.0.0/20",    "expected_origins": [13335],  "label": "Cloudflare CDN", "aggregate": true},
  {"prefix": "151.101.0.0/16",   "expected_origins": [54113],  "label": "Fastly CDN", "aggregate": true},
  {"prefix": "2.16.0.0/13",      "expected_origins": [20940],  "label": "Akamai CDN", "aggregate": true},
  {"prefix": "142.250.0.0/15",   "expected_origins": [15169],  "label": "Google services", "aggregate": true},
  {"prefix": "157.240.0.0/17",   "expected_origins": [32934],  "label": "Meta / Facebook", "aggregate": true},
  {"prefix": "129.134.30.0/24",  "expected_origins": [32934],  "label": "Facebook DNS (a.ns)"},
  {"prefix": "17.0.0.0/8",       "expected_origins": [714],    "label": "Apple", "aggregate": true},
  {"prefix": "140.82.112.0/20",  "expected_origins": [36459],  "label": "GitHub", "aggregate": true},
  {"prefix": "104.244.42.0/24",  "expected_origins": [13414],  "label": "X / Twitter"},
  {"prefix": "208.80.154.0/23",  "expected_origins": [14907],  "label": "Wikimedia"},
  {"prefix": "198.38.96.0/19",   "expected_origins": [2906],   "label": "Netflix", "aggregate": true},
  {"prefix": "52.94.0.0/22",     "expected_origins": [16509],  "label": "Amazon AWS", "aggregate": true},
  {"prefix": "13.107.42.0/24",   "expected_origins": [8068],   "label": "Microsoft 365"},
  {"prefix": "149.154.160.0/22", "expected_origins": [62041],  "label": "Telegram"},
  {"prefix": "185.199.108.0/22", "expected_origins": [54113],  "label": "GitHub Pages (via Fastly)"}
]
```

- [ ] **Step 1.2: Commit**

```powershell
git add watchlist.json scripts/verify-watchlist.mjs
git commit -m "feat: RIPEstat-verified watchlist (36 prefixes) + verification script"
```

### Task 2: Types + config

**Files:**
- Create: `src/types.ts`, `src/config.ts`

Both files are pure TypeScript with **no Cloudflare imports** (the `Env` interface uses ambient types from `@cloudflare/workers-types`, which erase at runtime so vitest is unaffected).

- [ ] **Step 2.1: Create `src/types.ts`**

```ts
// Shared types. No runtime code here — safe to import from anywhere, including tests.

export type EventKind =
  | "ORIGIN_CHANGE" | "MORE_SPECIFIC" | "WITHDRAWAL_STORM"
  | "FLAP" | "PATH_ANOMALY" | "CALM_SUMMARY" | "REPLAY";

export type Severity = 1 | 2 | 3;

// What the heuristics emit (no id yet — the Watcher assigns a ulid when it publishes).
export interface NewEvent {
  ts: number;
  kind: EventKind;
  severity: Severity;
  prefix?: string;
  label?: string;
  details: Record<string, unknown>;
}

export interface BgpEvent extends NewEvent {
  id: string;
  commentary: string;
  narrated: boolean;   // true = AI text, false = template fallback
  replay: boolean;
}

// The `data` payload of a RIS Live "ris_message".
export interface RisUpdate {
  timestamp: number;     // epoch seconds (float)
  peer: string;          // peer IP
  peer_asn: string;
  host: string;          // collector, e.g. "rrc21.ripe.net"
  type: string;          // "UPDATE"
  path?: (number | number[])[];  // AS path; nested arrays are AS-sets — flatten them
  announcements?: { next_hop: string; prefixes: string[] }[];
  withdrawals?: string[];
}

export interface WatchlistEntry {
  prefix: string;
  expected_origins: number[];  // array: anycast prefixes (A/J root) have several legit origins
  label: string;
  aggregate?: boolean;  // true = same-origin more-specifics are routine; don't alert on them
  muted?: boolean;      // escape hatch for noisy entries
}

// Per-watched-prefix detection state (see spec §5).
export interface PrefixState {
  originDebounce: Record<string, number>;  // observed origin ASN -> ts of last ORIGIN_CHANGE event
  msDebounce: Record<string, number>;      // "announcedPrefix|origin" -> ts of last MORE_SPECIFIC event
  ewmaPathLen: number;
  ewmaSamples: number;
  pathAnomalyDebounce: number;
  flapEvents: { ts: number; t: "A" | "W" }[];
  flapDebounce: number;
  withdrawalPeers: Record<string, number>; // peer IP -> last withdrawal ts
  stormDebounce: number;
}

export interface Counters {
  messages: number;
  announcements: number;
  withdrawals: number;
  perCollector: Record<string, number>;
  eventsByKind: Record<string, number>;
  since: number;
}

export interface HeuristicsState {
  prefixes: Record<string, PrefixState>;  // keyed by watchlist prefix string
  counters: Counters;
}

// Replay fixture shape (fixtures/*.json).
export interface FixtureMessage { dt: number; data: RisUpdate }  // dt = ms since incident start
export interface Fixture {
  name: string;
  title: string;
  description: string;
  disclaimer: string;
  speed: number;        // time compression factor
  watchlist: WatchlistEntry[];
  messages: FixtureMessage[];
}

export interface Env {
  WATCHER: DurableObjectNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  NARRATION_ENABLED?: string;
}
```

- [ ] **Step 2.2: Create `src/config.ts`** — every tunable in one place per spec §5

```ts
// All thresholds and caps live here so tuning never requires spelunking.

export const CONFIG = {
  ris: {
    // RIS Live websocket, reached via fetch+Upgrade (https scheme, not wss).
    url: "https://ris-live.ripe.net/v1/ws/?client=bgp-weather-channel",
    pingIntervalMs: 30_000,
    silenceTimeoutMs: 90_000,    // no messages for this long => connection considered dead
    backoffInitialMs: 1_000,
    backoffMaxMs: 60_000,
  },
  rules: {
    originChangeDebounceMs: 30 * 60_000,  // one event per (prefix, new origin) per 30 min
    moreSpecificDebounceMs: 30 * 60_000,
    stormPeerThreshold: 10,               // distinct peers withdrawing within the window
    stormWindowMs: 60_000,
    stormDebounceMs: 10 * 60_000,
    flapThreshold: 6,                     // announce+withdraw transitions in window
    flapBigThreshold: 12,                 // >= this many => severity 2
    flapWindowMs: 5 * 60_000,
    flapDebounceMs: 5 * 60_000,
    pathEwmaAlpha: 0.2,
    pathEwmaMinSamples: 20,               // don't judge path length until baseline settles
    pathLenRatio: 2.5,
    pathAnomalyDebounceMs: 30 * 60_000,
  },
  narration: {
    model: "claude-sonnet-4-6",
    maxTokens: 300,
    maxPerHour: 12,          // hard total cap
    maxNonSev3PerHour: 8,    // severity-3 events get the remaining headroom ("jump the queue")
    calmMaxPerHour: 1,
  },
  replay: {
    defaultSpeed: 20,
    maxWaitMs: 3_000,   // never stall a demo longer than this between messages
  },
  retentionDays: 30,
  persistIntervalMs: 60_000,
  statsBroadcastMs: 2_000,
} as const;

export type Config = typeof CONFIG;
```

- [ ] **Step 2.3: Commit** — `git add src; git commit -m "feat: shared types and tunable config"`

### Task 3: IPv4 prefix math (TDD)

**Files:**
- Create: `src/prefix.ts`
- Test: `test/prefix.test.ts`

- [ ] **Step 3.1: Write the failing test `test/prefix.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parsePrefix, isWithin, isMoreSpecific } from "../src/prefix";

describe("parsePrefix", () => {
  it("parses a /24", () => {
    expect(parsePrefix("1.1.1.0/24")).toEqual({ base: (1 << 24 | 1 << 16 | 1 << 8) >>> 0, len: 24 });
  });
  it("masks host bits to the network address", () => {
    expect(parsePrefix("10.0.0.255/24")).toEqual(parsePrefix("10.0.0.0/24"));
  });
  it("returns null for IPv6 (v1 is v4-only)", () => {
    expect(parsePrefix("2001:db8::/32")).toBeNull();
  });
  it("returns null for garbage and out-of-range", () => {
    expect(parsePrefix("not-a-prefix")).toBeNull();
    expect(parsePrefix("1.2.3.300/24")).toBeNull();
    expect(parsePrefix("1.2.3.0/33")).toBeNull();
  });
  it("handles /8 and /32 and high octets (unsigned math)", () => {
    expect(parsePrefix("17.0.0.0/8")).toEqual({ base: 17 * 2 ** 24, len: 8 });
    expect(parsePrefix("202.12.27.1/32")!.len).toBe(32);
    expect(parsePrefix("202.12.27.0/24")!.base).toBeGreaterThan(0); // 202 sets the sign bit if done signed
  });
});

describe("containment", () => {
  const p24 = parsePrefix("208.65.152.0/22")!;
  it("a /24 inside the /22 is within and more specific", () => {
    const child = parsePrefix("208.65.153.0/24")!;
    expect(isWithin(child, p24)).toBe(true);
    expect(isMoreSpecific(child, p24)).toBe(true);
  });
  it("the same prefix is within but NOT more specific", () => {
    expect(isMoreSpecific(parsePrefix("208.65.152.0/22")!, p24)).toBe(false);
    expect(isWithin(parsePrefix("208.65.152.0/22")!, p24)).toBe(true);
  });
  it("a sibling /24 outside is neither", () => {
    expect(isWithin(parsePrefix("208.65.156.0/24")!, p24)).toBe(false);
  });
  it("a covering /16 is not within the /22", () => {
    expect(isWithin(parsePrefix("208.65.0.0/16")!, p24)).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run to verify failure** — `npx vitest run test/prefix.test.ts` → FAIL (cannot resolve `../src/prefix`)

- [ ] **Step 3.3: Implement `src/prefix.ts`**

```ts
// Tiny IPv4 prefix math. v1 is IPv4-only: parsePrefix returns null for anything
// else and callers skip those prefixes. All math is unsigned 32-bit (>>> 0)
// because JS bitwise ops are otherwise signed and 202.x.x.x would go negative.

export interface ParsedPrefix { base: number; len: number }

export function parsePrefix(p: string): ParsedPrefix | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(p);
  if (!m) return null;
  const [a, b, c, d, len] = m.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255 || len > 32) return null;
  const ip = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
  return { base: (ip & mask) >>> 0, len };
}

export function isWithin(child: ParsedPrefix, parent: ParsedPrefix): boolean {
  if (child.len < parent.len) return false;
  const mask = parent.len === 0 ? 0 : (~0 << (32 - parent.len)) >>> 0;
  return ((child.base & mask) >>> 0) === parent.base;
}

// Strictly more specific: inside the parent AND a longer mask.
export function isMoreSpecific(child: ParsedPrefix, parent: ParsedPrefix): boolean {
  return child.len > parent.len && isWithin(child, parent);
}
```

- [ ] **Step 3.4: Run to verify pass** — `npx vitest run test/prefix.test.ts` → PASS
- [ ] **Step 3.5: Commit** — `git add src/prefix.ts test/prefix.test.ts; git commit -m "feat: IPv4 prefix containment math"`

### Task 4: ulid util

**Files:**
- Create: `src/util.ts`
- Test: `test/util.test.ts`

- [ ] **Step 4.1: Write failing test `test/util.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ulid } from "../src/util";

describe("ulid", () => {
  it("is 26 chars of Crockford base32", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("sorts by creation time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a < b).toBe(true);
  });
  it("is unique across calls", () => {
    expect(new Set(Array.from({ length: 100 }, () => ulid())).size).toBe(100);
  });
});
```

- [ ] **Step 4.2: Verify failure**, then implement `src/util.ts`

```ts
// Minimal ULID: 48-bit timestamp + 80 random bits, Crockford base32.
// Lexicographic order == creation order, which makes D1 ids sortable for free.

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let t = now;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = B32[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let randPart = "";
  for (let i = 0; i < 16; i++) randPart += B32[rand[i] % 32];
  return timePart + randPart;
}
```

- [ ] **Step 4.3: Verify pass, commit** — `git commit -m "feat: ulid generator"`

### Task 5: Heuristics engine (TDD — the core)

**Files:**
- Create: `src/heuristics.ts`
- Test: `test/heuristics.test.ts`

Pure functions only — no Cloudflare imports, `now` passed in explicitly, state mutated in place (caller owns persistence).

- [ ] **Step 5.1: Write failing tests `test/heuristics.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { compileWatchlist, emptyState, processMessage, buildCalmSummary, diffCounters } from "../src/heuristics";
import type { RisUpdate, WatchlistEntry } from "../src/types";

const WL: WatchlistEntry[] = [
  { prefix: "1.1.1.0/24", expected_origins: [13335], label: "Cloudflare DNS" },
  { prefix: "17.0.0.0/8", expected_origins: [714], label: "Apple", aggregate: true },
  { prefix: "9.9.9.0/24", expected_origins: [19281], label: "Quad9", muted: true },
];

function msg(over: Partial<RisUpdate>): RisUpdate {
  return { timestamp: 0, peer: "192.0.2.1", peer_asn: "64500", host: "rrc00", type: "UPDATE", ...over };
}
function announce(prefix: string, path: (number | number[])[], peer = "192.0.2.1"): RisUpdate {
  return msg({ peer, path, announcements: [{ next_hop: "192.0.2.254", prefixes: [prefix] }] });
}
function withdraw(prefix: string, peer: string): RisUpdate {
  return msg({ peer, withdrawals: [prefix] });
}

describe("ORIGIN_CHANGE", () => {
  it("fires sev3 when origin differs, debounces repeats, allows expected origins", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    expect(processMessage(announce("1.1.1.0/24", [64500, 174, 13335]), wl, st, CONFIG, 1000)).toEqual([]);
    const evs = processMessage(announce("1.1.1.0/24", [64500, 174, 666]), wl, st, CONFIG, 2000);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: "ORIGIN_CHANGE", severity: 3, prefix: "1.1.1.0/24" });
    expect(evs[0].details.observedOrigin).toBe(666);
    // same rogue origin again within 30 min -> debounced
    expect(processMessage(announce("1.1.1.0/24", [64500, 174, 666]), wl, st, CONFIG, 3000)).toEqual([]);
    // a DIFFERENT rogue origin still fires
    expect(processMessage(announce("1.1.1.0/24", [64500, 174, 667]), wl, st, CONFIG, 4000)).toHaveLength(1);
    // after the debounce window the first origin fires again
    expect(processMessage(announce("1.1.1.0/24", [64500, 174, 666]), wl, st, CONFIG, 2000 + CONFIG.rules.originChangeDebounceMs)).toHaveLength(1);
  });
  it("flattens AS-sets in the path", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    const evs = processMessage(announce("1.1.1.0/24", [64500, [174, 666]]), wl, st, CONFIG, 1000);
    expect(evs[0]?.details.observedOrigin).toBe(666);
  });
});

describe("MORE_SPECIFIC", () => {
  it("sev3 when origin differs, sev2 when origin expected, suppressed for same-origin aggregates", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    // /25 inside watched /24, rogue origin -> sev3
    const rogue = processMessage(announce("1.1.1.0/25", [64500, 666]), wl, st, CONFIG, 1000);
    expect(rogue[0]).toMatchObject({ kind: "MORE_SPECIFIC", severity: 3 });
    // /25 from the expected origin -> sev2 (could be traffic engineering)
    const te = processMessage(announce("1.1.1.128/25", [64500, 13335]), wl, st, CONFIG, 2000);
    expect(te[0]).toMatchObject({ kind: "MORE_SPECIFIC", severity: 2 });
    // same-origin more-specific inside an aggregate entry -> no event
    expect(processMessage(announce("17.1.0.0/16", [64500, 714]), wl, st, CONFIG, 3000)).toEqual([]);
    // different-origin inside the aggregate still fires sev3
    expect(processMessage(announce("17.1.0.0/16", [64500, 666]), wl, st, CONFIG, 4000)).toHaveLength(1);
    // debounce per (announced prefix, origin)
    expect(processMessage(announce("1.1.1.0/25", [64500, 666]), wl, st, CONFIG, 5000)).toEqual([]);
  });
});

describe("WITHDRAWAL_STORM", () => {
  it("fires at >=10 distinct peers within 60s, not at 9, prunes stale peers", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    for (let i = 0; i < 9; i++) {
      expect(processMessage(withdraw("1.1.1.0/24", `10.0.0.${i}`), wl, st, CONFIG, 1000 + i)).toEqual([]);
    }
    const evs = processMessage(withdraw("1.1.1.0/24", "10.0.0.9"), wl, st, CONFIG, 1010);
    expect(evs[0]).toMatchObject({ kind: "WITHDRAWAL_STORM", severity: 3, prefix: "1.1.1.0/24" });
    expect(evs[0].details.distinctPeers).toBe(10);
    // repeats inside the 10-min debounce stay quiet
    expect(processMessage(withdraw("1.1.1.0/24", "10.0.0.10"), wl, st, CONFIG, 1020)).toEqual([]);
  });
  it("same peer repeating does not count as distinct", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    for (let i = 0; i < 20; i++) {
      expect(processMessage(withdraw("1.1.1.0/24", "10.0.0.1"), wl, st, CONFIG, 1000 + i)).toEqual([]);
    }
  });
});

describe("FLAP", () => {
  it("fires at 6 mixed transitions in 5 min; severity 2 at 12", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    let evs: ReturnType<typeof processMessage> = [];
    for (let i = 0; i < 6; i++) {
      const m = i % 2 === 0 ? announce("1.1.1.0/24", [64500, 13335]) : withdraw("1.1.1.0/24", "192.0.2.1");
      evs = processMessage(m, wl, st, CONFIG, 1000 + i * 1000);
    }
    expect(evs[0]).toMatchObject({ kind: "FLAP", severity: 1 });
  });
  it("does not fire for announcements only", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    for (let i = 0; i < 10; i++) {
      const evs = processMessage(announce("1.1.1.0/24", [64500, 13335]), wl, st, CONFIG, 1000 + i * 1000);
      expect(evs.filter((e) => e.kind === "FLAP")).toEqual([]);
    }
  });
});

describe("PATH_ANOMALY", () => {
  it("fires when path length >= 2.5x EWMA after the baseline settles", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    for (let i = 0; i < 25; i++) {
      processMessage(announce("1.1.1.0/24", [64500, 174, 13335]), wl, st, CONFIG, 1000 + i);
    }
    const longPath = [64500, 701, 396531, 396531, 396531, 396531, 174, 13335];
    const evs = processMessage(announce("1.1.1.0/24", longPath), wl, st, CONFIG, 50_000);
    expect(evs[0]).toMatchObject({ kind: "PATH_ANOMALY", severity: 1 });
  });
  it("does not fire before the EWMA has enough samples", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    const evs = processMessage(announce("1.1.1.0/24", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13335]), wl, st, CONFIG, 1000);
    expect(evs.filter((e) => e.kind === "PATH_ANOMALY")).toEqual([]);
  });
  it("fires on a non-consecutive repeated ASN regardless of length", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    const evs = processMessage(announce("1.1.1.0/24", [64500, 174, 64500, 13335]), wl, st, CONFIG, 1000);
    expect(evs[0]).toMatchObject({ kind: "PATH_ANOMALY" });
    expect(String(evs[0].details.reason)).toContain("64500");
  });
  it("consecutive prepends are NOT a repeat anomaly", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    const evs = processMessage(announce("1.1.1.0/24", [64500, 174, 174, 174, 13335]), wl, st, CONFIG, 1000);
    expect(evs.filter((e) => e.kind === "PATH_ANOMALY")).toEqual([]);
  });
});

describe("plumbing", () => {
  it("muted entries never produce events", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    expect(processMessage(announce("9.9.9.0/24", [64500, 666]), wl, st, CONFIG, 1000)).toEqual([]);
  });
  it("counts messages, announcements, withdrawals, collectors", () => {
    const wl = compileWatchlist(WL);
    const st = emptyState(0);
    processMessage(announce("1.1.1.0/24", [64500, 13335]), wl, st, CONFIG, 1000);
    processMessage(withdraw("8.8.8.0/24", "10.0.0.1"), wl, st, CONFIG, 2000);
    expect(st.counters).toMatchObject({ messages: 2, announcements: 1, withdrawals: 1 });
    expect(st.counters.perCollector.rrc00).toBe(2);
  });
  it("buildCalmSummary reports the busiest collector and diffCounters subtracts", () => {
    const st = emptyState(0);
    processMessage(announce("1.1.1.0/24", [64500, 13335]), compileWatchlist(WL), st, CONFIG, 1000);
    const snap = structuredClone(st.counters);
    processMessage(announce("1.1.1.0/24", [64500, 13335]), compileWatchlist(WL), st, CONFIG, 2000);
    const diff = diffCounters(st.counters, snap);
    expect(diff.messages).toBe(1);
    const ev = buildCalmSummary(diff, 3000);
    expect(ev).toMatchObject({ kind: "CALM_SUMMARY", severity: 1 });
    expect(ev.details.busiestCollector).toBe("rrc00");
  });
});
```

- [ ] **Step 5.2: Run to verify failure** — `npx vitest run test/heuristics.test.ts` → FAIL (module not found)

- [ ] **Step 5.3: Implement `src/heuristics.ts`**

```ts
// The detection engine. Pure functions: no Cloudflare imports, no IO, no Date.now() —
// the caller passes `now`, so every rule is unit-testable with plain vitest.
// State is mutated in place; the Watcher DO owns persisting it.

import type { Config } from "./config";
import { parsePrefix, isMoreSpecific, type ParsedPrefix } from "./prefix";
import type { Counters, HeuristicsState, NewEvent, PrefixState, RisUpdate, WatchlistEntry } from "./types";

export interface CompiledEntry { entry: WatchlistEntry; parsed: ParsedPrefix }

export function compileWatchlist(entries: WatchlistEntry[]): CompiledEntry[] {
  const out: CompiledEntry[] = [];
  for (const entry of entries) {
    if (entry.muted) continue;
    const parsed = parsePrefix(entry.prefix);
    if (parsed) out.push({ entry, parsed });
  }
  return out;
}

export function emptyCounters(now: number): Counters {
  return { messages: 0, announcements: 0, withdrawals: 0, perCollector: {}, eventsByKind: {}, since: now };
}

export function emptyState(now: number): HeuristicsState {
  return { prefixes: {}, counters: emptyCounters(now) };
}

function prefixState(state: HeuristicsState, key: string): PrefixState {
  let ps = state.prefixes[key];
  if (!ps) {
    ps = {
      originDebounce: {}, msDebounce: {}, ewmaPathLen: 0, ewmaSamples: 0,
      pathAnomalyDebounce: 0, flapEvents: [], flapDebounce: 0,
      withdrawalPeers: {}, stormDebounce: 0,
    };
    state.prefixes[key] = ps;
  }
  return ps;
}

// AS paths can contain nested arrays (AS-sets) — flatten to a simple number list.
export function flattenPath(path: (number | number[])[] | undefined): number[] {
  if (!path) return [];
  const out: number[] = [];
  for (const hop of path) {
    if (Array.isArray(hop)) out.push(...hop);
    else out.push(hop);
  }
  return out;
}

export function processMessage(
  msg: RisUpdate, watchlist: CompiledEntry[], state: HeuristicsState, cfg: Config, now: number,
): NewEvent[] {
  const events: NewEvent[] = [];
  const c = state.counters;
  c.messages++;
  if (msg.host) c.perCollector[msg.host] = (c.perCollector[msg.host] ?? 0) + 1;

  const path = flattenPath(msg.path);
  const origin = path.length > 0 ? path[path.length - 1] : undefined;

  for (const ann of msg.announcements ?? []) {
    for (const pfxStr of ann.prefixes) {
      c.announcements++;
      const pfx = parsePrefix(pfxStr);
      if (!pfx) continue; // IPv6 or malformed — out of scope for v1
      for (const w of watchlist) {
        if (pfx.base === w.parsed.base && pfx.len === w.parsed.len) {
          const ps = prefixState(state, w.entry.prefix);
          checkOriginChange(ps, w, origin, path, msg, cfg, now, events);
          recordFlap(ps, w, "A", cfg, now, events);
          checkPathAnomaly(ps, w, path, msg, cfg, now, events);
        } else if (isMoreSpecific(pfx, w.parsed)) {
          checkMoreSpecific(state, w, pfxStr, origin, path, msg, cfg, now, events);
        }
      }
    }
  }

  for (const pfxStr of msg.withdrawals ?? []) {
    c.withdrawals++;
    const pfx = parsePrefix(pfxStr);
    if (!pfx) continue;
    for (const w of watchlist) {
      if (pfx.base === w.parsed.base && pfx.len === w.parsed.len) {
        const ps = prefixState(state, w.entry.prefix);
        recordWithdrawal(ps, w, msg, cfg, now, events);
        recordFlap(ps, w, "W", cfg, now, events);
      }
    }
  }

  for (const e of events) c.eventsByKind[e.kind] = (c.eventsByKind[e.kind] ?? 0) + 1;
  return events;
}

// Rule 1: hijack detector — announcement whose origin AS isn't in the expected set.
function checkOriginChange(
  ps: PrefixState, w: CompiledEntry, origin: number | undefined, path: number[],
  msg: RisUpdate, cfg: Config, now: number, events: NewEvent[],
) {
  if (origin === undefined || w.entry.expected_origins.includes(origin)) return;
  const last = ps.originDebounce[String(origin)] ?? 0;
  if (now - last < cfg.rules.originChangeDebounceMs) return;
  ps.originDebounce[String(origin)] = now;
  events.push({
    ts: now, kind: "ORIGIN_CHANGE", severity: 3, prefix: w.entry.prefix, label: w.entry.label,
    details: {
      expectedOrigins: w.entry.expected_origins, observedOrigin: origin,
      asPath: path, peer: msg.peer, peerAsn: msg.peer_asn, collector: msg.host,
    },
  });
}

// Rule 2: a strictly more-specific announcement inside a watched prefix.
function checkMoreSpecific(
  state: HeuristicsState, w: CompiledEntry, announced: string, origin: number | undefined,
  path: number[], msg: RisUpdate, cfg: Config, now: number, events: NewEvent[],
) {
  const differs = origin === undefined || !w.entry.expected_origins.includes(origin);
  // Big aggregates (Apple's /8 etc.) legitimately announce same-origin more-specifics
  // all day — only a *different* origin inside them is interesting.
  if (w.entry.aggregate && !differs) return;
  const ps = prefixState(state, w.entry.prefix);
  const key = `${announced}|${origin}`;
  if (now - (ps.msDebounce[key] ?? 0) < cfg.rules.moreSpecificDebounceMs) return;
  ps.msDebounce[key] = now;
  events.push({
    ts: now, kind: "MORE_SPECIFIC", severity: differs ? 3 : 2, prefix: announced, label: w.entry.label,
    details: {
      announcedPrefix: announced, watchedPrefix: w.entry.prefix,
      observedOrigin: origin, expectedOrigins: w.entry.expected_origins,
      asPath: path, peer: msg.peer, peerAsn: msg.peer_asn, collector: msg.host,
    },
  });
}

// Rule 3: the "Facebook moment" — many distinct peers withdrawing within a minute.
function recordWithdrawal(
  ps: PrefixState, w: CompiledEntry, msg: RisUpdate, cfg: Config, now: number, events: NewEvent[],
) {
  ps.withdrawalPeers[msg.peer] = now;
  for (const [peer, ts] of Object.entries(ps.withdrawalPeers)) {
    if (now - ts > cfg.rules.stormWindowMs) delete ps.withdrawalPeers[peer];
  }
  const peers = Object.keys(ps.withdrawalPeers);
  if (peers.length < cfg.rules.stormPeerThreshold) return;
  if (now - ps.stormDebounce < cfg.rules.stormDebounceMs) return;
  ps.stormDebounce = now;
  events.push({
    ts: now, kind: "WITHDRAWAL_STORM", severity: 3, prefix: w.entry.prefix, label: w.entry.label,
    details: {
      distinctPeers: peers.length, windowSeconds: cfg.rules.stormWindowMs / 1000,
      collector: msg.host, samplePeers: peers.slice(0, 5),
    },
  });
}

// Rule 4: announce/withdraw churn on the same prefix.
function recordFlap(
  ps: PrefixState, w: CompiledEntry, t: "A" | "W", cfg: Config, now: number, events: NewEvent[],
) {
  ps.flapEvents.push({ ts: now, t });
  ps.flapEvents = ps.flapEvents.filter((e) => now - e.ts <= cfg.rules.flapWindowMs);
  const n = ps.flapEvents.length;
  const hasBoth = ps.flapEvents.some((e) => e.t === "A") && ps.flapEvents.some((e) => e.t === "W");
  if (n < cfg.rules.flapThreshold || !hasBoth) return;
  if (now - ps.flapDebounce < cfg.rules.flapDebounceMs) return;
  ps.flapDebounce = now;
  events.push({
    ts: now, kind: "FLAP", severity: n >= cfg.rules.flapBigThreshold ? 2 : 1,
    prefix: w.entry.prefix, label: w.entry.label,
    details: { transitions: n, windowMinutes: cfg.rules.flapWindowMs / 60_000 },
  });
}

// Rule 5: path looks weird — much longer than this prefix's usual path, or an ASN
// appears twice non-consecutively (consecutive repeats are just prepending).
function checkPathAnomaly(
  ps: PrefixState, w: CompiledEntry, path: number[], msg: RisUpdate,
  cfg: Config, now: number, events: NewEvent[],
) {
  if (path.length === 0) return;
  let reason: string | null = null;
  const lastIndex = new Map<number, number>();
  for (let i = 0; i < path.length; i++) {
    const prev = lastIndex.get(path[i]);
    if (prev !== undefined && prev !== i - 1) {
      reason = `AS${path[i]} appears non-consecutively in the path (possible loop or poisoning)`;
      break;
    }
    lastIndex.set(path[i], i);
  }
  if (!reason && ps.ewmaSamples >= cfg.rules.pathEwmaMinSamples && ps.ewmaPathLen > 0
      && path.length >= ps.ewmaPathLen * cfg.rules.pathLenRatio) {
    reason = `path length ${path.length} vs typical ~${ps.ewmaPathLen.toFixed(1)} hops`;
  }
  if (reason && now - ps.pathAnomalyDebounce >= cfg.rules.pathAnomalyDebounceMs) {
    ps.pathAnomalyDebounce = now;
    events.push({
      ts: now, kind: "PATH_ANOMALY", severity: 1, prefix: w.entry.prefix, label: w.entry.label,
      details: {
        reason, asPath: path, pathLength: path.length,
        typicalLength: ps.ewmaSamples >= cfg.rules.pathEwmaMinSamples ? +ps.ewmaPathLen.toFixed(1) : null,
        peer: msg.peer, collector: msg.host,
      },
    });
  }
  // Update the rolling average after judging, so today's anomaly doesn't excuse itself.
  ps.ewmaPathLen = ps.ewmaSamples === 0
    ? path.length
    : cfg.rules.pathEwmaAlpha * path.length + (1 - cfg.rules.pathEwmaAlpha) * ps.ewmaPathLen;
  ps.ewmaSamples++;
}

// Rule 6 helper: counters diff for "what happened this hour" (cron decides when to call).
export function diffCounters(current: Counters, snapshot: Counters): Counters {
  const perCollector: Record<string, number> = {};
  for (const [k, v] of Object.entries(current.perCollector)) {
    const d = v - (snapshot.perCollector[k] ?? 0);
    if (d > 0) perCollector[k] = d;
  }
  return {
    messages: current.messages - snapshot.messages,
    announcements: current.announcements - snapshot.announcements,
    withdrawals: current.withdrawals - snapshot.withdrawals,
    perCollector,
    eventsByKind: {},
    since: snapshot.since,
  };
}

export function buildCalmSummary(hourly: Counters, now: number): NewEvent {
  const busiest = Object.entries(hourly.perCollector).sort((a, b) => b[1] - a[1])[0];
  return {
    ts: now, kind: "CALM_SUMMARY", severity: 1,
    details: {
      messages: hourly.messages,
      announcements: hourly.announcements,
      withdrawals: hourly.withdrawals,
      busiestCollector: busiest?.[0] ?? "n/a",
      busiestCollectorMsgs: busiest?.[1] ?? 0,
    },
  };
}

// Housekeeping: debounce maps grow forever without this. Called by the Watcher
// before each persist. Drops entries older than their own debounce windows.
export function pruneState(state: HeuristicsState, cfg: Config, now: number): void {
  for (const ps of Object.values(state.prefixes)) {
    for (const [k, ts] of Object.entries(ps.originDebounce)) {
      if (now - ts > cfg.rules.originChangeDebounceMs) delete ps.originDebounce[k];
    }
    for (const [k, ts] of Object.entries(ps.msDebounce)) {
      if (now - ts > cfg.rules.moreSpecificDebounceMs) delete ps.msDebounce[k];
    }
    for (const [k, ts] of Object.entries(ps.withdrawalPeers)) {
      if (now - ts > cfg.rules.stormWindowMs) delete ps.withdrawalPeers[k];
    }
    ps.flapEvents = ps.flapEvents.filter((e) => now - e.ts <= cfg.rules.flapWindowMs);
  }
}
```

- [ ] **Step 5.4: Run to verify pass** — `npx vitest run test/heuristics.test.ts` → PASS (all describe blocks)
- [ ] **Step 5.5: Commit** — `git commit -m "feat: heuristics engine — 5 stream rules + calm summary, pure functions"`

### Task 6: Narrator (TDD on budget + templates; live API call)

**Files:**
- Create: `src/narrator.ts`
- Test: `test/narrator.test.ts`

**Before writing the Anthropic call: invoke the `claude-api` skill** to confirm Messages API request shape and the current Sonnet model id.

- [ ] **Step 6.1: Write failing tests `test/narrator.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { NarrationBudget, templateFor, narrate } from "../src/narrator";
import type { NewEvent } from "../src/types";

function ev(kind: NewEvent["kind"], severity: 1 | 2 | 3, details: Record<string, unknown> = {}): NewEvent {
  return { ts: 0, kind, severity, prefix: "1.1.1.0/24", label: "Cloudflare DNS", details };
}

describe("NarrationBudget", () => {
  it("allows 8 non-sev3 per hour, then only sev3 up to 12 total", () => {
    const b = new NarrationBudget();
    for (let i = 0; i < 8; i++) {
      expect(b.canNarrate(2, "FLAP", i)).toBe(true);
      b.record(2, "FLAP", i);
    }
    expect(b.canNarrate(2, "FLAP", 100)).toBe(false);   // non-sev3 cap hit
    for (let i = 0; i < 4; i++) {
      expect(b.canNarrate(3, "ORIGIN_CHANGE", 200 + i)).toBe(true);  // sev3 jumps the queue
      b.record(3, "ORIGIN_CHANGE", 200 + i);
    }
    expect(b.canNarrate(3, "ORIGIN_CHANGE", 300)).toBe(false);  // total cap 12 hit
  });
  it("window slides: old narrations expire after an hour", () => {
    const b = new NarrationBudget();
    for (let i = 0; i < 12; i++) b.record(3, "ORIGIN_CHANGE", i);
    expect(b.canNarrate(3, "ORIGIN_CHANGE", 1000)).toBe(false);
    expect(b.canNarrate(3, "ORIGIN_CHANGE", 3_600_001 + 11)).toBe(true);
  });
  it("calm summaries have their own 1/hour cap", () => {
    const b = new NarrationBudget();
    expect(b.canNarrate(1, "CALM_SUMMARY", 0)).toBe(true);
    b.record(1, "CALM_SUMMARY", 0);
    expect(b.canNarrate(1, "CALM_SUMMARY", 1000)).toBe(false);
    expect(b.canNarrate(1, "CALM_SUMMARY", 3_600_001)).toBe(true);
  });
  it("round-trips through JSON for DO persistence", () => {
    const b = new NarrationBudget();
    b.record(3, "ORIGIN_CHANGE", 5);
    const restored = NarrationBudget.fromJSON(b.toJSON());
    expect(restored.canNarrate(1, "CALM_SUMMARY", 6)).toBe(true);
    expect(restored.toJSON()).toEqual(b.toJSON());
  });
});

describe("templateFor", () => {
  it("origin change template names prefix, label and ASNs", () => {
    const t = templateFor(ev("ORIGIN_CHANGE", 3, { expectedOrigins: [13335], observedOrigin: 666 }));
    expect(t).toContain("1.1.1.0/24");
    expect(t).toContain("Cloudflare DNS");
    expect(t).toContain("AS13335");
    expect(t).toContain("AS666");
  });
  it("has a non-empty template for every kind", () => {
    for (const kind of ["ORIGIN_CHANGE", "MORE_SPECIFIC", "WITHDRAWAL_STORM", "FLAP", "PATH_ANOMALY", "CALM_SUMMARY", "REPLAY"] as const) {
      expect(templateFor(ev(kind, 1)).length).toBeGreaterThan(10);
    }
  });
});

describe("narrate", () => {
  it("falls back to template when narration is disabled", async () => {
    const b = new NarrationBudget();
    const r = await narrate(ev("ORIGIN_CHANGE", 3, { observedOrigin: 666, expectedOrigins: [13335] }),
      { apiKey: "k", enabled: false, budget: b, now: 0, fetchImpl: () => { throw new Error("must not fetch"); } });
    expect(r.narrated).toBe(false);
  });
  it("falls back when there is no API key", async () => {
    const r = await narrate(ev("FLAP", 1), { apiKey: undefined, enabled: true, budget: new NarrationBudget(), now: 0 });
    expect(r.narrated).toBe(false);
    expect(r.text.length).toBeGreaterThan(10);
  });
  it("falls back on API failure and does not consume budget", async () => {
    const b = new NarrationBudget();
    const r = await narrate(ev("ORIGIN_CHANGE", 3), {
      apiKey: "k", enabled: true, budget: b, now: 0,
      fetchImpl: async () => new Response("overloaded", { status: 529 }),
    });
    expect(r.narrated).toBe(false);
    expect(b.canNarrate(2, "FLAP", 0)).toBe(true); // nothing recorded
  });
  it("returns AI text on success and records budget", async () => {
    const b = new NarrationBudget();
    const r = await narrate(ev("ORIGIN_CHANGE", 3), {
      apiKey: "k", enabled: true, budget: b, now: 0,
      fetchImpl: async () => Response.json({ content: [{ type: "text", text: "Blustery out there on the routing table." }] }),
    });
    expect(r).toEqual({ text: "Blustery out there on the routing table.", narrated: true });
  });
});
```

- [ ] **Step 6.2: Verify failure**, then implement `src/narrator.ts`

```ts
// AI commentary with hard cost caps. Detection never depends on this module
// succeeding: every path that can fail returns a template string instead.
// Pure-ish: fetch is injectable so tests never hit the network.

import { CONFIG } from "./config";
import type { BgpEvent, EventKind, NewEvent, Severity } from "./types";

const HOUR = 3_600_000;

// Sliding-window budget. Non-sev3 events get 8/hour; severity 3 can spend the
// full 12 ("jumps the queue"). Calm summaries have a separate 1/hour cap.
export class NarrationBudget {
  private stamps: { ts: number; sev: Severity }[] = [];
  private calmStamps: number[] = [];

  canNarrate(sev: Severity, kind: EventKind, now: number): boolean {
    this.prune(now);
    if (kind === "CALM_SUMMARY") return this.calmStamps.length < CONFIG.narration.calmMaxPerHour;
    if (this.stamps.length >= CONFIG.narration.maxPerHour) return false;
    if (sev < 3) {
      const nonSev3 = this.stamps.filter((s) => s.sev < 3).length;
      if (nonSev3 >= CONFIG.narration.maxNonSev3PerHour) return false;
    }
    return true;
  }

  record(sev: Severity, kind: EventKind, now: number): void {
    if (kind === "CALM_SUMMARY") this.calmStamps.push(now);
    else this.stamps.push({ ts: now, sev });
  }

  remaining(now: number): number {
    this.prune(now);
    return Math.max(0, CONFIG.narration.maxPerHour - this.stamps.length);
  }

  private prune(now: number): void {
    this.stamps = this.stamps.filter((s) => now - s.ts < HOUR);
    this.calmStamps = this.calmStamps.filter((ts) => now - ts < HOUR);
  }

  toJSON(): { stamps: { ts: number; sev: Severity }[]; calm: number[] } {
    return { stamps: this.stamps, calm: this.calmStamps };
  }
  static fromJSON(j?: { stamps: { ts: number; sev: Severity }[]; calm: number[] } | null): NarrationBudget {
    const b = new NarrationBudget();
    if (j) { b.stamps = j.stamps ?? []; b.calmStamps = j.calm ?? []; }
    return b;
  }
}

// Template fallbacks — used when narration is disabled, capped, or the API fails.
export function templateFor(ev: NewEvent | BgpEvent): string {
  const d = ev.details as Record<string, unknown>;
  const where = ev.prefix ? `${ev.prefix}${ev.label ? ` (${ev.label})` : ""}` : "";
  switch (ev.kind) {
    case "ORIGIN_CHANGE":
      return `Origin change detected on ${where}: expected AS${(d.expectedOrigins as number[] | undefined)?.join("/AS") ?? "?"}, now seeing AS${d.observedOrigin}. Detected — unconfirmed.`;
    case "MORE_SPECIFIC":
      return `More-specific prefix ${d.announcedPrefix} announced inside watched ${d.watchedPrefix}${ev.label ? ` (${ev.label})` : ""} by AS${d.observedOrigin}. Could be traffic engineering; could be mischief. Detected — unconfirmed.`;
    case "WITHDRAWAL_STORM":
      return `Withdrawal storm on ${where}: ${d.distinctPeers} peers withdrew the route within ${d.windowSeconds}s. The prefix may be dropping off the internet.`;
    case "FLAP":
      return `Route flapping on ${where}: ${d.transitions} announce/withdraw transitions in ${d.windowMinutes} minutes.`;
    case "PATH_ANOMALY":
      return `Path anomaly on ${where}: ${d.reason ?? "unusual AS path"}.`;
    case "CALM_SUMMARY":
      return `All quiet on the routing front. ${d.messages ?? 0} BGP updates this hour (${d.announcements ?? 0} announcements, ${d.withdrawals ?? 0} withdrawals); busiest collector ${d.busiestCollector ?? "n/a"}.`;
    case "REPLAY":
      return `Replay (${d.incident ?? "historical incident"}): ${d.originalKind ?? "event"} on ${where}. Historical reconstruction — not live data.`;
    default:
      return `BGP event on ${where}.`;
  }
}

const SYSTEM_PROMPT = `You are the presenter of the "BGP Weather Channel", narrating live events on the global internet routing system. Voice: BBC weather presenter crossed with a senior network engineer — dry, precise, lightly witty, never alarmist, never tabloid.

Rules:
- 2 to 4 sentences, plain text only. No markdown, no emoji, no headers.
- Be technically accurate. ASNs are "AS13335", prefixes like "1.1.1.0/24".
- Always hedge on cause: say what it MIGHT be (a leak, a hijack, a maintenance window going sideways, a typo in a router config) — you observe symptoms, you do not attribute blame.
- Severity 3 events are serious weather; severity 1 is a passing shower. Match your tone.
- If the event is a REPLAY, note clearly it is a reconstruction of a historical incident, then narrate it with relish.
- For CALM_SUMMARY events, do gentle colour commentary on a quiet hour using the counters provided.`;

const GLOSSARY: Record<string, string> = {
  ORIGIN_CHANGE: "ORIGIN_CHANGE: a watched prefix was announced by an origin AS that is not its expected owner — the classic signature of a hijack or fat-finger.",
  MORE_SPECIFIC: "MORE_SPECIFIC: someone announced a smaller, more-specific prefix inside a watched block — more-specifics win routing, so this redirects traffic. Can be legitimate traffic engineering.",
  WITHDRAWAL_STORM: "WITHDRAWAL_STORM: many BGP peers withdrew the route within a minute — the prefix is vanishing from the global routing table (like Facebook, October 2021).",
  FLAP: "FLAP: the route was announced and withdrawn repeatedly in minutes — unstable, often a struggling router or circuit.",
  PATH_ANOMALY: "PATH_ANOMALY: the AS path looks unusual — much longer than normal (heavy prepending or a leak) or containing a non-consecutive repeated ASN.",
  CALM_SUMMARY: "CALM_SUMMARY: nothing notable happened in the past hour; these are aggregate statistics for colour commentary.",
  REPLAY: "REPLAY: a re-run of a famous historical routing incident from a reconstructed fixture, at accelerated speed, for demonstration.",
};

export interface NarrateOptions {
  apiKey: string | undefined;
  enabled: boolean;
  budget: NarrationBudget;
  now: number;
  fetchImpl?: typeof fetch;  // injectable for tests
}

export async function narrate(ev: NewEvent | BgpEvent, opts: NarrateOptions): Promise<{ text: string; narrated: boolean }> {
  const fallback = { text: templateFor(ev), narrated: false };
  if (!opts.enabled || !opts.apiKey) return fallback;
  if (!opts.budget.canNarrate(ev.severity, ev.kind, opts.now)) return fallback;

  const glossaryKind = ev.kind === "REPLAY" ? String((ev.details as Record<string, unknown>).originalKind ?? "REPLAY") : ev.kind;
  const userMessage =
    `${GLOSSARY[ev.kind] ?? ""}\n${ev.kind === "REPLAY" ? GLOSSARY[glossaryKind] ?? "" : ""}\n` +
    `Event:\n${JSON.stringify({ kind: ev.kind, severity: ev.severity, prefix: ev.prefix, label: ev.label, details: ev.details }, null, 2)}`;

  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const resp = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CONFIG.narration.model,
        max_tokens: CONFIG.narration.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!resp.ok) {
      console.log(`narration API error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return fallback;
    }
    const json = (await resp.json()) as { content?: { type: string; text?: string }[] };
    const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    if (!text) return fallback;
    opts.budget.record(ev.severity, ev.kind, opts.now);  // only count successful narrations
    return { text, narrated: true };
  } catch (err) {
    console.log("narration failed:", err);
    return fallback;
  }
}
```

- [ ] **Step 6.3: Run full test suite** — `npx vitest run` → all PASS
- [ ] **Step 6.4: Commit** — `git commit -m "feat: narrator with hard caps, persona prompt, template fallbacks"`

### Task 7: Watcher Durable Object + Worker entry

**Files:**
- Create: `src/watcher.ts`, `src/index.ts`
- Create (placeholder fixtures so imports resolve; real ones in Task 10): `fixtures/facebook-2021.json`, `fixtures/youtube-2008.json`, `fixtures/prepend-leak-2019.json` — generate with `node scripts/make-fixtures.mjs` (Task 10 script; write it now, it has no dependencies).

Note: write the fixture generator (Task 10 Step 10.1) BEFORE this task's typecheck, or stub three minimal valid fixture JSONs.

- [ ] **Step 7.1: Implement `src/watcher.ts`**

```ts
// The heart of the system: a single Durable Object that
//   1. holds the outbound WebSocket to RIS Live (this is why a DO and not a
//      plain Worker — Workers are stateless and die between requests),
//   2. runs every message through the heuristics engine,
//   3. writes events to D1 and fans them out to dashboard browsers,
//   4. runs replays through the same pipeline with isolated state.
// Holding the outbound socket keeps the DO awake — that's the accepted cost.

import { DurableObject } from "cloudflare:workers";
import { CONFIG } from "./config";
import {
  buildCalmSummary, compileWatchlist, diffCounters, emptyCounters, emptyState,
  processMessage, pruneState,
} from "./heuristics";
import { NarrationBudget, narrate, templateFor } from "./narrator";
import { rowToEvent, ulid } from "./util";
import type { BgpEvent, Counters, Env, Fixture, HeuristicsState, NewEvent, RisUpdate, WatchlistEntry } from "./types";
import watchlistJson from "../watchlist.json";
import facebook2021 from "../fixtures/facebook-2021.json";
import youtube2008 from "../fixtures/youtube-2008.json";
import prependLeak2019 from "../fixtures/prepend-leak-2019.json";

const FIXTURES: Record<string, Fixture> = {
  "facebook-2021": facebook2021 as unknown as Fixture,
  "youtube-2008": youtube2008 as unknown as Fixture,
  "prepend-leak-2019": prependLeak2019 as unknown as Fixture,
};

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
  private replayActive: string | null = null;
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
      this.budget = NarrationBudget.fromJSON(await ctx.storage.get("budget"));
      // The alarm is our belt-and-braces heartbeat: persist + reconnect check.
      await ctx.storage.setAlarm(Date.now() + CONFIG.persistIntervalMs);
    });
    this.ensureTimers();
    void this.ensureConnected();
  }

  // ---- HTTP entry points (reached via the Worker) -------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.handleWsUpgrade(request);
    if (url.pathname === "/status") return Response.json(this.statusBody());
    if (url.pathname === "/cron/calm") {
      await this.maybeCalmSummary();
      return new Response("ok");
    }
    if (url.pathname.startsWith("/replay/") && request.method === "POST") {
      return this.startReplay(url.pathname.split("/")[2] ?? "");
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.persist();
    this.ensureTimers();
    void this.ensureConnected();
    await this.ctx.storage.setAlarm(Date.now() + CONFIG.persistIntervalMs);
  }

  // ---- dashboard WebSockets ----------------------------------------------

  private async handleWsUpgrade(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    // Hibernation-aware accept (good practice even though the outbound RIS
    // socket keeps this DO awake anyway).
    this.ctx.acceptWebSocket(pair[1]);
    try {
      const rows = await this.env.DB
        .prepare("SELECT * FROM events ORDER BY ts DESC LIMIT 50").all();
      pair[1].send(JSON.stringify({ type: "history", events: rows.results.map(rowToEvent) }));
    } catch (err) {
      console.log("history query failed:", err);
      pair[1].send(JSON.stringify({ type: "history", events: [] }));
    }
    pair[1].send(JSON.stringify({ type: "stats", stats: this.statsBody() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (message === "ping") ws.send("pong");  // simple client keepalive
  }
  async webSocketClose(): Promise<void> { /* getWebSockets() drops it automatically */ }

  private broadcast(obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* client gone; close handler cleans up */ }
    }
  }

  // ---- RIS Live upstream connection ----------------------------------------

  private async ensureConnected(): Promise<void> {
    if (this.connecting) return;
    const silent = this.lastMsgTs > 0 && Date.now() - this.lastMsgTs > CONFIG.ris.silenceTimeoutMs;
    if (this.risWs && !silent) return;  // looks healthy
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
      this.backoffMs = CONFIG.ris.backoffInitialMs;  // reset backoff on success
      for (const w of this.compiled) {
        ws.send(JSON.stringify({ type: "ris_subscribe", data: { prefix: w.entry.prefix, moreSpecific: true, type: "UPDATE" } }));
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
    if (this.reconnectPending) return;  // close+error can both fire — only queue one
    this.reconnectPending = true;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, CONFIG.ris.backoffMaxMs);
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
    } catch { return; }
    if (parsed.type !== "ris_message" || !parsed.data) return;
    // Keep per-message work tiny (DO CPU limits): pure heuristics + counters.
    const events = processMessage(parsed.data, this.compiled, this.state, CONFIG, Date.now());
    this.dirty = true;
    for (const ev of events) void this.publishEvent(ev, false);
  }

  // ---- event publication ----------------------------------------------------

  private async publishEvent(ev: NewEvent, replay: boolean): Promise<void> {
    const event: BgpEvent = { ...ev, id: ulid(), commentary: templateFor(ev), narrated: false, replay };
    try {
      await this.env.DB.prepare(
        "INSERT INTO events (id, ts, kind, severity, prefix, label, details, commentary, narrated, replay) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        event.id, event.ts, event.kind, event.severity, event.prefix ?? null, event.label ?? null,
        JSON.stringify(event.details), event.commentary, 0, replay ? 1 : 0,
      ).run();
    } catch (err) {
      console.log("D1 insert failed:", err);
    }
    // Broadcast immediately with the template; AI text replaces it when ready.
    this.broadcast({ type: "event", event });
    const result = await narrate(event, {
      apiKey: this.env.ANTHROPIC_API_KEY,
      enabled: this.env.NARRATION_ENABLED !== "false",
      budget: this.budget,
      now: Date.now(),
    });
    if (result.narrated) {
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

  // ---- calm summary (hourly cron) -------------------------------------------

  private async maybeCalmSummary(): Promise<void> {
    const now = Date.now();
    const hourly = diffCounters(this.state.counters, this.hourlySnapshot);
    // Snapshot first so the next hour diffs from here even if we emit nothing.
    this.hourlySnapshot = structuredClone(this.state.counters);
    await this.ctx.storage.put("hourlySnapshot", this.hourlySnapshot);
    try {
      const row = await this.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE ts > ? AND severity >= 2 AND replay = 0",
      ).bind(now - 3_600_000).first<{ n: number }>();
      if ((row?.n ?? 0) > 0) return;  // not a calm hour — no summary
    } catch (err) {
      console.log("calm summary query failed:", err);
      return;
    }
    if (hourly.messages === 0 && !this.risWs) return;  // nothing to talk about and we're offline
    await this.publishEvent(buildCalmSummary(hourly, now), false);
  }

  // ---- replay ----------------------------------------------------------------

  private startReplay(name: string): Response {
    const fixture = FIXTURES[name];
    if (!fixture) return Response.json({ error: "unknown incident", available: Object.keys(FIXTURES) }, { status: 404 });
    if (this.replayActive) return Response.json({ error: `replay already running: ${this.replayActive}` }, { status: 409 });
    this.replayActive = name;
    void this.runReplay(fixture)
      .catch((err) => console.log("replay failed:", err))
      .finally(() => { this.replayActive = null; });
    return Response.json({ started: name, title: fixture.title, messages: fixture.messages.length });
  }

  private async runReplay(fixture: Fixture): Promise<void> {
    // Replays use their OWN state + watchlist so they never pollute live
    // baselines, debounces, or the ticker counters.
    const compiled = compileWatchlist(fixture.watchlist);
    const state = emptyState(Date.now());
    const speed = fixture.speed || CONFIG.replay.defaultSpeed;
    this.broadcast({ type: "replay", status: "started", incident: fixture.name, title: fixture.title, description: fixture.description, disclaimer: fixture.disclaimer });
    let prevDt = 0;
    for (const m of fixture.messages) {
      const wait = Math.min(Math.max(0, m.dt - prevDt) / speed, CONFIG.replay.maxWaitMs);
      prevDt = m.dt;
      if (wait > 5) await new Promise((r) => setTimeout(r, wait));
      const events = processMessage(m.data, compiled, state, CONFIG, Date.now());
      for (const ev of events) {
        // Spec §8: replay events are wrapped in kind REPLAY so nobody panics.
        const wrapped: NewEvent = {
          ...ev, kind: "REPLAY",
          details: { ...ev.details, originalKind: ev.kind, incident: fixture.name, reconstruction: true },
        };
        await this.publishEvent(wrapped, true);
      }
    }
    this.broadcast({ type: "replay", status: "finished", incident: fixture.name });
  }

  // ---- stats, status, timers, persistence -------------------------------------

  private ensureTimers(): void {
    if (this.timersStarted) return;
    this.timersStarted = true;
    // The outbound RIS socket keeps the DO alive, so plain intervals are fine.
    // If the DO is ever evicted, the constructor + alarm rebuild everything.
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
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([host, msgs]) => ({ host, msgs }));
    return {
      connected: !!this.risWs,
      msgsPerSec: this.msgsPerSec,
      totalMessages: this.state.counters.messages,
      announcements: this.state.counters.announcements,
      withdrawals: this.state.counters.withdrawals,
      topCollectors: top,
      clients: this.ctx.getWebSockets().length,
      replayActive: this.replayActive,
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
    pruneState(this.state, CONFIG, Date.now());
    await this.ctx.storage.put("heuristics", this.state);
    await this.ctx.storage.put("budget", this.budget.toJSON());
  }
}
```

- [ ] **Step 7.2: Create `src/util.ts` addition** — add `rowToEvent` to the existing util file:

```ts
import type { BgpEvent } from "./types";

// D1 returns flat rows; rebuild the BgpEvent shape (details is stored as JSON text).
export function rowToEvent(row: Record<string, unknown>): BgpEvent {
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(String(row.details ?? "{}")); } catch { /* keep {} */ }
  return {
    id: String(row.id), ts: Number(row.ts),
    kind: row.kind as BgpEvent["kind"], severity: Number(row.severity) as BgpEvent["severity"],
    prefix: row.prefix == null ? undefined : String(row.prefix),
    label: row.label == null ? undefined : String(row.label),
    details, commentary: String(row.commentary ?? ""),
    narrated: Number(row.narrated) === 1, replay: Number(row.replay) === 1,
  };
}
```

- [ ] **Step 7.3: Implement `src/index.ts`**

```ts
// Worker entry: static assets are served automatically for files in public/;
// everything else lands here and is routed to the single Watcher DO, D1, or
// the cron handlers.

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
        narration: { maxPerHour: CONFIG.narration.maxPerHour, calmMaxPerHour: CONFIG.narration.calmMaxPerHour, model: CONFIG.narration.model },
        watchlist: watchlistJson,
      });
    }

    if (url.pathname.startsWith("/replay/") && request.method === "POST") {
      return watcherStub(env).fetch(new Request(`https://do${url.pathname}`, { method: "POST" }));
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
        ctx.waitUntil(watcherStub(env).fetch("https://do/cron/calm", { method: "POST" }));
        break;
      case "30 3 * * *":
        ctx.waitUntil(
          env.DB.prepare("DELETE FROM events WHERE ts < ?")
            .bind(Date.now() - CONFIG.retentionDays * 86_400_000).run(),
        );
        break;
    }
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 7.4: Typecheck + tests** — `npx tsc --noEmit` and `npx vitest run` → both clean. (Requires the three fixture JSONs to exist — run Task 10 Step 10.1's generator first.)
- [ ] **Step 7.5: Commit** — `git commit -m "feat: Watcher DO (RIS client, fan-out, replay) + Worker routing/cron"`

### Task 8: Deploy phases 1–3 (stream + detection + narration plumbing)

- [ ] **Step 8.1: Create the D1 database** (loads .env first — required for every wrangler call):

```powershell
Get-Content .env | ForEach-Object { if ($_ -match '^(\w+)=(.+)$') { Set-Item "env:$($Matches[1])" $Matches[2] } }
npx wrangler d1 create bgp-weather
```
Expected output includes `database_id = "<uuid>"`. **Paste that uuid into `wrangler.toml`** replacing `FILLED-IN-TASK-8`.

- [ ] **Step 8.2: Apply the migration remotely**

```powershell
npx wrangler d1 migrations apply bgp-weather --remote
```
Expected: `0001_init.sql` applied.

- [ ] **Step 8.3: Deploy**

```powershell
npx wrangler deploy
```
Expected: deploys worker `bgp-weather` with DO + D1 bindings, 3 cron triggers, and the custom domain `bgpweather.clydeford.net`. If the custom-domain step fails (zone missing from this account / token lacks zone scope): remove the `routes` block, redeploy to `*.workers.dev`, and report the domain issue to the owner at the end.

- [ ] **Step 8.4: Verify the stream is live**

```powershell
Invoke-RestMethod https://bgpweather.clydeford.net/api/status
```
Expected: `connected: true`, `subscriptions: 36`, `totalMessages` increasing between calls (run twice ~30s apart). Also check `/api/events` returns JSON (may be `[]` on a calm day).

- [ ] **Step 8.5: Soak check** — re-check `/api/status` after 10+ minutes of other work (Task 9): `connected` still true, `lastMessageAgoMs` < 90000, totals grown. This stands in for the spec's overnight soak; the cron watchdog covers eviction.

- [ ] **Step 8.6: Commit** — `git commit -m "chore: wire real D1 database id"`

### Task 9: Dashboard (Phase 4)

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/style.css`
- Delete: `public/.gitkeep`

**REQUIRED SUB-SKILL: invoke `frontend-design:frontend-design` before writing these files.** Design direction: dark "broadcast weather studio" aesthetic — near-black background, monospace accents for prefixes/ASNs, severity glow (blue/amber/red), subtle slide-in animation for new event cards, live ticker strip. This is a show-off project; it must look professional, not like a default admin template.

Functional contract (the design skill governs look, this governs behavior):

1. **Conditions banner**: derived client-side from non-replay events in the last 60 min: any sev3 in last 30 min → "Stormy"; else any sev2 in last 60 min → "Unsettled"; else "Calm". Show latest CALM_SUMMARY commentary text when calm.
2. **Live ticker**: msgs/sec, total updates, announcements vs withdrawals, top collectors, connection dot (green = `stats.connected`), client count. Updates on every `stats` message (~2s).
3. **Event feed**: newest first, cap DOM at 100 cards. Card = severity colour bar/glow (1=blue `#4da3ff`, 2=amber `#ffb547`, 3=red `#ff4d5e`), kind badge (for REPLAY show `details.originalKind` + a distinct purple REPLAY tag), prefix + label, local time, commentary text (italic/quote style when `narrated`, plain when template), `<details>` expandable raw JSON. Sev3 cards show "detected — unconfirmed" wording (the templates/AI already include it; keep a small badge too).
4. **Replay control**: `<select>` with the three incidents (facebook-2021 "Facebook outage, Oct 2021", youtube-2008 "YouTube hijack, Feb 2008", prepend-leak-2019 "Route-optimizer leak, Jun 2019") + Run button → `fetch("/replay/"+name, {method:"POST"})`; disable while a `replay started` message is active; show the fixture `disclaimer` ("hand-authored reconstruction") in the UI.
5. **WS client**: connect to `(wss|ws)://host/ws`; handle `{type:history}`, `{type:event}`, `{type:commentary}` (replace card text by id), `{type:stats}`, `{type:replay}`; reconnect with 1s→30s doubling backoff; send `"ping"` every 25s.

- [ ] **Step 9.1: Invoke frontend-design skill, then write the three files** implementing the contract above.
- [ ] **Step 9.2: Local smoke test** — `npx wrangler dev` + fetch `http://localhost:8787/` and confirm HTML serves; open and check WS connects (status shows in page). Ctrl-C after.
- [ ] **Step 9.3: Deploy + verify** — `npx wrangler deploy`; load https://bgpweather.clydeford.net in a check (curl the HTML, confirm `/ws` upgrade works via status `clients` count after opening — or verify via `npx wrangler tail` briefly).
- [ ] **Step 9.4: Commit** — `git commit -m "feat: live dashboard — conditions banner, ticker, event feed, replay UI"`

### Task 10: Replay fixtures (Phase 5)

**Files:**
- Create: `scripts/make-fixtures.mjs`, `fixtures/facebook-2021.json`, `fixtures/youtube-2008.json`, `fixtures/prepend-leak-2019.json`
- Test: `test/fixtures.test.ts`

- [ ] **Step 10.1: Write `scripts/make-fixtures.mjs`** — generates the three fixtures with loops (hand-authoring 100+ messages inline would be unreadable):

```js
// Generates the three replay fixtures. These are HAND-AUTHORED RECONSTRUCTIONS
// of famous incidents — message-level details are invented to match the shape
// of what RIS would have shown, not copies of real captures.
import { mkdirSync, writeFileSync } from "node:fs";

const PEERS = Array.from({ length: 16 }, (_, i) => ({
  peer: `192.0.2.${i + 1}`, peer_asn: String(64500 + i), host: `rrc${String(i % 11).padStart(2, "0")}`,
}));

function msg(dt, peerIdx, data) {
  const p = PEERS[peerIdx % PEERS.length];
  return { dt, data: { timestamp: dt / 1000, type: "UPDATE", ...p, ...data } };
}
function ann(dt, peerIdx, prefixes, path) {
  return msg(dt, peerIdx, { path, announcements: [{ next_hop: "192.0.2.254", prefixes }] });
}
function wd(dt, peerIdx, prefixes) {
  return msg(dt, peerIdx, { withdrawals: prefixes });
}

// --- (a) Facebook, October 2021: BGP withdrawals took facebook.com's DNS off the internet.
const fb = {
  name: "facebook-2021",
  title: "Facebook outage — October 2021",
  description: "Facebook's backbone maintenance went wrong and BGP withdrew the routes to its authoritative DNS, taking facebook.com, Instagram and WhatsApp offline for six hours.",
  disclaimer: "Hand-authored reconstruction — timings and peers are illustrative, not a real capture.",
  speed: 20,
  watchlist: [
    { prefix: "129.134.30.0/24", expected_origins: [32934], label: "Facebook DNS (a.ns)" },
    { prefix: "129.134.31.0/24", expected_origins: [32934], label: "Facebook DNS (b.ns)" },
  ],
  messages: [],
};
// A quiet morning: normal announcements establish the picture.
for (let i = 0; i < 6; i++) {
  fb.messages.push(ann(i * 5000, i, ["129.134.30.0/24"], [64500 + i, 3356, 32934]));
  fb.messages.push(ann(i * 5000 + 1000, i, ["129.134.31.0/24"], [64500 + i, 174, 32934]));
}
// 15:39 UTC: the withdrawals sweep across every peer in under a minute.
for (let i = 0; i < 16; i++) {
  fb.messages.push(wd(60_000 + i * 2500, i, ["129.134.30.0/24"]));
  fb.messages.push(wd(61_000 + i * 2500, i, ["129.134.31.0/24"]));
}
// Hours later (compressed): routes return.
for (let i = 0; i < 6; i++) {
  fb.messages.push(ann(150_000 + i * 4000, i, ["129.134.30.0/24", "129.134.31.0/24"], [64500 + i, 3356, 32934]));
}

// --- (b) YouTube, February 2008: Pakistan Telecom announces a more-specific /24.
const yt = {
  name: "youtube-2008",
  title: "YouTube hijack — February 2008",
  description: "Pakistan Telecom (AS17557) announced 208.65.153.0/24 — a more-specific of YouTube's /22 — intended as a domestic block, leaked worldwide via AS3491, and took YouTube offline for most of the internet.",
  disclaimer: "Hand-authored reconstruction — timings and peers are illustrative, not a real capture.",
  speed: 20,
  watchlist: [
    { prefix: "208.65.152.0/22", expected_origins: [36561], label: "YouTube" },
  ],
  messages: [],
};
// Baseline: YouTube's /22 announced normally.
for (let i = 0; i < 5; i++) {
  yt.messages.push(ann(i * 4000, i, ["208.65.152.0/22"], [64500 + i, 3356, 36561]));
}
// 18:47 UTC: the hijack — a more-specific /24 from AS17557 via AS3491 spreads peer to peer.
for (let i = 0; i < 12; i++) {
  yt.messages.push(ann(30_000 + i * 3000, i, ["208.65.153.0/24"], [64500 + i, 3491, 17557]));
}
// ~20:07: YouTube fights back, announcing the same /24 itself (more-specific battle).
for (let i = 0; i < 5; i++) {
  yt.messages.push(ann(90_000 + i * 3000, i, ["208.65.153.0/24"], [64500 + i, 3356, 36561]));
}
// ~21:01: upstream de-peers Pakistan Telecom; the rogue route is withdrawn.
for (let i = 0; i < 12; i++) {
  yt.messages.push(wd(140_000 + i * 2000, i, ["208.65.153.0/24"]));
}

// --- (c) June 2019: a route optimizer's leaked more-specifics ride a long path through a steel mill.
const leak = {
  name: "prepend-leak-2019",
  title: "Route-optimizer leak — June 2019",
  description: "A BGP optimizer at a small Pennsylvania ISP generated fake more-specifics of Cloudflare prefixes; a customer (a steel company, AS396531) leaked them to Verizon (AS701), which propagated them worldwide. Long, strange AS paths everywhere.",
  disclaimer: "Hand-authored reconstruction — timings and peers are illustrative, not a real capture.",
  speed: 20,
  watchlist: [
    { prefix: "104.16.0.0/20", expected_origins: [13335], label: "Cloudflare CDN" },
  ],
  messages: [],
};
// Baseline: 24 normal announcements settle the EWMA around 3 hops.
for (let i = 0; i < 24; i++) {
  leak.messages.push(ann(i * 2000, i, ["104.16.0.0/20"], [64500 + (i % 16), 174, 13335]));
}
// The leak: more-specifics appear (sev2 — same origin, could be TE...) ...
for (let i = 0; i < 4; i++) {
  leak.messages.push(ann(60_000 + i * 3000, i, [`104.16.${i * 4}.0/22`], [64500 + i, 701, 396531, 33154, 3356, 13335]));
}
// ...and the watched /20 itself arrives with an absurd prepended path (PATH_ANOMALY).
leak.messages.push(ann(80_000, 2, ["104.16.0.0/20"], [64502, 701, 396531, 33154, 33154, 33154, 33154, 3356, 3356, 13335]));
// One path with a non-consecutive repeat (poisoning-style anomaly).
leak.messages.push(ann(95_000, 3, ["104.16.0.0/20"], [64503, 701, 396531, 701, 3356, 13335]));
// Recovery: normal paths return.
for (let i = 0; i < 5; i++) {
  leak.messages.push(ann(120_000 + i * 2000, i, ["104.16.0.0/20"], [64500 + i, 174, 13335]));
}

mkdirSync("fixtures", { recursive: true });
for (const f of [fb, yt, leak]) {
  writeFileSync(`fixtures/${f.name}.json`, JSON.stringify(f, null, 1));
  console.log(`fixtures/${f.name}.json: ${f.messages.length} messages`);
}
```

- [ ] **Step 10.2: Run it** — `node scripts/make-fixtures.mjs` → three files written.

- [ ] **Step 10.3: Write `test/fixtures.test.ts`** proving each fixture actually triggers its headline event through the real pipeline:

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { compileWatchlist, emptyState, processMessage } from "../src/heuristics";
import type { Fixture } from "../src/types";
import facebook from "../fixtures/facebook-2021.json";
import youtube from "../fixtures/youtube-2008.json";
import leak from "../fixtures/prepend-leak-2019.json";

function runFixture(f: Fixture) {
  const wl = compileWatchlist(f.watchlist);
  const st = emptyState(0);
  const events = [];
  for (const m of f.messages) events.push(...processMessage(m.data, wl, st, CONFIG, m.dt));
  return events;
}

describe("fixtures drive the real pipeline", () => {
  it("facebook-2021 produces withdrawal storms for both DNS prefixes", () => {
    const kinds = runFixture(facebook as unknown as Fixture);
    const storms = kinds.filter((e) => e.kind === "WITHDRAWAL_STORM");
    expect(storms.length).toBeGreaterThanOrEqual(2);
  });
  it("youtube-2008 produces a sev3 MORE_SPECIFIC from AS17557 and a sev2 from YouTube's own /24", () => {
    const evs = runFixture(youtube as unknown as Fixture);
    expect(evs.some((e) => e.kind === "MORE_SPECIFIC" && e.severity === 3 && e.details.observedOrigin === 17557)).toBe(true);
    expect(evs.some((e) => e.kind === "MORE_SPECIFIC" && e.severity === 2 && e.details.observedOrigin === 36561)).toBe(true);
  });
  it("prepend-leak-2019 produces MORE_SPECIFIC and PATH_ANOMALY events", () => {
    const evs = runFixture(leak as unknown as Fixture);
    expect(evs.some((e) => e.kind === "MORE_SPECIFIC")).toBe(true);
    expect(evs.some((e) => e.kind === "PATH_ANOMALY")).toBe(true);
  });
});
```

- [ ] **Step 10.4: Run** — `npx vitest run` → all PASS (tune fixture message counts if a threshold isn't met — e.g. the storm needs ≥10 distinct peers within 60s of *fixture* time).
- [ ] **Step 10.5: Deploy + live replay verification**

```powershell
npx wrangler deploy
Invoke-RestMethod -Method POST https://bgpweather.clydeford.net/replay/facebook-2021
Start-Sleep 30
Invoke-RestMethod "https://bgpweather.clydeford.net/api/events?limit=10"
```
Expected: replay returns `{started: ...}`; events list contains `kind: "REPLAY"` rows with `replay: true` and `details.originalKind: "WITHDRAWAL_STORM"`.

- [ ] **Step 10.6: Commit** — `git commit -m "feat: replay fixtures (Facebook 2021, YouTube 2008, 2019 optimizer leak) + pipeline tests"`

### Task 11: README, final verification, push

**Files:**
- Modify: `README.md`

- [ ] **Step 11.1: Write README.md** — merge/replace the repo's stub. Must contain, in plain English for a network engineer who doesn't write code:
  - What this is + live URL + screenshot placeholder.
  - **File-by-file map** (one line each, per spec §10).
  - **Teaching notes** (spec §13), one paragraph each: (1) what a Durable Object is and why a plain Worker can't hold a WebSocket open; (2) why detection is cheap heuristic code and only narration is AI (cost, latency, reliability — and the hard caps); (3) how `heuristics.ts` being pure functions (data in, events out, no network/clock) makes it testable with vitest.
  - How to run locally (`npm install`, `npx wrangler dev`), test (`npm test`), deploy (`npx wrangler deploy`).
  - How to enable AI narration: `npx wrangler secret put ANTHROPIC_API_KEY`; kill switch `NARRATION_ENABLED=false`.
  - How to tune thresholds (`src/config.ts`), mute a noisy prefix (`"muted": true`), and re-verify origins (`node scripts/verify-watchlist.mjs`).
  - Honesty note: severity-3 = "detected — unconfirmed"; replays are reconstructions.

- [ ] **Step 11.2: Full verification sweep (verification-before-completion skill)**
  - `npx vitest run` → all green.
  - `npx tsc --noEmit` → clean.
  - `/api/status` → connected, msgs flowing, after the session's soak period.
  - `/api/events` → real events or empty; replay events present from Task 10.
  - Dashboard loads at https://bgpweather.clydeford.net with live ticker moving.
  - Trigger one more replay and watch it appear via `/api/events`.

- [ ] **Step 11.3: Push**

```powershell
git add -A
git commit -m "docs: README with plain-English teaching notes"
git push -u origin main
```

- [ ] **Step 11.4: Report to owner** — summary including: live URL, what was deployed, test results, the one manual step remaining (`npx wrangler secret put ANTHROPIC_API_KEY` to turn on AI narration — everything else already works with template text), and any custom-domain caveat from Task 8.

---

## Self-review notes

- **Spec coverage:** §3 architecture (Tasks 0,7), §4 RIS + watchlist (Tasks 1,7), §5 heuristics + tunable config + lazy persistence (Tasks 2,5,7), §6 narration + caps + kill switch + fallback (Task 6), §7 dashboard incl. severity colours/conditions/ticker/replay tag (Task 9), §8 replay same-pipeline/isolated-state/one-at-a-time (Tasks 7,10), §9 all six routes (Task 7), §10 structure (all), §11 phases (Task ordering), §12 gotchas: CPU (tiny per-msg work), eviction (cron watchdog + alarm), retention cron, muted flag, "detected — unconfirmed" wording (templates + UI), §13 teaching README (Task 11).
- **Deviations from spec (deliberate):** `expected_origins` array instead of scalar (anycast reality, verified); `aggregate` flag (noise control for big blocks); severity-3 queue-jumping implemented as a reserved budget split (8 non-sev3 + 4 reserved of 12 total) since narration is immediate, not queued.
- **Type consistency:** `NewEvent`/`BgpEvent`, `CompiledEntry`, `NarrationBudget.toJSON/fromJSON`, `rowToEvent` used consistently across Tasks 5–7 and 10.
