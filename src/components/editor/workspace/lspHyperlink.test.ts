import { describe, expect, it } from "vitest";
import { identifierRangeAt } from "./lspHyperlink";

describe("identifierRangeAt", () => {
  it("finds a simple identifier under the caret", () => {
    expect(identifierRangeAt("foo.bar()", 5)).toEqual({ from: 4, to: 7 });
    expect(identifierRangeAt("foo.bar()", 4)).toEqual({ from: 4, to: 7 });
    expect(identifierRangeAt("foo.bar()", 7)).toEqual({ from: 4, to: 7 });
  });

  it("supports Java/TS-ish characters", () => {
    expect(identifierRangeAt("map.get($value)", 10)).toEqual({ from: 8, to: 14 });
    expect(identifierRangeAt("List<String>", 6)).toEqual({ from: 5, to: 11 });
  });

  it("returns null on punctuation or pure numbers", () => {
    expect(identifierRangeAt("a + b", 2)).toBeNull();
    expect(identifierRangeAt("x = 42;", 5)).toBeNull();
  });
});
