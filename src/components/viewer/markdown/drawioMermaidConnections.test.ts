import { describe, expect, it } from "vitest";
import { Cell, CellState, ConnectionConstraint, Graph, Point } from "@maxgraph/core";
import { newDrawioPage } from "./drawioCodec";
import { DEFAULT_DIAGRAM_VIEW, type DiagramSnapshot } from "./diagramModel";
import { MermaidGeometry } from "./drawioMermaidGeometry";

describe("draw.io connection anchors", () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const [flipX, flipY] of [[false, false], [true, false], [false, true], [true, true]]) {
      it(`retains sequence endpoints at rotation=${rotation}, flipX=${flipX}, flipY=${flipY}`, () => {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const snapshot: DiagramSnapshot = { svg, width: 1000, height: 800, source: "sequenceDiagram", text: "", filename: "sequence", theme: "light" };
        const page = newDrawioPage("sequence", "Sequence");
        const geometry = new MermaidGeometry(page, svg, snapshot, { ...DEFAULT_DIAGRAM_VIEW, rotation, flipX, flipY }, 40, 60);
        const box = { x: 300, y: 80, width: 1, height: 630 };
        const vertex = geometry.vertex({ id: "actor", style: "shape=line;direction=south;" }, box);
        const origin = { x: 307, y: 180 };
        const edge = geometry.edge({ id: "message", source: "actor", target: "actor" }, { points: [origin, { x: 307, y: 200 }], curved: true }, { source: box, target: box });
        const style = Object.fromEntries(vertex.getAttribute("style")!.split(";").filter((part) => part.includes("=")).map((part) => {
          const [key, value] = part.split("=");
          return [key, ["rotation", "flipH", "flipV", "anchorPointDirection"].includes(key) ? Number(value) : value];
        }));
        // draw.io's legacy anchors default to following the shape direction.
        // maxGraph's default is false, which hid the original Desktop defect.
        style.anchorPointDirection ??= 1;
        const host = document.createElement("div"); document.body.append(host);
        const graph = new Graph(host, undefined, []);
        try {
          const state = new CellState(graph.getView(), new Cell(), style);
          state.cell.setVertex(true);
          const bounds = vertex.querySelector("mxGeometry")!;
          state.x = Number(bounds.getAttribute("x")); state.y = Number(bounds.getAttribute("y"));
          state.width = Number(bounds.getAttribute("width")); state.height = Number(bounds.getAttribute("height"));
          const anchors = Object.fromEntries(edge.getAttribute("style")!.split(";").filter((part) => part.includes("=")).map((part) => part.split("=")));
          const actual = graph.getConnectionPoint(state, new ConnectionConstraint(new Point(Number(anchors.exitX), Number(anchors.exitY)), false), false)!;
          const expected = geometry.map(origin);
          expect(actual.x).toBeCloseTo(expected.x, 0);
          expect(actual.y).toBeCloseTo(expected.y, 0);
        } finally { graph.destroy(); host.remove(); }
      });
    }
  }
});
