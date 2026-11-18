import { describe, expect, it } from "vitest";
import { deflateSync, strToU8 } from "fflate";
import { drawioCell, drawioFile, drawioLink, newDrawioPage, parseDrawio } from "./drawioCodec";
import { safeDrawioModel } from "./drawioRender";

describe("draw.io interoperable files and embedded links", () => {
  it("round trips Unicode, sheet names and geometry via standard compressed URLs", () => {
    const page = newDrawioPage("flow", '流程 <&> "工程"');
    drawioCell(page, { id: "a", vertex: 1, value: "可编辑 中文 café 😀", style: "rounded=1;" }, { x: 10, y: 20, width: 200, height: 80 });
    drawioCell(page, { id: "e", edge: 1, source: "a", target: "a" }, { relative: 1 });
    const xml = drawioFile([page]);
    const pages = parseDrawio(drawioLink(xml));
    expect(pages[0].name).toBe(page.name);
    expect(pages[0].model.querySelector("mxCell[id='a']")?.getAttribute("value")).toBe("可编辑 中文 café 😀");
    expect(pages[0].model.querySelector("mxCell[edge='1'] mxGeometry")?.getAttribute("relative")).toBe("1");
  });
  it("reads external compressed multi-sheet files and raw graph models", () => {
    const model = new XMLSerializer().serializeToString(newDrawioPage("a", "a").model);
    const compressed = btoa(String.fromCharCode(...deflateSync(strToU8(encodeURIComponent(model)))));
    expect(parseDrawio(`<mxfile><diagram id="a" name="Page A">${compressed}</diagram><diagram id="b" name="Page B">${compressed}</diagram></mxfile>`).map((page) => page.name)).toEqual(["Page A", "Page B"]);
    expect(parseDrawio(model)).toHaveLength(1);
  });
  it.each(["<!DOCTYPE mxfile><mxfile/>", "<mxfile>", "<mxfile/>", '<mxfile><diagram><mxGraphModel/></diagram></mxfile>', "https://app.diagrams.net/#Uhttps://example.test/data"])("rejects invalid or remote document input %s", (xml) => {
    expect(() => parseDrawio(xml)).toThrow();
  });
  it("rejects duplicate sheet and cell identities", () => {
    const page = newDrawioPage("a", "one");
    expect(() => parseDrawio(drawioFile([page, page]))).toThrow(/duplicate sheet/);
    drawioCell(page, { id: "1", vertex: 1 }, { x: 0 });
    expect(() => parseDrawio(drawioFile([page]))).toThrow(/duplicate cell/);
  });
  it("stops compressed expansion before parsing an oversized sheet", () => {
    const compressed = deflateSync(strToU8("x".repeat(21 * 1024 * 1024)));
    const encoded = btoa(String.fromCharCode(...compressed));
    expect(() => parseDrawio(`<mxfile><diagram>${encoded}</diagram></mxfile>`)).toThrow(/Expanded draw.io/);
  });
});

describe("untrusted draw.io rendering boundary", () => {
  it("retains original XML while removing scripts and active HTML from the rendering copy", () => {
    const page = newDrawioPage("a", "a");
    drawioCell(page, { id: "text", vertex: 1, value: '<b>Safe 中文</b><br>Second line<img src="https://example.test/leak" onerror="alert(1)"><script>alert(2)</script>', style: "text;html=1;" }, { x: 0, y: 0, width: 200, height: 80 });
    const safe = safeDrawioModel(page);
    expect(safe.querySelector("mxCell[id='text']")?.getAttribute("value")).toBe("<b>Safe 中文</b><br>Second line");
    expect(safe.querySelector("mxCell[id='text']")?.getAttribute("style")).toContain("html=1");
    expect(safeDrawioModel(page, false).querySelector("mxCell[id='text']")?.getAttribute("value")).toBe("Safe 中文\nSecond line");
    expect(drawioFile([page])).toContain("example.test");
  });
  it("blocks network images, cyclic parents and extreme geometry before loading the graph engine", () => {
    const image = newDrawioPage("a", "a");
    drawioCell(image, { id: "a", vertex: 1, style: "shape=image;image=https://example.test/private;" }, { x: 0 });
    expect(() => safeDrawioModel(image)).toThrow(/external/);
    const cycle = newDrawioPage("a", "a");
    drawioCell(cycle, { id: "a", parent: "b", vertex: 1 }, { x: 0 });
    drawioCell(cycle, { id: "b", parent: "a", vertex: 1 }, { x: 0 });
    expect(() => safeDrawioModel(cycle)).toThrow(/cyclic/);
    const huge = newDrawioPage("a", "a");
    drawioCell(huge, { id: "a", vertex: 1 }, { width: 1e20 });
    expect(() => safeDrawioModel(huge)).toThrow(/bounds/);
  });
});
