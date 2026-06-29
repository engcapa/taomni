import { describe, expect, it } from "vitest";
import { normalizeWhitespace, buildDiffOverride } from "./diffWhitespace";

describe("normalizeWhitespace", () => {
  it("is identity for mode none", () => {
    const r = normalizeWhitespace("a b\tc", "none");
    expect(r.norm).toBe("a b\tc");
    expect(r.map).toEqual([0, 1, 2, 3, 4]);
  });

  it("drops all spaces and tabs for mode all but keeps newlines", () => {
    const r = normalizeWhitespace("a b\tc\n", "all");
    expect(r.norm).toBe("abc\n");
    expect(r.map).toEqual([0, 2, 4, 5]);
  });

  it("drops only trailing whitespace for mode trailing", () => {
    const r = normalizeWhitespace("a \nb  \n", "trailing");
    expect(r.norm).toBe("a\nb\n");
    expect(r.map).toEqual([0, 2, 3, 6]);
  });

  it("keeps interior whitespace for mode trailing", () => {
    const r = normalizeWhitespace("a b \n", "trailing");
    expect(r.norm).toBe("a b\n");
  });
});

describe("buildDiffOverride", () => {
  it("returns undefined for mode none", () => {
    expect(buildDiffOverride("none")).toBeUndefined();
  });

  it("reports no change when only whitespace differs (mode all)", () => {
    const override = buildDiffOverride("all")!;
    expect(override("a b", "ab")).toHaveLength(0);
  });

  it("maps real changes back to original offsets (mode all)", () => {
    const override = buildDiffOverride("all")!;
    const changes = override("a b", "a c");
    expect(changes).toHaveLength(1);
    expect(changes[0].fromA).toBe(2);
    expect(changes[0].toA).toBe(3);
    expect(changes[0].fromB).toBe(2);
    expect(changes[0].toB).toBe(3);
  });
});
