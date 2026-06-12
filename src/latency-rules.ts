// The latency channel's weather engine. Pure functions, same philosophy as
// heuristics.ts: no IO, no clock, no Cloudflare imports — the LatencyWatcher
// DO feeds it parsed Atlas results and persists the state it mutates.
//
// Weather = deviation from THIS region's own baseline (an EWMA), never raw
// milliseconds: Tokyo→London is always ~200ms, and that's not a storm.

import type { Config } from "./config";
import type {
  LatencyFrame, LatencyState, NewEvent, RegionCycleStats, RegionInfo, RegionState,
} from "./types";

export function emptyLatencyState(): LatencyState {
  return { regions: {}, frontLastTs: 0, frontActive: false };
}

function emptyRegionState(now: number): RegionState {
  return {
    ewmaRtt: 0, ewmaDev: 0, normalSamples: 0, cycles: 0,
    level: 0, levelSince: now, degradedSince: 0,
    lastLossPct: 0, lowData: false, lastEventTs: {},
  };
}

// ---- Atlas /latest/ parsing ---------------------------------------------------

interface AtlasPingEntry {
  timestamp?: number;
  sent?: number;
  rcvd?: number;
  result?: Array<{ rtt?: number; x?: string }>;
}

export interface ParsedMeasurement { rtts: number[]; lost: number; reporting: number }

