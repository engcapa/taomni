import { describe, expect, it } from "vitest";
import { enhanceMarkdownMath, replaceMarkdownMath, renderKatex } from "./markdownMath";

describe("KaTeX Markdown support", () => {
  it("recognizes inline and display formulas but ignores fenced code", () => {
    const result = replaceMarkdownMath("Inline $x^2$ and $$\\frac{1}{2}$$\n\n```math\n$not math$\n```");
    expect(result.formulas.map((item) => [item.source, item.display])).toEqual([["x^2", false], ["\\frac{1}{2}", true]]);
    expect(result.content).toContain("taomni-math-0");
    expect(result.content).toContain("$not math$");
  });
  it("renders safe KaTeX HTML/MathML and does not trust HTML commands", () => {
    const html = renderKatex("\\frac{1}{2}", true);
    expect(html).toContain("katex");
    expect(html).toContain("mathml");
    expect(renderKatex("\\htmlClass{evil}{x}", false)).toContain("\\htmlClass");
  });
  it("replaces formula tokens without touching code blocks", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>taomni-math-0</p><pre><code>taomni-math-0</code></pre>";
    enhanceMarkdownMath(root, [{ token: "taomni-math-0", source: "x^2", display: false }]);
    expect(root.querySelector("p .katex")).not.toBeNull();
    expect(root.querySelector("pre .katex")).toBeNull();
  });
});
