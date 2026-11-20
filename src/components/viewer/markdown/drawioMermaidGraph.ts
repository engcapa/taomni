import { diagramLabelText } from "./diagramModel";
import { MermaidGeometry, type MermaidBox } from "./drawioMermaidGeometry";

export interface MermaidNode { id: string; domId?: string; label?: string; parentId?: string; isGroup?: boolean; shape?: string; type?: string }
export interface MermaidEdge { id?: string; start?: string; end?: string; source?: string; target?: string; label?: string; text?: string; arrowTypeEnd?: string; arrowTypeStart?: string; stroke?: string; thickness?: string }
export interface MermaidGraph { nodes: MermaidNode[]; edges: MermaidEdge[] }
const arrowMarkers: Record<string, string> = { none: "none", extension: "block", aggregation: "diamond", composition: "diamond", only_one: "ERmandOne", zero_or_one: "ERzeroToOne", one_or_more: "ERoneToMany", zero_or_more: "ERzeroToMany" };
const arrow = (type?: string) => arrowMarkers[type || ""] || (/circle/.test(type || "") ? "oval" : /cross/.test(type || "") ? "cross" : "classic");
export const mermaidPlainText = (value: string) => {
  const node = document.createElement("template");
  node.innerHTML = value.replace(/<br\s*\/?\s*>/gi, "\n");
  return node.content.textContent || "";
};

function nodeStyle(shape = ""): string {
  shape = shape.toLowerCase();
  if (/diamond|question/.test(shape)) return "shape=rhombus;";
  if (/circle|ellipse|junction|start|end/.test(shape)) return "shape=ellipse;";
  if (/cylinder|database/.test(shape)) return "shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=15;";
  if (/hexagon/.test(shape)) return "shape=hexagon;";
  if (/stadium|round|state/.test(shape)) return "rounded=1;arcSize=30;";
  if (/lean|parallelogram/.test(shape)) return "shape=parallelogram;";
  return "rounded=0;";
}

export function mermaidGraphCells(graph: MermaidGraph, geometry: MermaidGeometry, prefix: string): Element[] {
  const { svg } = geometry;
  const ids = new Map(graph.nodes.map((node, index) => [node.id, `${prefix}-node-${index}`]));
  const bounds = new Map<string, MermaidBox & { label: string }>();
  const elements = Array.from(svg.querySelectorAll<SVGGraphicsElement>("g.node[id],g.cluster[id]"));
  graph.nodes.forEach((node, index) => {
    // Mermaid changes numeric counters when a different diagram is parsed.
    const matches = (id: string, suffix: string) => id === suffix || id.endsWith(`-${suffix}`);
    const stableDomId = node.domId?.replace(/-\d+$/, "");
    const element = elements.find((item) => matches(item.id, node.domId || node.id))
      || (stableDomId ? elements.find((item) => matches(item.id.replace(/-\d+$/, ""), stableDomId)) : undefined);
    const measured = element ? geometry.box(element) : undefined;
    const lines = element ? Array.from(element.querySelectorAll("text")).map(diagramLabelText).filter(Boolean).join("\n") : "";
    const marker = /^state(Start|End)$/.test(node.shape || "");
    bounds.set(node.id, { x: measured?.x ?? (index % 3) * 260, y: measured?.y ?? Math.floor(index / 3) * 160,
      width: measured?.width || (marker ? 24 : 220), height: measured?.height || (marker ? 24 : 80), label: marker ? "" : lines || mermaidPlainText(node.label || node.id) });
  });
  const cells: Element[] = [];
  // Subgraph outlines stay editable. Their members are independent layer
  // children too, so there is no implicit selection/movement of the whole lot.
  for (const node of [...graph.nodes].sort((a, b) => Number(!!b.isGroup) - Number(!!a.isGroup))) {
    const box = bounds.get(node.id)!;
    cells.push(geometry.vertex({ id: ids.get(node.id)!, value: box.label,
      style: `${node.isGroup ? "rounded=1;container=0;verticalAlign=top;fillColor=#f8fafc;" : `${nodeStyle(node.shape || node.type)}fillColor=#dbeafe;`}whiteSpace=wrap;html=0;strokeColor=#64748b;fontColor=#1f2937;fontSize=14;spacing=8;` }, box));
  }
  const paths = Array.from(svg.querySelectorAll<SVGGraphicsElement>("path[data-edge],.edgePaths path,.edgePath path.path,.transition"));
  const used = new Set<SVGGraphicsElement>();
  for (const [index, edge] of graph.edges.entries()) {
    const sourceId = edge.start || edge.source || "", targetId = edge.end || edge.target || "";
    const source = ids.get(sourceId), target = ids.get(targetId);
    if (!source || !target) throw new Error("Cannot resolve Mermaid edge endpoints");
    const path = paths.find((item) => !used.has(item) && edge.id && (item.getAttribute("data-id") === edge.id || item.id === edge.id || item.id.endsWith(`-${edge.id}`)))
      || paths.find((item) => !used.has(item));
    if (path) used.add(path);
    const sourceBox = bounds.get(sourceId)!, targetBox = bounds.get(targetId)!;
    const route = path ? geometry.route(path) : { points: [], curved: false };
    const labelElement = edge.id ? Array.from(svg.querySelectorAll<SVGGraphicsElement>(".edgeLabels [data-id]")).find((item) => item.getAttribute("data-id") === edge.id) : undefined;
    const labelBox = labelElement?.querySelector("text") ? geometry.box(labelElement) : undefined;
    cells.push(geometry.edge({ id: `${prefix}-edge-${index}`, source, target, value: mermaidPlainText(edge.label || edge.text || ""),
      style: `html=0;fontSize=13;strokeColor=#475569;endArrow=${arrow(edge.arrowTypeEnd)};endFill=${Number(edge.arrowTypeEnd !== "extension" && edge.arrowTypeEnd !== "aggregation")};startArrow=${edge.arrowTypeStart ? arrow(edge.arrowTypeStart) : "none"};startFill=${Number(edge.arrowTypeStart !== "extension" && edge.arrowTypeStart !== "aggregation")};dashed=${Number(edge.stroke === "dotted" || edge.thickness === "dotted")};` },
    route, { source: sourceBox, target: targetBox }, labelBox ? { x: labelBox.x + labelBox.width / 2, y: labelBox.y + labelBox.height / 2 } : undefined));
  }
  return cells;
}
