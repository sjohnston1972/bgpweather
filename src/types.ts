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
  // Inclusive ASN ranges for operators that rotate across a whole block
  // (Verisign announces the roots from AS396539-AS396828).
  expected_origin_ranges?: [number, number][];
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
