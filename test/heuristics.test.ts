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
  it("fires at >=10 distinct peers within 60s, not at 9, debounces repeats", () => {
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
  it("fires at 6 mixed transitions in 5 min", () => {
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
