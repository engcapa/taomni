import { describe, expect, it } from "vitest";
import {
  formatMailPlainTextHtml,
  parseMailPlainTextLines,
  splitMailPlainTextLinks,
} from "./mailPlainText";

describe("mailPlainText", () => {
  it("parses nested quote levels like Thunderbird", () => {
    const lines = parseMailPlainTextLines("Hello\n> level one\n>> level two\n\nBye");
    expect(lines).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "quote", level: 1, mark: "> ", text: "level one" },
      { kind: "quote", level: 2, mark: ">> ", text: "level two" },
      { kind: "blank" },
      { kind: "text", text: "Bye" },
    ]);
  });

  it("autolinks http and email addresses", () => {
    const parts = splitMailPlainTextLinks("See https://example.com/a. and mail me@x.com please");
    expect(parts.some((part) => part.type === "link" && part.href === "https://example.com/a")).toBe(true);
    expect(parts.some((part) => part.type === "link" && part.href === "mailto:me@x.com")).toBe(true);
  });

  it("formats plain text to HTML with quote classes", () => {
    const html = formatMailPlainTextHtml("Hi\n> quoted");
    expect(html).toContain('class="mail-line"');
    expect(html).toContain("mail-quote-1");
    expect(html).toContain("quoted");
    expect(html).not.toContain("<script");
  });
});
