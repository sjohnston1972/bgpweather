import { describe, expect, it } from "vitest";
import { parsePrefix, isWithin, isMoreSpecific } from "../src/prefix";

describe("parsePrefix", () => {
  it("parses a /24", () => {
    expect(parsePrefix("1.1.1.0/24")).toEqual({ base: ((1 << 24) | (1 << 16) | (1 << 8)) >>> 0, len: 24 });
  });
  it("masks host bits to the network address", () => {
    expect(parsePrefix("10.0.0.255/24")).toEqual(parsePrefix("10.0.0.0/24"));
  });
  it("returns null for IPv6 (v1 is v4-only)", () => {
    expect(parsePrefix("2001:db8::/32")).toBeNull();
  });
  it("returns null for garbage and out-of-range", () => {
    expect(parsePrefix("not-a-prefix")).toBeNull();
    expect(parsePrefix("1.2.3.300/24")).toBeNull();
    expect(parsePrefix("1.2.3.0/33")).toBeNull();
  });
  it("handles /8 and /32 and high octets (unsigned math)", () => {
    expect(parsePrefix("17.0.0.0/8")).toEqual({ base: 17 * 2 ** 24, len: 8 });
    expect(parsePrefix("202.12.27.1/32")!.len).toBe(32);
    expect(parsePrefix("202.12.27.0/24")!.base).toBeGreaterThan(0); // 202 sets the sign bit if done signed
  });
});

describe("containment", () => {
  const p22 = parsePrefix("208.65.152.0/22")!;
  it("a /24 inside the /22 is within and more specific", () => {
    const child = parsePrefix("208.65.153.0/24")!;
    expect(isWithin(child, p22)).toBe(true);
    expect(isMoreSpecific(child, p22)).toBe(true);
  });
  it("the same prefix is within but NOT more specific", () => {
    expect(isMoreSpecific(parsePrefix("208.65.152.0/22")!, p22)).toBe(false);
    expect(isWithin(parsePrefix("208.65.152.0/22")!, p22)).toBe(true);
  });
  it("a sibling /24 outside is neither", () => {
    expect(isWithin(parsePrefix("208.65.156.0/24")!, p22)).toBe(false);
  });
  it("a covering /16 is not within the /22", () => {
    expect(isWithin(parsePrefix("208.65.0.0/16")!, p22)).toBe(false);
  });
});
