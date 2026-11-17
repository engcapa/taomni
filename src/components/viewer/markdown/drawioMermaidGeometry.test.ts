import { afterEach, expect, it, vi } from "vitest";
import { newDrawioPage } from "./drawioCodec";
import { DEFAULT_DIAGRAM_VIEW, type DiagramSnapshot } from "./diagramModel";
import { linearPathPoints, MermaidGeometry } from "./drawioMermaidGeometry";

afterEach(() => vi.restoreAllMocks());
function fixture(transform = DEFAULT_DIAGRAM_VIEW) {
  const svg = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -20 300 200"/>', "image/svg+xml").documentElement as unknown as SVGSVGElement;
  const snapshot: DiagramSnapshot = { svg, source: "flowchart LR", width: 300, height: 200, theme: "light", text: "", filename: "test" };
  return new MermaidGeometry(newDrawioPage("test", "Test"), svg, snapshot, transform, 40, 60);
}

it("retains straight and stepped SVG corners, including compact/relative/exponential coordinates", () => {
  expect(linearPathPoints("M1e1,-2L10 30h40v20l-10 5")).toEqual([{ x: 10, y: -2 }, { x: 10, y: 30 }, { x: 50, y: 30 }, { x: 50, y: 50 }, { x: 40, y: 55 }]);
  const geometry = fixture();
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M0,0 L0,50 L100,50 L100,100");
  const route = geometry.route(path);
  const edge = geometry.edge({ id: "steps" }, route);
  expect(edge.getAttribute("parent")).toBe("1");
  expect(edge.getAttribute("style")).toContain("curved=0;");
  expect(edge.getAttribute("style")).not.toContain("orthogonalEdgeStyle");
  const points = edge.querySelectorAll("Array[as='points'] > mxPoint");
  expect(Array.from(points).map((p) => [p.getAttribute("x"), p.getAttribute("y")])).toEqual([["50", "130"], ["150", "130"]]);
});

it("writes a native curved connector with a compact editable polygon", () => {
  const geometry = fixture();
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M0 0 C100 0 100 100 0 100");
  Object.assign(path, { getTotalLength: () => 200, getPointAtLength: (length: number) => ({ x: Math.sin(length / 200 * Math.PI) * 75, y: length / 2 }) });
  const route = geometry.route(path);
  expect(route.curved).toBe(true);
  const edge = geometry.edge({ id: "curve" }, route);
  expect(edge.getAttribute("style")).toContain("curved=1;");
  expect(edge.getAttribute("style")).toContain("shape=connector;");
  expect(edge.querySelectorAll("Array > mxPoint").length).toBeLessThanOrEqual(3);
  expect(edge.querySelector("mxPoint[as='sourcePoint']")?.getAttribute("x")).toBe("50");
  expect(edge.querySelector("mxPoint[as='targetPoint']")?.getAttribute("y")).toBe("180");
});

it("applies viewer rotation/flip and document offset to independent nodes, connection anchors and waypoints", () => {
  const geometry = fixture({ ...DEFAULT_DIAGRAM_VIEW, rotation: 90, flipX: true });
  const cell = geometry.vertex({ id: "a", style: "rounded=0;" }, { x: 10, y: 20, width: 80, height: 40 });
  expect(cell?.getAttribute("parent")).toBe("1");
  expect(cell.getAttribute("style")).toContain("rotation=90;flipH=1;");
  expect(cell.querySelector("mxGeometry")?.getAttribute("x")).toBe("160");
  expect(cell.querySelector("mxGeometry")?.getAttribute("y")).toBe("290");
  const edge = geometry.edge({ id: "e", source: "a", target: "b" }, { points: [{ x: 90, y: 40 }, { x: 120, y: 40 }, { x: 120, y: 80 }], curved: false },
    { source: { x: 10, y: 20, width: 80, height: 40 }, target: { x: 110, y: 60, width: 80, height: 40 } });
  expect(edge.getAttribute("style")).toContain("exitX=1;exitY=0.5;exitPerimeter=0;");
  expect(edge.querySelector("mxPoint[as='sourcePoint']")?.getAttribute("x")).toBe("200");
  expect(edge.querySelector("mxPoint[as='sourcePoint']")?.getAttribute("y")).toBe("270");
  expect(edge.querySelector("Array > mxPoint")?.getAttribute("y")).toBe("240");
});
