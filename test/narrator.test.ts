import { describe, expect, it } from "vitest";
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
