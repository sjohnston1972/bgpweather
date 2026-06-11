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
    narrated: Number(row.narrated) === 1, replay: Number(row.replay) === 1,
  };
}
