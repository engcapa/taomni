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
