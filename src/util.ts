// Minimal ULID: 48-bit timestamp + 80 random bits, Crockford base32.
// Lexicographic order == creation order, which makes D1 ids sortable for free.

import type { BgpEvent } from "./types";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let t = now;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = B32[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let randPart = "";
  for (let i = 0; i < 16; i++) randPart += B32[rand[i] % 32];
  return timePart + randPart;
}

// Narration budget ledger: count AI-narrated rows from the last hour. Both
// Durable Objects call this before narrating, which makes the hourly caps
// genuinely global without coupling the DOs to each other.
export async function getNarrationCounts(db: D1Database, now: number): Promise<import("./narrator").NarrationCounts> {
  try {
    const row = await db.prepare(
      `SELECT
         SUM(CASE WHEN kind != 'CALM_SUMMARY' THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN kind != 'CALM_SUMMARY' AND severity < 3 THEN 1 ELSE 0 END) AS nonSev3,
         SUM(CASE WHEN kind = 'CALM_SUMMARY' THEN 1 ELSE 0 END) AS calm
       FROM events WHERE narrated = 1 AND ts > ?`,
    ).bind(now - 3_600_000).first<{ total: number | null; nonSev3: number | null; calm: number | null }>();
    return { total: row?.total ?? 0, nonSev3: row?.nonSev3 ?? 0, calm: row?.calm ?? 0 };
  } catch (err) {
    console.log("narration counts query failed:", err);
    // Fail closed-ish: pretend the budget is spent so an outage can't overspend.
    return { total: 99, nonSev3: 99, calm: 99 };
  }
}

// D1 returns flat rows; rebuild the BgpEvent shape (details is stored as JSON text).
export function rowToEvent(row: Record<string, unknown>): BgpEvent {
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(String(row.details ?? "{}")); } catch { /* keep {} */ }
  return {
    id: String(row.id), ts: Number(row.ts),
    kind: row.kind as BgpEvent["kind"], severity: Number(row.severity) as BgpEvent["severity"],
    prefix: row.prefix == null ? undefined : String(row.prefix),
    label: row.label == null ? undefined : String(row.label),
    details, commentary: String(row.commentary ?? ""),
    narrated: Number(row.narrated) === 1,
  };
}
