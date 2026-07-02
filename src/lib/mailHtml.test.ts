import { describe, expect, it } from "vitest";
import {
  buildReplyHtml,
  hasRichMailFormatting,
  mailHtmlToPlainText,
  plainTextToMailHtml,
  sanitizeMailComposeHtml,
  sanitizeMailDisplayHtml,
} from "./mailHtml";

describe("mailHtml", () => {
  it("sanitizes unsafe tags, attributes, and inline styles while keeping safe formatting", () => {
    const html = sanitizeMailComposeHtml(`
      <p onclick="alert(1)" style="color: #123456; position: fixed; background-image: url(javascript:alert(1))">
        Hello <strong>team</strong><script>alert(1)</script>
      </p>
      <a href="https://example.com" onmouseover="alert(1)">link</a>
    `);

    expect(html).toContain("Hello <strong>team</strong>");
    expect(html).toContain("style=\"color: #123456\"");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("rel=\"noopener noreferrer\"");
    expect(html).not.toContain("script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onmouseover");
    expect(html).not.toContain("position");
    expect(html).not.toContain("background-image");
  });

  it("blocks remote images for display until explicitly allowed", () => {
    const blocked = sanitizeMailDisplayHtml("<p>before<img src=\"https://example.com/a.png\" alt=\"x\">after</p>", false);
    const allowed = sanitizeMailDisplayHtml("<p>before<img src=\"https://example.com/a.png\" alt=\"x\">after</p>", true);

    expect(blocked).toContain("[image blocked]");
    expect(blocked).not.toContain("<img");
    expect(allowed).toContain("<img");
    expect(allowed).toContain("https://example.com/a.png");
  });

  it("round-trips plain text through mail HTML and extracts readable text from lists and paragraphs", () => {
    expect(plainTextToMailHtml("Hello\nWorld")).toBe("<p>Hello<br>World</p>");

    const text = mailHtmlToPlainText("<p>Hello<br>World</p><ul><li>One</li><li>Two</li></ul>");
    expect(text).toBe("Hello\nWorld\n* One\n* Two");
  });

  it("detects whether auto send mode should include an HTML body", () => {
    expect(hasRichMailFormatting("<p>Hello<br>World</p>")).toBe(false);
    expect(hasRichMailFormatting("<p><strong>Hello</strong></p>")).toBe(true);
    expect(hasRichMailFormatting("<p style=\"color: #111111\">Hello</p>")).toBe(true);
    expect(hasRichMailFormatting("<ul><li>Hello</li></ul>")).toBe(true);
  });

  it("builds a sanitized Thunderbird-style reply quote that preserves original HTML", () => {
    const html = buildReplyHtml(
      "On July 2, Alice wrote:",
      { html: "<p><b>Hello</b><script>alert(1)</script></p>" },
      "Best,\nMe",
    );

    expect(html).toContain("-- <br>Best,<br>Me");
    expect(html).toContain("On July 2, Alice wrote:");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<b>Hello</b>");
    expect(html).not.toContain("script");
  });
});
