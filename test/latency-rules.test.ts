import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { parseLatest, aggregateRegion, stepAll, emptyLatencyState } from "../src/latency-rules";
import type { LatencyState, RegionCycleStats } from "../src/types";
import fixture from "./atlas-latest.fixture.json";

const REGIONS = { "uk-ireland": { name: "UK & Ireland", lat: 52, lng: -1, radius: 5 } };
const L = CONFIG.latency;

function stats(over: Partial<RegionCycleStats> = {}): Record<string, RegionCycleStats> {
  return { "uk-ireland": { medianRtt: 40, p90Rtt: 80, lossPct: 0, samples: 60, ...over } };
}

// Run enough healthy cycles to warm the baseline up past the event gate.
function warmedState(now = 0): { st: LatencyState; now: number } {
  const st = emptyLatencyState();
  let t = now;
  for (let i = 0; i < L.baselineReadyCycles; i++) {
    stepAll(stats(), st, REGIONS, CONFIG, t);
    t += L.pollIntervalMs;
  }
  return { st, now: t };
}

describe("parseLatest", () => {
  it("parses the real Atlas fixture: per-probe medians, losses, staleness", () => {
    const ts = Math.max(...(fixture as { timestamp: number }[]).map((r) => r.timestamp));
    const parsed = parseLatest(fixture as unknown[], ts + 60, L.staleResultMaxAgeS);
    expect(parsed.reporting).toBeGreaterThan(5);
    expect(parsed.rtts.length + parsed.lost).toBe(parsed.reporting);
    for (const r of parsed.rtts) expect(r).toBeGreaterThan(0);
  });
  it("drops stale entries", () => {
    const parsed = parseLatest(fixture as unknown[], 9_999_999_999, L.staleResultMaxAgeS);
    expect(parsed.reporting).toBe(0);
  });
});

describe("aggregateRegion", () => {
  it("computes median/p90/loss across measurements", () => {
    const agg = aggregateRegion([
      { rtts: [10, 20, 30], lost: 1, reporting: 4 },
      { rtts: [40, 50], lost: 1, reporting: 3 },
    ]);
    expect(agg.samples).toBe(7);
    expect(agg.medianRtt).toBe(30);
    expect(agg.lossPct).toBeCloseTo((2 / 7) * 100, 1);
  });
  it("returns null RTT when nothing reported", () => {
    expect(aggregateRegion([]).medianRtt).toBeNull();
  });
});

