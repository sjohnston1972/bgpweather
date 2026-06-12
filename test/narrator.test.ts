import { describe, expect, it } from "vitest";
import { canNarrateFromCounts, templateFor, narrate } from "../src/narrator";
import type { NewEvent } from "../src/types";

function ev(kind: NewEvent["kind"], severity: 1 | 2 | 3, details: Record<string, unknown> = {}): NewEvent {
  return { ts: 0, kind, severity, prefix: "1.1.1.0/24", label: "Cloudflare DNS", details };
}

describe("canNarrateFromCounts", () => {
  // Counts come from D1 ("narrated rows in the last hour"), which makes the
  // budget genuinely global across the BGP and latency Durable Objects.
  it("allows 8 non-sev3 per hour, then only sev3 up to 12 total", () => {
    expect(canNarrateFromCounts({ total: 7, nonSev3: 7, calm: 0 }, 2, "FLAP")).toBe(true);
    expect(canNarrateFromCounts({ total: 8, nonSev3: 8, calm: 0 }, 2, "FLAP")).toBe(false);
    expect(canNarrateFromCounts({ total: 11, nonSev3: 8, calm: 0 }, 3, "ORIGIN_CHANGE")).toBe(true);
    expect(canNarrateFromCounts({ total: 12, nonSev3: 8, calm: 0 }, 3, "ORIGIN_CHANGE")).toBe(false);
  });
  it("latency severity-3s share the same queue-jumping rights", () => {
    expect(canNarrateFromCounts({ total: 11, nonSev3: 8, calm: 0 }, 3, "GLOBAL_FRONT")).toBe(true);
    expect(canNarrateFromCounts({ total: 8, nonSev3: 8, calm: 0 }, 2, "LATENCY_STORM")).toBe(false);
  });
  it("calm summaries have their own 1/hour cap, independent of the main pool", () => {
    expect(canNarrateFromCounts({ total: 12, nonSev3: 8, calm: 0 }, 1, "CALM_SUMMARY")).toBe(true);
    expect(canNarrateFromCounts({ total: 0, nonSev3: 0, calm: 1 }, 1, "CALM_SUMMARY")).toBe(false);
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
    for (const kind of ["ORIGIN_CHANGE", "MORE_SPECIFIC", "WITHDRAWAL_STORM", "FLAP", "PATH_ANOMALY", "CALM_SUMMARY"] as const) {
      expect(templateFor(ev(kind, 1)).length).toBeGreaterThan(10);
    }
  });
});

describe("narrate", () => {
  it("falls back to template when narration is disabled", async () => {
    const r = await narrate(ev("ORIGIN_CHANGE", 3, { observedOrigin: 666, expectedOrigins: [13335] }),
      { apiKey: "k", enabled: false, allowed: true, fetchImpl: () => { throw new Error("must not fetch"); } });
    expect(r.narrated).toBe(false);
  });
  it("falls back when there is no API key", async () => {
    const r = await narrate(ev("FLAP", 1), { apiKey: undefined, enabled: true, allowed: true });
    expect(r.narrated).toBe(false);
    expect(r.text.length).toBeGreaterThan(10);
  });
  it("falls back when the budget disallows", async () => {
    const r = await narrate(ev("FLAP", 1), {
      apiKey: "k", enabled: true, allowed: false,
      fetchImpl: () => { throw new Error("must not fetch"); },
    });
    expect(r.narrated).toBe(false);
  });
  it("falls back on API failure", async () => {
    const r = await narrate(ev("ORIGIN_CHANGE", 3), {
      apiKey: "k", enabled: true, allowed: true,
      fetchImpl: async () => new Response("overloaded", { status: 529 }),
    });
    expect(r.narrated).toBe(false);
  });
  it("returns AI text on success", async () => {
    const r = await narrate(ev("ORIGIN_CHANGE", 3), {
      apiKey: "k", enabled: true, allowed: true,
      fetchImpl: async () => Response.json({ content: [{ type: "text", text: "Blustery out there on the routing table." }] }),
    });
    expect(r).toEqual({ text: "Blustery out there on the routing table.", narrated: true });
  });
  it("has templates for the latency kinds", () => {
    expect(templateFor(ev("LATENCY_STORM", 3, { regionName: "US East", deltaPct: 80, lossPct: 3, medianRtt: 90 }))).toContain("US East");
    expect(templateFor(ev("LOSS_SQUALL", 2, { regionName: "Brazil", lossJumpPts: 12, lossPct: 14 }))).toContain("Brazil");
    expect(templateFor(ev("CLEARING", 1, { regionName: "Nordics", degradedForMin: 45 }))).toContain("Nordics");
    expect(templateFor(ev("GLOBAL_FRONT", 3, { regionNames: "US East, Brazil, India", count: 3 }))).toContain("US East");
  });
});
