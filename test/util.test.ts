import { describe, expect, it } from "vitest";
import { ulid } from "../src/util";

describe("ulid", () => {
  it("is 26 chars of Crockford base32", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("sorts by creation time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a < b).toBe(true);
  });
  it("is unique across calls", () => {
    expect(new Set(Array.from({ length: 100 }, () => ulid())).size).toBe(100);
  });
});