// One /latest/ response -> per-probe medians + total-loss count.
// Entries older than maxAgeS are stale probes and ignored entirely.
export function parseLatest(results: unknown[], nowS: number, maxAgeS: number): ParsedMeasurement {
  const rtts: number[] = [];
  let lost = 0;
  let reporting = 0;
  for (const raw of results) {
    const r = raw as AtlasPingEntry;
    if (!r || typeof r !== "object") continue;
    if (nowS - (r.timestamp ?? 0) > maxAgeS) continue;
    if (!r.sent || r.sent <= 0) continue;
    reporting++;
    const samples = (r.result ?? [])
      .map((p) => p.rtt)
      .filter((v): v is number => typeof v === "number" && v > 0)
      .sort((a, b) => a - b);
    if (samples.length === 0) {
      lost++; // probe reported, every ping went unanswered
    } else {
      rtts.push(samples[Math.floor(samples.length / 2)]);
    }
  }
  return { rtts, lost, reporting };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// Combine all of a region's measurements for this cycle.
export function aggregateRegion(parts: ParsedMeasurement[]): RegionCycleStats {
  const rtts = parts.flatMap((p) => p.rtts).sort((a, b) => a - b);
  const lost = parts.reduce((s, p) => s + p.lost, 0);
  const reporting = parts.reduce((s, p) => s + p.reporting, 0);
  return {
    medianRtt: percentile(rtts, 0.5),
    p90Rtt: percentile(rtts, 0.9),
    lossPct: reporting > 0 ? (lost / reporting) * 100 : 0,
    samples: reporting,
  };
}

// ---- weather rules --------------------------------------------------------------

function levelFor(deltaPct: number, lossPct: number, collapsed: boolean, L: Config["latency"]): 0 | 1 | 2 | 3 {
  if (collapsed) return 3; // a regional probe blackout is itself weather
  let byRtt: 0 | 1 | 2 | 3 = 0;
  if (deltaPct > L.stormyDelta * 100) byRtt = 3;
  else if (deltaPct > L.unsettledDelta * 100) byRtt = 2;
  else if (deltaPct > L.breezyDelta * 100) byRtt = 1;
  let byLoss: 0 | 1 | 2 | 3 = 0;
  if (lossPct > L.stormyLossPct) byLoss = 3;
  else if (lossPct > L.unsettledLossPct) byLoss = 2;
  else if (lossPct > L.breezyLossPct) byLoss = 1;
  return Math.max(byRtt, byLoss) as 0 | 1 | 2 | 3;
}

const LEVEL_NAMES = ["Clear", "Breezy", "Unsettled", "Stormy"] as const;

function debounced(st: RegionState, key: string, ms: number, now: number): boolean {
  const last = st.lastEventTs[key];
  return last !== undefined && now - last < ms;
}

// One poll cycle: update every region's baseline + level, derive the frame,
// and emit events. Mutates `state` in place (caller persists it).
export function stepAll(
  statsByRegion: Record<string, RegionCycleStats>,
  state: LatencyState,
  regions: Record<string, RegionInfo>,
  cfg: Config,
  now: number,
): { frame: LatencyFrame; events: NewEvent[] } {
  const L = cfg.latency;
  const events: NewEvent[] = [];
  const cells: LatencyFrame["regions"] = [];

  for (const [id, info] of Object.entries(regions)) {
    const stats = statsByRegion[id];
    let st = state.regions[id];
    if (!st) { st = emptyRegionState(now); state.regions[id] = st; }

    const haveData = !!stats && stats.medianRtt !== null && stats.samples >= L.minSamples;
    st.lowData = !haveData;

    if (!haveData) {
      // Hold the previous level; don't poison baselines with thin data.
      cells.push({
        id, level: st.level, medianRtt: stats?.medianRtt ?? null, deltaPct: null,
        lossPct: stats?.lossPct ?? 0, samples: stats?.samples ?? 0,
        ready: st.cycles >= L.baselineReadyCycles, lowData: true,
      });
      continue;
    }

    const median = stats.medianRtt as number;
    const ready = st.cycles >= L.baselineReadyCycles;
    const deltaPct = st.ewmaRtt > 0 ? ((median - st.ewmaRtt) / st.ewmaRtt) * 100 : 0;
    const collapsed = st.normalSamples > 0 && stats.samples < st.normalSamples * L.collapseFraction;
    const level = ready ? levelFor(deltaPct, stats.lossPct, collapsed, L) : 0;
    const prevLevel = st.level;
    const regionName = info.name;

    const base = {
      region: id, regionName, medianRtt: +median.toFixed(1),
      baselineRtt: +st.ewmaRtt.toFixed(1), deltaPct: +deltaPct.toFixed(1),
      lossPct: +stats.lossPct.toFixed(1), samples: stats.samples,
      channel: "latency",
    };

    if (ready) {
      // Rule 1: LATENCY_STORM on entering Unsettled (sev2) or Stormy (sev3).
      if (level >= 2 && level > prevLevel && !debounced(st, `storm${level}`, L.stormDebounceMs, now)) {
        st.lastEventTs[`storm${level}`] = now;
        events.push({
          ts: now, kind: "LATENCY_STORM", severity: level === 3 ? 3 : 2, label: regionName,
          details: { ...base, weather: LEVEL_NAMES[level], samplesCollapsed: collapsed },
        });
      }
      // Rule 2: LOSS_SQUALL on a sharp loss jump, even if RTT looks fine.
      const jump = stats.lossPct - st.lastLossPct;
      if (jump >= L.squallDeltaPts && !debounced(st, "squall", L.squallDebounceMs, now)) {
        st.lastEventTs.squall = now;
        events.push({
          ts: now, kind: "LOSS_SQUALL", severity: jump >= L.squallBigPts ? 3 : 2, label: regionName,
          details: { ...base, lossJumpPts: +jump.toFixed(1), previousLossPct: +st.lastLossPct.toFixed(1) },
        });
      }
      // Rule 3: CLEARING — back to Clear after a sustained degradation.
      if (level === 0 && st.degradedSince > 0 && now - st.degradedSince >= L.clearingMinDegradedMs) {
        events.push({
          ts: now, kind: "CLEARING", severity: 1, label: regionName,
          details: { ...base, degradedForMin: Math.round((now - st.degradedSince) / 60_000) },
        });
      }
    }

    // State transitions.
    if (level !== prevLevel) { st.level = level; st.levelSince = now; }
    if (level >= 2 && st.degradedSince === 0) st.degradedSince = now;
    if (level < 2) st.degradedSince = level === 0 ? 0 : st.degradedSince;
    st.lastLossPct = stats.lossPct;

    // Baselines update AFTER judging (a storm shouldn't excuse itself), and
    // deliberately keep learning through storms so sustained shifts become
    // the new normal over ~1/α cycles.
    st.ewmaRtt = st.cycles === 0 ? median : L.ewmaAlpha * median + (1 - L.ewmaAlpha) * st.ewmaRtt;
    st.ewmaDev = st.cycles === 0 ? 0 : L.ewmaAlpha * Math.abs(median - st.ewmaRtt) + (1 - L.ewmaAlpha) * st.ewmaDev;
    st.normalSamples = st.cycles === 0 ? stats.samples : L.ewmaAlpha * stats.samples + (1 - L.ewmaAlpha) * st.normalSamples;
    st.cycles++;

    cells.push({
      id, level, medianRtt: +median.toFixed(1), deltaPct: ready ? +deltaPct.toFixed(1) : null,
      lossPct: +stats.lossPct.toFixed(1), samples: stats.samples, ready, lowData: false,
    });
  }

  // Rule 4: GLOBAL_FRONT — a widespread band of bad weather.
  const degraded = cells.filter((c) => c.ready && c.level >= 2);
  state.frontActive = degraded.length >= cfg.latency.frontMinRegions;
  if (state.frontActive && now - state.frontLastTs >= cfg.latency.frontDebounceMs) {
    state.frontLastTs = now;
    events.push({
      ts: now, kind: "GLOBAL_FRONT", severity: 3, label: "Global",
      details: {
        channel: "latency",
        regions: degraded.map((c) => ({ id: c.id, name: regions[c.id]?.name ?? c.id, level: c.level })),
        regionNames: degraded.map((c) => regions[c.id]?.name ?? c.id).join(", "),
        count: degraded.length,
      },
    });
  }

  const frame: LatencyFrame = {
    ts: now,
    ready: cells.some((c) => c.ready),
    frontActive: state.frontActive,
    regions: cells,
  };
  return { frame, events };
}
