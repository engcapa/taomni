import { describe, expect, it } from "vitest";
import {
  buildLineRenderSpans,
  codePointRangeToUtf16,
  highlightSearchLine,
  languageForSearchPath,
  type SyntaxSpan,
} from "./searchLineHighlight";

describe("codePointRangeToUtf16", () => {
  it("maps CJK-aware code-point ranges onto UTF-16 indices", () => {
    const text = "变量 needle";
    // code points: 变 量 space n e e d l e
    const range = codePointRangeToUtf16(text, 3, 9);
    expect(text.slice(range.start, range.end)).toBe("needle");
  });
});

describe("buildLineRenderSpans", () => {
  it("marks the hit range and keeps surrounding syntax classes", () => {
    const text = "const needle = 1;";
    const syntax: SyntaxSpan[] = [
      { from: 0, to: 5, className: "tok-keyword" },
      { from: 15, to: 16, className: "tok-number" },
    ];
    // "needle" starts at code-point 6
    const spans = buildLineRenderSpans(text, 6, 12, syntax);
    expect(spans.map((s) => ({ text: s.text, hit: Boolean(s.hit), className: s.className }))).toEqual([
      { text: "const", hit: false, className: "tok-keyword" },
      { text: " ", hit: false, className: undefined },
      { text: "needle", hit: true, className: undefined },
      { text: " = ", hit: false, className: undefined },
      { text: "1", hit: false, className: "tok-number" },
      { text: ";", hit: false, className: undefined },
    ]);
  });

  it("merges adjacent spans that share the same style", () => {
    const text = "abcdef";
    const syntax: SyntaxSpan[] = [
      { from: 0, to: 2, className: "tok-string" },
      { from: 2, to: 4, className: "tok-string" },
    ];
    const spans = buildLineRenderSpans(text, 10, 10, syntax);
    expect(spans[0]).toEqual({ text: "abcd", className: "tok-string", hit: false });
  });
});

describe("highlightSearchLine", () => {
  it("applies TypeScript keyword highlighting around the hit", async () => {
    const language = await languageForSearchPath("src/demo.ts");
    expect(language).not.toBeNull();
    const text = "const needle = 1;";
    const spans = highlightSearchLine(text, 6, 12, language);
    const hit = spans.find((s) => s.hit);
    expect(hit?.text).toBe("needle");
    const keyword = spans.find((s) => s.className?.includes("tok-keyword"));
    expect(keyword?.text).toContain("const");
  });
});
