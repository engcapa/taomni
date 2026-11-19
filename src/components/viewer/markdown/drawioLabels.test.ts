import { expect, it } from "vitest";
import { safeDrawioLabel, safeDrawioSvg } from "./drawioLabels";

it("retains formatted label text without markup that loads external resources", () => {
  const label = safeDrawioLabel('<div style="font-weight:700;background:url(https://example.invalid/x);position:fixed"><i>Check</i><br><img src="https://example.invalid/y">here</div>');
  expect(label).toContain("<i>Check</i><br>here");
  expect(label).toContain("font-weight");
  expect(label).not.toMatch(/example\.invalid|position|<img/);
});

it("keeps the generated XHTML label namespace and removes external references", () => {
  const svg = safeDrawioSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><image href="https://example.invalid/image.png"/><switch><foreignObject width="90" height="50"><div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block"><b>Check</b><script>unsafe()</script></div></foreignObject><text>Check</text></switch></svg>');
  const label = svg.querySelector("foreignObject div");
  expect(label?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  expect(label?.querySelector("b")?.textContent).toBe("Check");
  expect(svg.querySelector("script,[href]")).toBeNull();
});

it("keeps a nonbreaking space in SVG text and XHTML labels after sanitization", () => {
  const raw = '<svg xmlns="http://www.w3.org/2000/svg"><text>Private&#160;network</text>'
    + '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Virtual&#160;network</div></foreignObject></svg>';
  const result = safeDrawioSvg(raw);
  expect(result.querySelector("text")?.textContent).toBe("Private\u00a0network");
  expect(result.querySelector("foreignObject div")?.textContent).toBe("Virtual\u00a0network");
  const serialized = new XMLSerializer().serializeToString(result);
  expect(new DOMParser().parseFromString(serialized, "image/svg+xml").querySelector("parsererror")).toBeNull();
});

it("keeps reused embedded images local to the rendered diagram", () => {
  const raw = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs>'
    + '<symbol id="shared"><image xlink:href="data:image/png;base64,AA=="/></symbol></defs>'
    + '<use xlink:href="#shared" x="10"/><use href="#shared" x="30"/><use href="#outside"/><use href="https://example.invalid/icon.svg"/></svg>';
  const first = safeDrawioSvg(raw);
  const second = safeDrawioSvg(raw);
  const id = first.querySelector("symbol")!.id;
  const references = Array.from(first.querySelectorAll("use"), (use) => [use.getAttribute("href"), use.getAttribute("x")]);
  expect(references).toEqual([[`#${id}`, "10"], [`#${id}`, "30"]]);
  expect(second.querySelector("symbol")?.id).not.toBe(id);
});
