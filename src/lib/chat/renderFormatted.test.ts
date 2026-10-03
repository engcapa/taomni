import { describe, expect, it } from "vitest";
import { renderFormatted } from "./renderFormatted";

describe("renderFormatted", () => {
  it("renders Markdown to sanitised HTML", () => {
    const html = renderFormatted("# Hello\n\nA **bold** *world*.", "md");
    expect(html).not.toBeNull();
    expect(html).toContain("<h1");
    expect(html).toContain("Hello");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>world</em>");
  });

  it("renders fenced code blocks with language class", () => {
    const html = renderFormatted("```js\nconsole.log(1)\n```", "md");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    // marked emits class="language-js"
    expect(html).toContain("language-js");
  });

  it("strips <script> tags from Markdown output", () => {
    const html = renderFormatted("<script>alert(1)</script>\n\nHi", "md");
    expect(html ?? "").not.toContain("<script");
    expect(html ?? "").not.toContain("alert(1)");
  });

  it("strips javascript: URLs from links", () => {
    const html = renderFormatted("[click](javascript:alert(1))", "md") ?? "";
    expect(html).not.toContain("javascript:");
  });

  it("forces target=_blank rel=noopener on anchors", () => {
    const html = renderFormatted("[home](https://example.com)", "md") ?? "";
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("treats html mode as already-HTML and still sanitises", () => {
    const html = renderFormatted(
      "<p>ok</p><img src=x onerror=alert(1)><script>1</script>",
      "html",
    ) ?? "";
    expect(html).toContain("<p>ok</p>");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
  });

  it("returns null for plain so the caller renders raw text", () => {
    expect(renderFormatted("# Heading", "plain")).toBeNull();
  });

  it("blocks inline event handlers in HTML mode", () => {
    const html = renderFormatted('<div onclick="x()">hi</div>', "html") ?? "";
    expect(html).not.toContain("onclick");
    expect(html).toContain("hi");
  });
});
