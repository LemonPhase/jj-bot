import { describe, expect, it } from "vitest";
import { ID_PREFIXES, newId, ulid } from "./ids";

describe("ids", () => {
  it("prefixes ids by record type", () => {
    expect(newId("task")).toMatch(/^task_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      newId("runtimeProfile").startsWith(`${ID_PREFIXES.runtimeProfile}_`),
    ).toBe(true);
    expect(new Set(Object.values(ID_PREFIXES)).size).toBe(
      Object.keys(ID_PREFIXES).length,
    );
  });

  it("sorts by creation time, including within one millisecond", () => {
    // Times after any real clock reading, so the module state starts fresh.
    const sameMs = Array.from({ length: 1000 }, () => ulid(4_000_000_000_000));
    expect([...sameMs].sort()).toEqual(sameMs);
    expect(new Set(sameMs).size).toBe(sameMs.length);
    const later = ulid(4_000_000_000_001);
    expect(later > (sameMs.at(-1) ?? "")).toBe(true);
    // A clock that steps back never produces an id that sorts earlier.
    const afterSkew = ulid(3_000_000_000_000);
    expect(afterSkew > later).toBe(true);
    expect(() => ulid(-1)).toThrow();
  });
});
