import { describe, expect, it } from "vitest";
import { applyDiagramAction } from "./diagramActions";
import { DEFAULT_DIAGRAM_VIEW, diagramBounds, diagramScale, diagramText, rememberDiagram, snapshotDiagram, zoomDiagram } from "./diagramModel";

function svg(text: string): SVGSVGElement {
  const host = document.createElement("div");
  host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 5 640 240">${text}</svg>`;
  return host.firstElementChild as SVGSVGElement;
}

describe("read-only Mermaid definitions and labels", () => {
  it("copies visible Unicode/multiline labels without IDs, style rules or hidden metadata", () => {
    const image = svg('<title>Not a label</title><defs><text>Definition</text></defs><style>.node{fill:red}</style><text><tspan x="0" dy="0">加载配置</tspan><tspan x="0" dy="1.2em">Load configuration</tspan></text><text>  Access   check </text><g style="display:none"><text>Hidden</text></g>');
    document.body.append(image);
    expect(diagramText(image)).toBe("加载配置\nLoad configuration\nAccess check"); image.remove();
  });
  it("isolates source and SVG snapshots for different diagrams and rejects unregistered content", () => {
    const first = document.createElement("div"), second = document.createElement("div");
    first.append(svg("<text>First</text>")); second.append(svg("<text>Second</text>"));
    rememberDiagram(first, { source: "flowchart LR\nA[First] --> B[End]", theme: "dark" });
    rememberDiagram(second, { source: "sequenceDiagram\nAlice->>Bob: Second", theme: "light" });
    const copy = snapshotDiagram(first, "first");
    expect(copy).toMatchObject({ width: 640, height: 240, text: "First", theme: "dark" });
    first.querySelector("text")!.textContent = "Changed after open";
    expect(copy.svg.textContent).toBe("First");
    expect(snapshotDiagram(second, "second").source).toContain("sequenceDiagram");
    expect(() => snapshotDiagram(document.createElement("div"), "none")).toThrow("not ready");
  });
});

describe("diagram view geometry", () => {
  it("rotates in both directions, fits rotated bounds and resets every view change", () => {
    let view = applyDiagramAction({ ...DEFAULT_DIAGRAM_VIEW }, "rotate-left");
    expect(view.rotation).toBe(270);
    expect(diagramBounds(600, 200, view.rotation)).toEqual({ width: 200, height: 600 });
    expect(diagramScale(view, { width: 600, height: 200 }, { width: 432, height: 632 })).toBe(1);
    view = applyDiagramAction(applyDiagramAction(view, "flip-h"), "flip-v");
    expect(view.flipX && view.flipY).toBe(true);
    view = { ...view, x: 80, y: -50, scale: 3, mode: "custom" };
    expect(applyDiagramAction(view, "reset")).toEqual(DEFAULT_DIAGRAM_VIEW);
    for (let index = 0; index < 4; index++) view = applyDiagramAction(view, "rotate-right");
    expect(view.rotation).toBe(270);
  });
  it("keeps the same point under the cursor while zooming and bounds extreme input", () => {
    const view = { ...DEFAULT_DIAGRAM_VIEW, x: 20, y: -10 };
    expect(zoomDiagram(view, 1, 2, { x: 100, y: 50 })).toMatchObject({ x: -60, y: -70, scale: 2, mode: "custom" });
    expect(zoomDiagram(view, 1, 1e6).scale).toBe(16);
    expect(zoomDiagram(view, 1, 1e-6).scale).toBe(0.05);
  });
  it("actual size and width fit retain orientation while centering the image", () => {
    const view = applyDiagramAction({ ...DEFAULT_DIAGRAM_VIEW, rotation: 90, x: 20, flipX: true }, "actual");
    expect(diagramScale(view, { width: 600, height: 200 }, { width: 432, height: 632 })).toBe(1);
    expect(view).toMatchObject({ x: 0, y: 0, rotation: 90, flipX: true });
    expect(diagramScale({ ...view, mode: "width" }, { width: 600, height: 200 }, { width: 432, height: 632 })).toBe(2);
  });
});
