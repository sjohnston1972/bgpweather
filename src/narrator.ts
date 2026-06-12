// AI commentary with hard cost caps. Detection never depends on this module
// succeeding: every path that can fail returns a template string instead.
// Pure-ish: fetch is injectable so tests never hit the network.

import { CONFIG } from "./config";
import type { BgpEvent, EventKind, NewEvent, Severity } from "./types";

const HOUR = 3_600_000;

// Sliding-window budget. Non-sev3 events get 8/hour; severity 3 can spend the
// full 12 ("jumps the queue"). Calm summaries have a separate 1/hour cap.
export class NarrationBudget {
  private stamps: { ts: number; sev: Severity }[] = [];
  private calmStamps: number[] = [];

  canNarrate(sev: Severity, kind: EventKind, now: number): boolean {
    this.prune(now);
    if (kind === "CALM_SUMMARY") return this.calmStamps.length < CONFIG.narration.calmMaxPerHour;
    if (this.stamps.length >= CONFIG.narration.maxPerHour) return false;
    if (sev < 3) {
      const nonSev3 = this.stamps.filter((s) => s.sev < 3).length;
      if (nonSev3 >= CONFIG.narration.maxNonSev3PerHour) return false;
    }
    return true;
  }

  record(sev: Severity, kind: EventKind, now: number): void {
    if (kind === "CALM_SUMMARY") this.calmStamps.push(now);
    else this.stamps.push({ ts: now, sev });
  }

  remaining(now: number): number {
    this.prune(now);
    return Math.max(0, CONFIG.narration.maxPerHour - this.stamps.length);
  }

  private prune(now: number): void {
    this.stamps = this.stamps.filter((s) => now - s.ts < HOUR);
    this.calmStamps = this.calmStamps.filter((ts) => now - ts < HOUR);
  }

  toJSON(): { stamps: { ts: number; sev: Severity }[]; calm: number[] } {
    return { stamps: this.stamps, calm: this.calmStamps };
  }

  static fromJSON(j?: { stamps?: { ts: number; sev: Severity }[]; calm?: number[] } | null): NarrationBudget {
    const b = new NarrationBudget();
    if (j) {
      b.stamps = j.stamps ?? [];
      b.calmStamps = j.calm ?? [];
    }
    return b;
  }
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
- For CALM_SUMMARY events, do gentle colour commentary on a quiet hour using the counters provided.`;

const GLOSSARY: Record<string, string> = {
  ORIGIN_CHANGE: "ORIGIN_CHANGE: a watched prefix was announced by an origin AS that is not its expected owner — the classic signature of a hijack or a fat-fingered config.",
  MORE_SPECIFIC: "MORE_SPECIFIC: someone announced a smaller, more-specific prefix inside a watched block — more-specifics win routing, so this redirects traffic. Can also be legitimate traffic engineering.",
  WITHDRAWAL_STORM: "WITHDRAWAL_STORM: many BGP peers withdrew the route within a minute — the prefix is vanishing from the global routing table (like Facebook, October 2021).",
  FLAP: "FLAP: the route was announced and withdrawn repeatedly within minutes — unstable, often a struggling router or circuit.",
  PATH_ANOMALY: "PATH_ANOMALY: the AS path looks unusual — much longer than normal (heavy prepending or a leak) or containing a non-consecutive repeated ASN.",
  CALM_SUMMARY: "CALM_SUMMARY: nothing notable happened in the past hour; these are aggregate statistics for colour commentary.",
};

export interface NarrateOptions {
  apiKey: string | undefined;
  enabled: boolean;
  budget: NarrationBudget;
  now: number;
  fetchImpl?: typeof fetch;  // injectable for tests
}

export async function narrate(
  ev: NewEvent | BgpEvent,
  opts: NarrateOptions,
): Promise<{ text: string; narrated: boolean }> {
  const fallback = { text: templateFor(ev), narrated: false };
  if (!opts.enabled || !opts.apiKey) return fallback;
  if (!opts.budget.canNarrate(ev.severity, ev.kind, opts.now)) return fallback;

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
    opts.budget.record(ev.severity, ev.kind, opts.now);  // only successful narrations consume budget
    return { text, narrated: true };
  } catch (err) {
    console.log("narration failed:", err);
    return fallback;
  }
}
