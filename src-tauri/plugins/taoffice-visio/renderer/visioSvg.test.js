import { describe, expect, it } from "vitest";
import { preparePage } from "./visioSvg.js";

const namespace = "http://www.w3.org/2000/svg";

function page(markup) {
  return preparePage({ name: "Routing", svg: markup });
}

describe("Visio SVG", () => {
  it("retains local paint, geometry, text and embedded bitmaps for the view and export", () => {
    const result = page(`<svg xmlns="${namespace}" xmlns:xlink="http://www.w3.org/1999/xlink"
      width="8in" height="4in" viewBox="0 0 576 288">
      <defs><linearGradient id="fill"><stop offset="0" stop-color="#fc0"/></linearGradient></defs>
      <path d="M0 0 L40 40" style="fill: url(#fill); stroke: none" />
      <text xml:space="preserve">Ａpproval    Lane</text>
      <image xlink:href="data:image/png;base64,AAA=" width="2" height="2"/>
    </svg>`);
    expect(result).toMatchObject({ name: "Routing", width: 768, height: 384, text: "approval lane" });
    expect(result.svg).toContain('width="768" height="384"');
    expect(result.svg).toContain("fill: url(#fill)");
    expect(result.svg).toContain('d="M0 0 L40 40"');
    expect(result.svg).toContain('xml:space="preserve"');
    expect(result.svg).toContain("data:image/png;base64,AAA=");
  });

  it("removes active content and references outside the exported page", () => {
    const result = page(`<svg xmlns="${namespace}" xml:base="https://invalid.example/" viewBox="0 0 10 20"
      onload="alert(1)">
      <script>window.invalid = true</script>
      <style>@import 'https://invalid.example/theme.css';</style>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>
      <image href="data:image/svg+xml;base64,AAA="/>
      <use href="https://invalid.example/colors.svg#fill"/>
      <rect width="5" height="10" fill="url(https://invalid.example/fill)"
        style="stroke: #123456; filter: url(https://invalid.example/filter)"/>
    </svg>`);
    expect(result.svg).toContain("stroke: #123456");
    expect(result.svg).not.toMatch(/invalid\.example|xml:base|onload|<script|<style|foreignObject|data:image\/svg|href|filter/);
  });

  it.each(["0 0 0 10", "0 0 10 Infinity", "0 0 144001 10"])("rejects an invalid page size %s", (viewBox) => {
    expect(() => page(`<svg xmlns="${namespace}" viewBox="${viewBox}"/>`)).toThrow("format");
  });

  it("rejects XML declarations that introduce a document type or entities", () => {
    const source = `<!DOCTYPE svg [<!ENTITY title "Header">]><svg xmlns="${namespace}" viewBox="0 0 1 1"/>`;
    expect(() => page(source)).toThrow("format");
  });
});
