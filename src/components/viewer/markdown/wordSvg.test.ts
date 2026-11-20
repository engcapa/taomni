import { afterEach, expect, it, vi } from "vitest";
import { embeddedSvg, portableWordSvg } from "./wordSvg";

afterEach(() => vi.restoreAllMocks());
it("freezes readable label styles and relative text coordinates for Word without altering the source", async () => {
  const svg = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><style>.label{fill:white}</style><text class="label"><tspan y="-0.1em" dy="1.1em">中文 Label</tspan></text></svg>', "image/svg+xml").documentElement;
  const before = svg.outerHTML;
  const paint: Record<string, string> = { "font-size": "20px", "fill": "rgb(31, 41, 55)", "font-family": "Arial, sans-serif", "stroke": "none" };
  vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ getPropertyValue: (name: string) => paint[name] || "" }) as CSSStyleDeclaration);
  const result = new DOMParser().parseFromString(await portableWordSvg(svg, 300, 100, false), "image/svg+xml");
  expect(result.querySelector("style")).toBeNull();
  expect(result.querySelector("text")?.getAttribute("fill")).toBe("rgb(31, 41, 55)");
  expect(result.querySelector("tspan")?.getAttribute("font-size")).toBe("20px");
  expect(result.querySelector("tspan")?.getAttribute("y")).toBe("-2");
  expect(result.querySelector("tspan")?.getAttribute("dy")).toBe("22");
  expect(svg.outerHTML).toBe(before);
  expect(document.body.children).toHaveLength(0);
});
it("places a sequence actor's effective tspan paint on the text owner for Office", async () => {
  const svg = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><text class="actor"><tspan>用户 User</tspan></text></svg>', "image/svg+xml").documentElement;
  vi.spyOn(window, "getComputedStyle").mockImplementation((node) => ({ getPropertyValue: (name: string) => name === "fill" ? (node.tagName === "text" ? "rgb(219, 234, 254)" : "rgb(23, 37, 84)") : name === "stroke" ? (node.tagName === "text" ? "rgb(37, 99, 235)" : "none") : "" }) as CSSStyleDeclaration);
  const result = new DOMParser().parseFromString(await portableWordSvg(svg, 300, 100, false), "image/svg+xml");
  expect(result.querySelector("text")?.getAttribute("fill")).toBe("rgb(23, 37, 84)");
  expect(result.querySelector("text")?.getAttribute("stroke")).toBe("none");
});
it("recognizes percent-encoded and base64 SVG image references as vectors", () => {
  const text = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120"><text>方框文字</text></svg>';
  const image = document.createElement("img");
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  expect(embeddedSvg(image)?.querySelector("text")?.textContent).toBe("方框文字");
  image.src = `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(text)))}`;
  expect(embeddedSvg(image)?.getAttribute("viewBox")).toBe("0 0 400 120");
  image.src = "data:image/png;base64,AQID";
  expect(embeddedSvg(image)).toBeUndefined();
});

it.each([['0px', 'none'], ['0px, 0px', 'none'], ['1px, 0px', 'none'], ['4px, 2px', '4 2'], ['3px', '3']])("writes Office-compatible solid/dashed strokes for %s", async (dash, expected) => {
  const svg = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L100 0" marker-end="url(#arrow)"/></svg>', "image/svg+xml").documentElement;
  vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ getPropertyValue: (name: string) => name === "stroke-dasharray" ? dash : name === "stroke" ? "#475569" : "" }) as CSSStyleDeclaration);
  const output = new DOMParser().parseFromString(await portableWordSvg(svg, 100, 50, false), "image/svg+xml");
  expect(output.querySelector("path")?.getAttribute("stroke-dasharray")).toBe(expected);
  expect(output.querySelector("path")?.getAttribute("stroke")).toBe("#475569");
  expect(output.querySelector("path")?.getAttribute("marker-end")).toBe("url(#arrow)");
});
