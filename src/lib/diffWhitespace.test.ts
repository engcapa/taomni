import { describe, expect, it } from "vitest";
import {
  normalizeWhitespace,
  buildDiffOverride,
  detectLineEndingStyle,
  isEolOnlyDiff,
  eolOnlyDiffLabel,
  normalizeWorktreeToMatchHead,
  stripLineEndings,
} from "./diffWhitespace";

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

describe("EOL-only diagnosis (issue #324 B2)", () => {
  it("detects LF vs CRLF styles", () => {
    expect(detectLineEndingStyle("a\nb\n")).toBe("LF");
    expect(detectLineEndingStyle("a\r\nb\r\n")).toBe("CRLF");
    expect(detectLineEndingStyle("a\rb\r")).toBe("CR");
    expect(detectLineEndingStyle("a\nb\r\n")).toBe("mixed");
  });

  it("flags pairs that differ only by line endings", () => {
    expect(isEolOnlyDiff("a\nb\n", "a\r\nb\r\n")).toBe(true);
    expect(isEolOnlyDiff("a\nb\n", "a\nb\n")).toBe(false);
    expect(isEolOnlyDiff("a\nb\n", "a\nc\n")).toBe(false);
    expect(isEolOnlyDiff(null, "a\n")).toBe(false);
  });

  it("labels EOL-only pairs with from→to styles", () => {
    expect(eolOnlyDiffLabel("a\nb", "a\r\nb")).toContain("LF");
    expect(eolOnlyDiffLabel("a\nb", "a\r\nb")).toContain("CRLF");
  });

  it("normalizes worktree text to HEAD bytes for EOL-only pairs", () => {
    const head = "line1\nline2\n";
    const worktree = "line1\r\nline2\r\n";
    expect(stripLineEndings(worktree)).toBe(stripLineEndings(head));
    expect(normalizeWorktreeToMatchHead(head, worktree)).toBe(head);
    expect(normalizeWorktreeToMatchHead(head, "line1\nchanged\n")).toBeNull();
  });
});
