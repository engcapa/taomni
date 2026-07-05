import { describe, expect, it } from "vitest";
import { extractNoteUrls, findNoteUrlAtIndex, normalizeNoteUrl } from "./noteLinks";

describe("noteLinks", () => {
  it("normalizes http URLs and bare www URLs", () => {
    expect(normalizeNoteUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizeNoteUrl("www.example.com/path")).toBe("https://www.example.com/path");
    expect(normalizeNoteUrl("file:///tmp/demo")).toBeNull();
  });

  it("extracts URLs without trailing sentence punctuation", () => {
    const matches = extractNoteUrls("read https://example.com/a?b=1, then www.taomni.dev.");
    expect(matches.map((match) => match.raw)).toEqual(["https://example.com/a?b=1", "www.taomni.dev"]);
    expect(matches.map((match) => match.url)).toEqual(["https://example.com/a?b=1", "https://www.taomni.dev/"]);
  });

  it("finds the URL at a textarea cursor index", () => {
    const text = "see https://example.com/docs today";
    expect(findNoteUrlAtIndex(text, text.indexOf("example"))?.url).toBe("https://example.com/docs");
    expect(findNoteUrlAtIndex(text, 0)).toBeNull();
  });
});
