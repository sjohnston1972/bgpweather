import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { compileWatchlist, emptyState, processMessage } from "../src/heuristics";
import type { Fixture, NewEvent } from "../src/types";
import facebook from "../fixtures/facebook-2021.json";
import youtube from "../fixtures/youtube-2008.json";
import leak from "../fixtures/prepend-leak-2019.json";

function runFixture(f: Fixture): NewEvent[] {
  const wl = compileWatchlist(f.watchlist);
  const st = emptyState(0);
  const events: NewEvent[] = [];
  for (const m of f.messages) events.push(...processMessage(m.data, wl, st, CONFIG, m.dt));
  return events;
}

describe("fixtures drive the real pipeline", () => {
  it("facebook-2021 produces withdrawal storms for both DNS prefixes", () => {
    const evs = runFixture(facebook as unknown as Fixture);
    const storms = evs.filter((e) => e.kind === "WITHDRAWAL_STORM");
    expect(storms.length).toBeGreaterThanOrEqual(2);
    expect(new Set(storms.map((s) => s.prefix)).size).toBe(2);
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
