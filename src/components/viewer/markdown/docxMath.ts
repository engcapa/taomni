import type { MathComponent, ParagraphChild, RunOptions } from "./docxRuntime.js";

type DocxRuntime = typeof import("./docxRuntime.js");

/** KaTeX contains parallel MathML, TeX annotation and visual HTML. Consume the
 * semantic tree once; walking all three representations duplicates formulas. */
export function wordEquation(node: Element, d: DocxRuntime, style: RunOptions): ParagraphChild | null {
  if (!node.matches(".fv-md-math,.katex")) return null;
  const math = node.querySelector("math");
  const source = math?.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
  const convert = (element: Element): MathComponent[] | null => {
    const tag = element.localName;
    if (["mi", "mn", "mo", "mtext"].includes(tag)) return [new d.MathRun(element.textContent || "")];
    if (tag === "mspace") return [new d.MathRun(" ")];
    if (tag === "semantics") return element.firstElementChild ? convert(element.firstElementChild) : [];
    const parts = Array.from(element.children).map(convert);
    if (parts.some((part) => part === null)) return null;
    const children = parts as MathComponent[][];
    if (["math", "mrow", "mstyle"].includes(tag)) return children.flat();
    if (tag === "mfrac" && children.length === 2) return [new d.MathFraction({
      numerator: children[0], denominator: children[1],
      ...(element.getAttribute("linethickness") === "0px" ? { type: "noBar" as const } : {}),
    })];
    if (tag === "msup" && children.length === 2) return [new d.MathSuperScript({ children: children[0], superScript: children[1] })];
    if (tag === "msub" && children.length === 2) return [new d.MathSubScript({ children: children[0], subScript: children[1] })];
    if (tag === "msubsup" && children.length === 3) return [new d.MathSubSuperScript({ children: children[0], subScript: children[1], superScript: children[2] })];
    if (tag === "msqrt") return [new d.MathRadical({ children: children.flat() })];
    if (tag === "mroot" && children.length === 2) return [new d.MathRadical({ children: children[0], degree: children[1] })];
    // Unsupported structures must not silently flatten matrices/accents/limits.
    // Preserve the complete original TeX once instead of dropping information.
    return null;
  };
  const children = math ? convert(math) : null;
  if (children?.length) return new d.Math({ children });
  const error = node.querySelector(".katex-error");
  return new d.TextRun({ ...style, text: source || error?.textContent || node.textContent || "" });
}
