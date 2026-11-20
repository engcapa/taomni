import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownDrawio, singleDiagramDrawio } from "./drawioExport";
import { drawioToMarkdown } from "./drawioImport";
import { drawioCell, newDrawioPage, parseDrawio } from "./drawioCodec";
import { inspectMermaidDiagram } from "../../editor/workspace/model/mermaid";
import { DEFAULT_DIAGRAM_VIEW, rememberDiagram, snapshotDiagram } from "./diagramModel";
import { rememberDrawio } from "./drawioRender";

vi.mock("../../editor/workspace/model/mermaid", () => ({ inspectMermaidDiagram: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe("editable document export and text/table recovery", () => {
  it("exports text, code and independent table cells without replacing the source DOM", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<h1>项目 &amp; Export</h1><p>中文正文 <b>Bold</b></p><table><tr><th>Name</th><th>Status</th></tr><tr><td>测试 | case</td><td>Done</td></tr></table><pre><code>const x = 1;</code></pre>';
    const original = root.outerHTML;
    const output = await markdownDrawio(root, "doc.md", { scope: "document", layout: "separate" });
    const pages = parseDrawio(output.xml);
    expect(pages).toHaveLength(1);
    const table = pages[0].model.querySelector("mxCell[taomniKind='table']")!;
    expect(table.getAttribute("vertex")).toBe("1");
    expect(pages[0].model.querySelectorAll("mxCell[taomniRow]")).toHaveLength(4);
    const md = drawioToMarkdown(pages, "text");
    expect(md).toContain("# 项目 & Export"); expect(md).toContain("中文正文 Bold");
    expect(md).toContain("| Name | Status |\n| --- | --- |\n| 测试 \\| case | Done |");
    expect(md).toContain("const x = 1;"); expect(md).toContain("```drawio-source");
    expect(md).not.toMatch(/```drawio\n/);
    expect(root.outerHTML).toBe(original);
    await expect(markdownDrawio(root, "a", { scope: "images", layout: "separate" })).rejects.toThrow(/no images/);
  });
  it("imports only selected pages and preserves unfamiliar diagrams in either mode", () => {
    const page = newDrawioPage("a", "部署设计");
    drawioCell(page, { id: "a", vertex: 1, value: "Database", style: "shape=cylinder;" }, { width: 120, height: 80 });
    const diagram = drawioToMarkdown([page], "diagram");
    expect(diagram).toContain("## 部署设计"); expect(diagram).toContain('style="shape=cylinder;"');
    const text = drawioToMarkdown([page], "text");
    expect(text).toContain("```drawio\n"); expect(text).toContain("```drawio-source\n");
    expect(() => drawioToMarkdown([], "diagram")).toThrow(/Select/);
  });
  it("re-exports an independent sheet with its original layers, IDs and page settings", async () => {
    const page = newDrawioPage("original", "Parking map");
    page.model.setAttribute("background", "#f0f5ff");
    page.model.setAttribute("pageWidth", "1600");
    page.model.querySelector("mxCell[id='1']")!.setAttribute("value", "Background layer");
    drawioCell(page, { id: "spot", vertex: 1, value: "Parking spot", style: "shape=rectangle;" }, { x: 50, width: 120, height: 80 });
    const root = document.createElement("div");
    const preview = document.createElement("div");
    preview.className = "fv-md-drawio";
    root.append(preview);
    rememberDrawio(preview, page);

    const exported = await markdownDrawio(root, "parking", { scope: "images", layout: "separate" });
    const [sheet] = parseDrawio(exported.xml);
    expect(sheet.model.isEqualNode(page.model)).toBe(true);
    expect(exported.nativeDiagrams).toBe(1);
  });
  it("keeps imported layer visibility and connected cells in a one-sheet export", async () => {
    const [page] = parseDrawio('<mxGraphModel><root><mxCell id="diagram-root"/><mxCell id="primary" parent="diagram-root"/>'
      + '<mxCell id="secondary" parent="diagram-root" visible="0"/><object id="start" label="Start"><mxCell parent="primary" vertex="1"/></object>'
      + '<mxCell id="end" parent="secondary" vertex="1"/><mxCell id="link" parent="primary" edge="1" source="start" target="end"/></root></mxGraphModel>');
    const root = document.createElement("div");
    root.innerHTML = '<div class="fv-md-drawio"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"/></div>';
    rememberDrawio(root.firstElementChild as HTMLElement, page);

    const exported = await markdownDrawio(root, "Imported diagram", { scope: "images", layout: "single" });
    const [{ model }] = parseDrawio(exported.xml);
    expect(model.querySelector('mxCell[id="import-1-secondary"]')?.getAttribute("visible")).toBe("0");
    expect(model.querySelector('object[id="import-1-start"] mxCell')?.getAttribute("parent")).toBe("import-1-primary");
    expect(model.querySelector('mxCell[id="import-1-end"]')?.getAttribute("parent")).toBe("import-1-secondary");
    expect(model.querySelector('mxCell[edge="1"]')?.getAttribute("source")).toBe("import-1-start");
    expect(model.querySelector('mxCell[edge="1"]')?.getAttribute("target")).toBe("import-1-end");
  });
  it("restores standard diagrams.net table rows without Taomni metadata", () => {
    const page = newDrawioPage("a", "External table");
    drawioCell(page, { id: "table", vertex: 1, style: "shape=table;" }, { width: 400, height: 80 });
    for (const [index, value] of ["Header", "Native cell 中文"].entries()) {
      drawioCell(page, { id: `row-${index}`, parent: "table", vertex: 1, style: "shape=tableRow;" }, { y: index * 40, width: 400, height: 40 });
      drawioCell(page, { id: `cell-${index}`, parent: `row-${index}`, vertex: 1, value }, { width: 400, height: 40 });
    }
    const markdown = drawioToMarkdown([page], "text");
    expect(markdown).toContain("| Header |\n| --- |\n| Native cell 中文 |");
    expect(markdown).toContain("```drawio-source");
    expect(markdown).not.toMatch(/```drawio\n/);
  });
});

it("converts parsed Mermaid nodes and real connected edges into editable native cells", async () => {
  vi.mocked(inspectMermaidDiagram).mockImplementation(async (_source, callback) => callback({ type: "flowchart-v2", db: { getData: () => ({ nodes: [{ id: "a", label: "加载配置" }, { id: "b", label: "权限检查", shape: "diamond" }], edges: [{ start: "a", end: "b", label: "允许", arrowTypeEnd: "arrow_point" }] }) } }));
  const element = document.createElement("div"); element.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 200" />';
  rememberDiagram(element, { source: "flowchart LR\na[加载配置] --> b{权限检查}", theme: "light" });
  const output = await singleDiagramDrawio(snapshotDiagram(element, "flow"), DEFAULT_DIAGRAM_VIEW);
  const model = parseDrawio(output.xml)[0].model;
  const edge = model.querySelector("mxCell[edge='1']")!;
  expect(model.querySelectorAll("mxCell[vertex='1']")).toHaveLength(2);
  expect(model.querySelectorAll("mxCell[vertex='1'],mxCell[edge='1']")).toSatisfy((cells: NodeListOf<Element>) => Array.from(cells).every((cell) => cell.getAttribute("parent") === "1"));
  expect(model.querySelector("mxCell[style^='group;']")).toBeNull();
  expect(edge.getAttribute("source")).toBe("mermaid-node-0"); expect(edge.getAttribute("target")).toBe("mermaid-node-1");
  expect(edge.querySelector("mxGeometry")?.getAttribute("relative")).toBe("1");
  expect(model.querySelector("object")?.getAttribute("mermaidSource")).toContain("flowchart LR");
  expect(output.nativeDiagrams).toBe(1); expect(output.fallbackDiagrams).toBe(0);
  expect(output.xml).not.toContain("shape=image");
});
