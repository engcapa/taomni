import { expect, it } from "vitest";
import { captureWordTextLayout } from "./wordSvgText";

function fixture(content: string) {
  const svg = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`, "image/svg+xml").documentElement as unknown as SVGSVGElement;
  const owner = svg.querySelector("text")!;
  Object.assign(owner, {
    getNumberOfChars: () => owner.textContent!.length,
    getStartPositionOfChar: (index: number) => ({ x: -48 + index * 16, y: index < 4 ? 12 : 32 }),
  });
  return { svg, owner };
}

it("retains CJK glyph positions, Latin runs, label text, paint and multiline baselines", () => {
  const { svg, owner } = fixture('<text id="label" transform="translate(100 20)" y="-10" text-anchor="middle"><tspan fill="navy">评估目标</tspan><tspan fill="blue" font-weight="700">是否达成?</tspan><tspan font-style="italic"> (Tool Call)</tspan></text>');
  const source = owner.outerHTML;
  const apply = captureWordTextLayout(svg);
  expect(owner.outerHTML).toBe(source);
  // Presentation attributes are frozen between measurement and application.
  owner.querySelector("tspan")!.setAttribute("font-family", "Trebuchet MS, sans-serif");
  apply();
  expect(owner.textContent).toBe("评估目标是否达成? (Tool Call)");
  expect(owner.id).toBe("label");
  expect(owner.getAttribute("transform")).toBe("translate(100 20)");
  expect(owner.hasAttribute("y")).toBe(false);
  expect(owner.firstElementChild?.getAttribute("x")).toBe("-48");
  expect(owner.firstElementChild?.getAttribute("y")).toBe("12");
  expect(owner.firstElementChild?.getAttribute("font-family")).toBe("Trebuchet MS, sans-serif");
  const secondLine = Array.from(owner.children).find(span => span.textContent === "是")!;
  expect(secondLine.getAttribute("y")).toBe("32");
  expect(secondLine.getAttribute("fill")).toBe("blue");
  expect(secondLine.getAttribute("font-weight")).toBe("700");
  expect(owner.lastElementChild?.textContent).toBe(" (Tool Call)");
  expect(owner.lastElementChild?.getAttribute("font-style")).toBe("italic");
  expect(Array.from(owner.children).every(span => span.getAttribute("text-anchor") === "start")).toBe(true);
});

it.each(["Plain Latin office", "中文 مع العربية", "中文 e\u0301", "中文 हिन्दी"])("keeps contextual or unrelated SVG text unchanged: %s", (value) => {
  const { svg, owner } = fixture(`<text x="10"><tspan>${value}</tspan></text>`);
  const before = owner.outerHTML;
  captureWordTextLayout(svg)();
  expect(owner.outerHTML).toBe(before);
});

it("preserves a complete label when character metrics are missing or inconsistent", () => {
  const { svg, owner } = fixture('<text><tspan>原始 中文</tspan></text>');
  const before = owner.outerHTML;
  Object.assign(owner, { getNumberOfChars: () => 3 });
  captureWordTextLayout(svg)();
  expect(owner.outerHTML).toBe(before);
  Object.assign(owner, { getNumberOfChars: () => owner.textContent!.length, getStartPositionOfChar: () => ({ x: NaN, y: 0 }) });
  captureWordTextLayout(svg)();
  expect(owner.outerHTML).toBe(before);
});

it("keeps a supplementary character intact beside a CJK label", () => {
  const { svg, owner } = fixture('<text>用户😀完成</text>');
  captureWordTextLayout(svg)();
  expect(owner.textContent).toBe("用户😀完成");
  expect(Array.from(owner.children).map(span => span.textContent)).toEqual(["用", "户", "😀", "完", "成"]);
});
