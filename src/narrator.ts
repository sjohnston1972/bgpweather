// AI commentary with hard cost caps. Detection never depends on this module
// succeeding: every path that can fail returns a template string instead.
// Pure-ish: fetch is injectable so tests never hit the network.

import { CONFIG } from "./config";
import type { BgpEvent, EventKind, NewEvent, Severity } from "./types";

// The narration budget is GLOBAL across both Durable Objects (BGP + latency).
// Rather than coupling the DOs, the D1 events table is the ledger: callers
// count `narrated = 1` rows from the past hour and ask this pure function.
// Non-sev3 events get 8/hour; severity 3 can spend the full 12 ("jumps the
// queue"). Calm summaries have a separate 1/hour cap.
export interface NarrationCounts { total: number; nonSev3: number; calm: number }

export function canNarrateFromCounts(counts: NarrationCounts, sev: Severity, kind: EventKind): boolean {
  if (kind === "CALM_SUMMARY") return counts.calm < CONFIG.narration.calmMaxPerHour;
  if (counts.total >= CONFIG.narration.maxPerHour) return false;
  if (sev < 3 && counts.nonSev3 >= CONFIG.narration.maxNonSev3PerHour) return false;
  return true;
}

// Template fallbacks — used when narration is disabled, capped, or the API fails.
export function templateFor(ev: NewEvent | BgpEvent): string {
  const d = ev.details as Record<string, unknown>;
  const where = ev.prefix ? `${ev.prefix}${ev.label ? ` (${ev.label})` : ""}` : "the routing table";
  switch (ev.kind) {
    case "ORIGIN_CHANGE":
      if (d.viaExpectedOrigin) {
        return `Origin change on ${where}: now announced by AS${d.observedOrigin}, but via the expected operator's own network — likely routine anycast rotation.`;
      }
      return `Origin change detected on ${where}: expected AS${(d.expectedOrigins as number[] | undefined)?.join("/AS") ?? "?"}, now seeing AS${d.observedOrigin}. Detected — unconfirmed.`;
    case "MORE_SPECIFIC":
      return `More-specific prefix ${d.announcedPrefix ?? ev.prefix} announced inside watched ${d.watchedPrefix ?? "block"}${ev.label ? ` (${ev.label})` : ""} by AS${d.observedOrigin ?? "?"}. Could be traffic engineering; could be mischief. Detected — unconfirmed.`;
    case "WITHDRAWAL_STORM":
      return `Withdrawal storm on ${where}: ${d.distinctPeers ?? "many"} peers withdrew the route within ${d.windowSeconds ?? 60}s. The prefix may be dropping off the internet.`;
    case "FLAP":
      return `Route flapping on ${where}: ${d.transitions ?? "several"} announce/withdraw transitions in ${d.windowMinutes ?? 5} minutes.`;
    case "PATH_ANOMALY":
      return `Path anomaly on ${where}: ${d.reason ?? "unusual AS path observed"}.`;
    case "CALM_SUMMARY":
      return `All quiet on the routing front. ${d.messages ?? 0} BGP updates this hour (${d.announcements ?? 0} announcements, ${d.withdrawals ?? 0} withdrawals); busiest collector ${d.busiestCollector ?? "n/a"}.`;
    case "LATENCY_STORM":
      return `${d.weather ?? "Heavy"} latency over ${d.regionName ?? "a region"}: round-trips ${d.deltaPct}% above seasonal norms (median ${d.medianRtt}ms), packet loss ${d.lossPct}%.`;
    case "LOSS_SQUALL":
      return `Packet-loss squall over ${d.regionName ?? "a region"}: loss jumped ${d.lossJumpPts} points to ${d.lossPct}% in a single observation cycle.`;
    case "CLEARING":
      return `Conditions clearing over ${d.regionName ?? "a region"} after ${d.degradedForMin ?? "?"} minutes of disturbed latency. Round-trips back on seasonal norms.`;
    case "GLOBAL_FRONT":
      return `A widespread latency front: ${d.count ?? "several"} regions disturbed simultaneously (${d.regionNames ?? "multiple regions"}). Expect sluggish conditions if your packets are travelling that way.`;
    default:
      return `BGP event on ${where}.`;
  }
}

