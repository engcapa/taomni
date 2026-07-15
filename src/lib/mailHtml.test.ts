import { describe, expect, it } from "vitest";
import {
  buildInlineImageHtml,
  buildReplyHtml,
  hasRichMailFormatting,
  isRemoteMailImageSrc,
  mailHtmlHasRemoteImages,
  mailHtmlToPlainText,
  plainTextToMailHtml,
  prepareMailHtmlForSend,
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

  it("blocks only remote images for display until explicitly allowed (Thunderbird-style)", () => {
    const mixed = [
      "<p>before",
      "<img src=\"https://example.com/a.png\" alt=\"remote\">",
      "<img src=\"cid:logo@inline.local\" alt=\"embedded\">",
      "<img src=\"data:image/png;base64,aaaa\" alt=\"data\">",
      "after</p>",
    ].join("");

    const blocked = sanitizeMailDisplayHtml(mixed, false);
    const allowed = sanitizeMailDisplayHtml(mixed, true);

    expect(blocked).toContain("[remote image blocked]");
    expect(blocked).not.toContain("https://example.com/a.png");
    expect(blocked).toContain("cid:logo@inline.local");
    expect(blocked).toContain("data:image/png;base64,aaaa");
    expect(allowed).toContain("https://example.com/a.png");
    expect(allowed).toContain("cid:logo@inline.local");
    expect(isRemoteMailImageSrc("https://cdn.example/x.png")).toBe(true);
    expect(isRemoteMailImageSrc("cid:logo@inline.local")).toBe(false);
    expect(isRemoteMailImageSrc("data:image/png;base64,aa")).toBe(false);
    expect(mailHtmlHasRemoteImages(mixed)).toBe(true);
    expect(mailHtmlHasRemoteImages("<p><img src=\"cid:x@y\"></p>")).toBe(false);
  });

  it("preserves compose CID/data images and safe inserted table styles", () => {
    const html = sanitizeMailComposeHtml(`
      <p><img src="cid:logo-1@inline.local" alt="logo"></p>
      <p><img src="data:image/png;base64,abcd" data-taomni-cid="paste-1@inline.local" alt="pasted"></p>
      <table style="border-collapse: collapse; position: fixed">
        <tbody><tr><td style="border: 1px solid #9ca3af; padding: 4px 8px; background-image: url(javascript:alert(1))">Cell</td></tr></tbody>
      </table>
    `);

    expect(html).toContain("src=\"cid:logo-1@inline.local\"");
    expect(html).toContain("data:image/png;base64,abcd");
    expect(html).toContain("data-taomni-cid=\"paste-1@inline.local\"");
    expect(html).toContain("border-collapse: collapse");
    expect(html).toContain("border: 1px solid #9ca3af");
    expect(html).toContain("padding: 4px 8px");
    expect(html).not.toContain("position");
    expect(html).not.toContain("background-image");
  });

  it("builds preview HTML and rewrites data-taomni-cid images to cid for send", () => {
    const preview = buildInlineImageHtml({
      contentId: "logo-1@inline.local",
      dataUrl: "data:image/png;base64,abcd",
      alt: "logo",
    });
    expect(preview).toContain("data:image/png;base64,abcd");
    expect(preview).toContain("data-taomni-cid=\"logo-1@inline.local\"");

    const forSend = prepareMailHtmlForSend(`<p>${preview}</p>`);
    expect(forSend).toContain("src=\"cid:logo-1@inline.local\"");
    expect(forSend).not.toContain("data:image");
    expect(forSend).not.toContain("data-taomni-cid");
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