describe("weather levels & baseline gate", () => {
  it("emits no events while the baseline is warming up, even in a storm", () => {
    const st = emptyLatencyState();
    const { events } = stepAll(stats({ medianRtt: 4000, lossPct: 50 }), st, REGIONS, CONFIG, 1000);
    expect(events).toEqual([]);
  });
  it("frame reports level/deltaPct once warmed; healthy region is Clear", () => {
    const { st, now } = warmedState();
    const { frame } = stepAll(stats(), st, REGIONS, CONFIG, now);
    const cell = frame.regions[0];
    expect(cell.ready).toBe(true);
    expect(cell.level).toBe(0);
    expect(Math.abs(cell.deltaPct ?? 99)).toBeLessThan(5);
  });
  it("holds the previous level and flags lowData below the sample floor", () => {
    const { st, now } = warmedState();
    const { frame, events } = stepAll(stats({ medianRtt: 4000, samples: 3 }), st, REGIONS, CONFIG, now);
    expect(frame.regions[0].level).toBe(0);
    expect(frame.regions[0].lowData).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("LATENCY_STORM", () => {
  it("fires sev3 on Stormy entry, debounced for an hour", () => {
    const { st, now } = warmedState();
    const { events, frame } = stepAll(stats({ medianRtt: 110 }), st, REGIONS, CONFIG, now); // +175%
    expect(frame.regions[0].level).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "LATENCY_STORM", severity: 3 });
    expect(events[0].details.region).toBe("uk-ireland");
    // still stormy next cycle -> debounced
    const again = stepAll(stats({ medianRtt: 115 }), st, REGIONS, CONFIG, now + L.pollIntervalMs);
    expect(again.events).toEqual([]);
  });
  it("fires sev2 on Unsettled entry", () => {
    const { st, now } = warmedState();
    const { events } = stepAll(stats({ medianRtt: 70 }), st, REGIONS, CONFIG, now); // +75%
    expect(events[0]).toMatchObject({ kind: "LATENCY_STORM", severity: 2 });
  });
  it("samples-collapse alone is Stormy", () => {
    const { st, now } = warmedState();
    const { frame } = stepAll(stats({ samples: 10 }), st, REGIONS, CONFIG, now); // < 30% of ~60
    expect(frame.regions[0].level).toBe(3);
  });
});

describe("LOSS_SQUALL", () => {
  it("fires on a >=10pt loss jump even with fine RTT; sev3 at >=25pts", () => {
    const { st, now } = warmedState();
    const r1 = stepAll(stats({ lossPct: 12 }), st, REGIONS, CONFIG, now);
    expect(r1.events.some((e) => e.kind === "LOSS_SQUALL" && e.severity === 2)).toBe(true);
    // another big jump within debounce -> quiet
    const r2 = stepAll(stats({ lossPct: 26 }), st, REGIONS, CONFIG, now + L.pollIntervalMs);
    expect(r2.events.filter((e) => e.kind === "LOSS_SQUALL")).toEqual([]);
    // after debounce, a 25+pt jump is sev3
    const t3 = now + L.squallDebounceMs + L.pollIntervalMs;
    stepAll(stats({ lossPct: 0 }), st, REGIONS, CONFIG, t3);
    const r3 = stepAll(stats({ lossPct: 30 }), st, REGIONS, CONFIG, t3 + L.pollIntervalMs);
    expect(r3.events.some((e) => e.kind === "LOSS_SQUALL" && e.severity === 3)).toBe(true);
  });
});

describe("CLEARING", () => {
  it("fires sev1 when a region returns to Clear after >=30min degraded", () => {
    const { st, now } = warmedState();
    let t = now;
    stepAll(stats({ medianRtt: 110 }), st, REGIONS, CONFIG, t); // go stormy
    const cycles = Math.ceil(L.clearingMinDegradedMs / L.pollIntervalMs) + 1;
    for (let i = 0; i < cycles; i++) {
      t += L.pollIntervalMs;
      stepAll(stats({ medianRtt: 110 }), st, REGIONS, CONFIG, t);
    }
    t += L.pollIntervalMs;
    const { events } = stepAll(stats({ medianRtt: 41 }), st, REGIONS, CONFIG, t);
    expect(events.some((e) => e.kind === "CLEARING" && e.severity === 1)).toBe(true);
  });
  it("no CLEARING for a short blip", () => {
    const { st, now } = warmedState();
    stepAll(stats({ medianRtt: 110 }), st, REGIONS, CONFIG, now);
    const { events } = stepAll(stats({ medianRtt: 41 }), st, REGIONS, CONFIG, now + L.pollIntervalMs);
    expect(events.filter((e) => e.kind === "CLEARING")).toEqual([]);
  });
});

describe("GLOBAL_FRONT", () => {
  const THREE = {
    "uk-ireland": { name: "UK & Ireland", lat: 52, lng: -1, radius: 5 },
    "us-east": { name: "US East", lat: 39, lng: -77, radius: 9 },
    "japan-korea": { name: "Japan & Korea", lat: 35, lng: 137, radius: 8 },
  };
  function threeStats(rtt: number): Record<string, RegionCycleStats> {
    return Object.fromEntries(Object.keys(THREE).map((id) => [id, { medianRtt: rtt, p90Rtt: rtt * 2, lossPct: 0, samples: 60 }]));
  }
  it("fires sev3 when >=3 regions are Unsettled+, debounced 2h, and flags frontActive", () => {
    const st = emptyLatencyState();
    let t = 0;
    for (let i = 0; i < L.baselineReadyCycles; i++) {
      stepAll(threeStats(40), st, THREE, CONFIG, t);
      t += L.pollIntervalMs;
    }
    const { events, frame } = stepAll(threeStats(80), st, THREE, CONFIG, t); // all +100% => unsettled
    expect(frame.frontActive).toBe(true);
    expect(events.some((e) => e.kind === "GLOBAL_FRONT" && e.severity === 3)).toBe(true);
    const again = stepAll(threeStats(85), st, THREE, CONFIG, t + L.pollIntervalMs);
    expect(again.events.filter((e) => e.kind === "GLOBAL_FRONT")).toEqual([]);
    expect(again.frame.frontActive).toBe(true);
  });
});
