import { afterEach, expect, it, vi } from "vitest";
import { inspectMermaidDiagram } from "../../editor/workspace/model/mermaid";
import { newDrawioPage } from "./drawioCodec";
import { DEFAULT_DIAGRAM_VIEW, type DiagramSnapshot } from "./diagramModel";
import { mermaidDrawioCells } from "./drawioMermaid";

vi.mock("../../editor/workspace/model/mermaid", () => ({ inspectMermaidDiagram: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const snapshot = (svg: string): DiagramSnapshot => ({ source: "classDiagram", filename: "classes", theme: "light", width: 640, height: 300, text: "",
  svg: new DOMParser().parseFromString(svg, "image/svg+xml").documentElement as unknown as SVGSVGElement });

it("keeps rendered node geometry when reparse counters differ, including multiline member labels", async () => {
  vi.mocked(inspectMermaidDiagram).mockImplementation(async (_source, inspect) => inspect({ type: "classDiagram", db: { getData: () => ({
    nodes: [{ id: "Animal", domId: "classId-Animal-52", label: "Animal" }, { id: "Dog", domId: "classId-Dog-53", label: "Dog" }],
    edges: [{ start: "Animal", end: "Dog", arrowTypeStart: "extension", arrowTypeEnd: "none" }],
  }) } }));
  const matrix = { inverse() { return this; }, multiply() { return this; } };
  const methods: Record<string, unknown> = {
    getBBox: () => ({ x: 40, y: 100, width: 180, height: 120 }), getCTM: () => matrix,
    createSVGPoint: () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } }),
  };
  const previous = Object.fromEntries(Object.keys(methods).map((key) => [key, Object.getOwnPropertyDescriptor(SVGElement.prototype, key)]));
  for (const [key, value] of Object.entries(methods)) Object.defineProperty(SVGElement.prototype, key, { value, configurable: true });
  try {
    const page = newDrawioPage("a", "Classes");
    await mermaidDrawioCells(page, snapshot('<svg xmlns="http://www.w3.org/2000/svg"><g class="node" id="render-classId-Animal-0"><text><tspan x="0">Animal</tspan><tspan x="0" dy="20">+name: string</tspan></text></g><g class="node" id="render-classId-Dog-1"><text>Dog</text></g></svg>'), DEFAULT_DIAGRAM_VIEW, "graph");
    const node = page.model.querySelector("object[id='graph-node-0'] > mxCell")!;
    expect(node.parentElement?.getAttribute("label")).toBe("Animal\n+name: string");
    expect(node.querySelector("mxGeometry")?.getAttribute("x")).toBe("40");
    expect(node.querySelector("mxGeometry")?.getAttribute("y")).toBe("100");
    expect(node.querySelector("mxGeometry")?.getAttribute("width")).toBe("180");
    expect(page.model.querySelector("mxCell[edge='1']")?.getAttribute("style")).toContain("startArrow=block;startFill=0;");
  } finally {
    for (const key of Object.keys(methods)) {
      if (previous[key]) Object.defineProperty(SVGElement.prototype, key, previous[key]!);
      else Reflect.deleteProperty(SVGElement.prototype, key);
    }
  }
});

it("recognizes Mermaid's actual ER diagram type and preserves relationship cardinalities", async () => {
  vi.mocked(inspectMermaidDiagram).mockImplementation(async (_source, inspect) => inspect({ type: "er", db: { getData: () => ({
    nodes: [{ id: "USER", label: "USER" }, { id: "ORDER", label: "ORDER" }],
    edges: [{ start: "USER", end: "ORDER", label: "places", arrowTypeStart: "only_one", arrowTypeEnd: "zero_or_more" }],
  }) } }));
  const page = newDrawioPage("a", "ER");
  expect(await mermaidDrawioCells(page, snapshot('<svg xmlns="http://www.w3.org/2000/svg"/>'), DEFAULT_DIAGRAM_VIEW, "er")).toBe(true);
  const edge = page.model.querySelector("mxCell[edge='1']")!;
  expect(edge.getAttribute("value")).toBe("places");
  expect(edge.getAttribute("style")).toContain("startArrow=ERmandOne");
  expect(edge.getAttribute("style")).toContain("endArrow=ERzeroToMany");
});
