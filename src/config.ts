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
  retentionDays: 30,
  persistIntervalMs: 60_000,
  statsBroadcastMs: 2_000,
} as const;

export type Config = typeof CONFIG;
