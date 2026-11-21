import { describe, expect, it } from "vitest";
import { changedLineIndexes } from "./extraCommands";

describe("notepad extra command helpers", () => {
  it("reports changed, added and removed line indexes for change-history navigation", () => {
    expect(changedLineIndexes("a\nb", "a\nb")).toEqual([]);
    expect(changedLineIndexes("a\nB", "a\nb")).toEqual([1]);
    expect(changedLineIndexes("a\nb\nc", "a\nb")).toEqual([2]);
    expect(changedLineIndexes("a\nb", "a\nb\nc")).toEqual([2]);
    expect(changedLineIndexes("x\ny", "a\nb")).toEqual([0, 1]);
  });
});
