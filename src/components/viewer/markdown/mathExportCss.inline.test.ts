import { afterEach, expect, it, vi } from "vitest";
import { mathExportCss } from "./mathExportCss";

const embeddedFont = "data:font/woff2;base64,d09GMg==";
vi.mock("katex/dist/katex.min.css?inline", () => ({ default: '@font-face{font-family:KaTeX_Size4;src:url("data:font/woff2;base64,d09GMg==")format("woff2"),url("unused.ttf")format("truetype")}.katex{line-height:1.2}' }));

afterEach(() => vi.unstubAllGlobals());

it("reuses font bytes already embedded by Vite when native CSP rejects data fetch", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("Load failed"));
  vi.stubGlobal("fetch", fetch);
  const root = document.createElement("div");
  root.innerHTML = '<span class="katex">x</span>';
  const css = await mathExportCss(root);
  expect(css).toContain(embeddedFont);
  expect(css).toContain(".katex{line-height:1.2}");
  expect(css).not.toContain("unused.ttf");
  expect(fetch).not.toHaveBeenCalled();
});

it("leaves documents without math independent of font resources", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await mathExportCss(document.createElement("div"))).toBe("");
  expect(fetch).not.toHaveBeenCalled();
});
