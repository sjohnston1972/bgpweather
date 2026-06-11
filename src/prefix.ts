// Tiny IPv4 prefix math. v1 is IPv4-only: parsePrefix returns null for anything
// else and callers skip those prefixes. All math is unsigned 32-bit (>>> 0)
// because JS bitwise ops are otherwise signed and 202.x.x.x would go negative.

export interface ParsedPrefix { base: number; len: number }

export function parsePrefix(p: string): ParsedPrefix | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(p);
  if (!m) return null;
  const [a, b, c, d, len] = m.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255 || len > 32) return null;
  const ip = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
  return { base: (ip & mask) >>> 0, len };
}

export function isWithin(child: ParsedPrefix, parent: ParsedPrefix): boolean {
  if (child.len < parent.len) return false;
  const mask = parent.len === 0 ? 0 : (~0 << (32 - parent.len)) >>> 0;
  return ((child.base & mask) >>> 0) === parent.base;
}

// Strictly more specific: inside the parent AND a longer mask.
export function isMoreSpecific(child: ParsedPrefix, parent: ParsedPrefix): boolean {
  return child.len > parent.len && isWithin(child, parent);
}