const SYSTEM_PROMPT = `You are the presenter of the "BGP Weather Channel", narrating live events on the global internet routing system. Voice: BBC weather presenter crossed with a senior network engineer — dry, precise, lightly witty, never alarmist, never tabloid.

Rules:
- 2 to 4 sentences, plain text only. No markdown, no emoji, no headers.
- Be technically accurate. Write ASNs as "AS13335" and prefixes like "1.1.1.0/24".
- Always hedge on cause: say what it MIGHT be (a leak, a hijack, a maintenance window going sideways, a typo in a router config) — you observe symptoms, you do not attribute blame.
- Severity 3 events are serious weather; severity 1 is a passing shower. Match your tone.
- For CALM_SUMMARY events, do gentle colour commentary on a quiet hour using the counters provided.
- For latency events (LATENCY_STORM, LOSS_SQUALL, CLEARING, GLOBAL_FRONT) use a forecast register: regional weather language about how the internet FEELS — e.g. "a band of heavy latency moving across US-East this evening, round-trips up forty percent on seasonal norms; expect sluggish conditions if your packets are travelling that way." Percentages are deviations from that region's own normal, never raw milliseconds.`;

const GLOSSARY: Record<string, string> = {
  ORIGIN_CHANGE: "ORIGIN_CHANGE: a watched prefix was announced by an origin AS that is not its expected owner — the classic signature of a hijack or a fat-fingered config.",
  MORE_SPECIFIC: "MORE_SPECIFIC: someone announced a smaller, more-specific prefix inside a watched block — more-specifics win routing, so this redirects traffic. Can also be legitimate traffic engineering.",
  WITHDRAWAL_STORM: "WITHDRAWAL_STORM: many BGP peers withdrew the route within a minute — the prefix is vanishing from the global routing table (like Facebook, October 2021).",
  FLAP: "FLAP: the route was announced and withdrawn repeatedly within minutes — unstable, often a struggling router or circuit.",
  PATH_ANOMALY: "PATH_ANOMALY: the AS path looks unusual — much longer than normal (heavy prepending or a leak) or containing a non-consecutive repeated ASN.",
  CALM_SUMMARY: "CALM_SUMMARY: nothing notable happened in the past hour; these are aggregate statistics for colour commentary (may include latency aggregates from the RIPE Atlas channel).",
  LATENCY_STORM: "LATENCY_STORM: a region's round-trip times (measured by RIPE Atlas probes pinging anchors there) rose well above that region's own baseline, or packet loss climbed — the internet feels slow there right now.",
  LOSS_SQUALL: "LOSS_SQUALL: packet loss in a region jumped sharply within one ~2-minute observation cycle, even though latency may look normal — often congestion or a failing link.",
  CLEARING: "CLEARING: a region's latency has returned to its normal baseline after a sustained disturbance — a recovery story.",
  GLOBAL_FRONT: "GLOBAL_FRONT: three or more regions are disturbed simultaneously — a widespread front rather than a local shower.",
};

export interface NarrateOptions {
  apiKey: string | undefined;
  enabled: boolean;
  allowed: boolean;          // budget decision, precomputed via canNarrateFromCounts
  fetchImpl?: typeof fetch;  // injectable for tests
}

export async function narrate(
  ev: NewEvent | BgpEvent,
  opts: NarrateOptions,
): Promise<{ text: string; narrated: boolean }> {
  const fallback = { text: templateFor(ev), narrated: false };
  if (!opts.enabled || !opts.apiKey || !opts.allowed) return fallback;

  const userMessage =
    `${GLOSSARY[ev.kind] ?? ""}\n` +
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
    // The caller marks narrated=1 in D1 — that row IS the budget record.
    return { text, narrated: true };
  } catch (err) {
    console.log("narration failed:", err);
    return fallback;
  }
}
