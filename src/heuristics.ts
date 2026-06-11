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

// Is this origin AS allowed for the watchlist entry? Checks the scalar list
// and any declared inclusive ASN ranges (anycast operators like Verisign
// rotate the roots across a whole allocated block).
export function isExpectedOrigin(entry: WatchlistEntry, origin: number): boolean {
  if (entry.expected_origins.includes(origin)) return true;
  for (const [lo, hi] of entry.expected_origin_ranges ?? []) {
    if (origin >= lo && origin <= hi) return true;
  }
  return false;
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
  if (origin === undefined || isExpectedOrigin(w.entry, origin)) return;
  // undefined = never fired for this origin before -> always fire
  const last = ps.originDebounce[String(origin)];
  if (last !== undefined && now - last < cfg.rules.originChangeDebounceMs) return;
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
  const differs = origin === undefined || !isExpectedOrigin(w.entry, origin);
  // Big aggregates (Apple's /8 etc.) legitimately announce same-origin more-specifics
  // all day — only a *different* origin inside them is interesting.
  if (w.entry.aggregate && !differs) return;
  // A different origin whose path still contains the legitimate owner is
  // almost always sanctioned delegation (CDN edge caches inside ISPs announce
  // the owner's space with the owner as upstream). Interesting, not alarming.
  const viaExpected = differs && path.some((asn) => isExpectedOrigin(w.entry, asn));
  const ps = prefixState(state, w.entry.prefix);
  const key = `${announced}|${origin}`;
  const last = ps.msDebounce[key];
  if (last !== undefined && now - last < cfg.rules.moreSpecificDebounceMs) return;
  ps.msDebounce[key] = now;
  events.push({
    ts: now, kind: "MORE_SPECIFIC", severity: differs && !viaExpected ? 3 : 2, prefix: announced, label: w.entry.label,
    details: {
      announcedPrefix: announced, watchedPrefix: w.entry.prefix,
      observedOrigin: origin, expectedOrigins: w.entry.expected_origins,
      viaExpectedOrigin: viaExpected,
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
  // 0 = never fired (a real ts of exactly 0 never happens with Date.now())
  if (ps.stormDebounce !== 0 && now - ps.stormDebounce < cfg.rules.stormDebounceMs) return;
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
  if (ps.flapDebounce !== 0 && now - ps.flapDebounce < cfg.rules.flapDebounceMs) return;
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
  if (reason && (ps.pathAnomalyDebounce === 0 || now - ps.pathAnomalyDebounce >= cfg.rules.pathAnomalyDebounceMs)) {
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
