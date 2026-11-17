import { inspectMermaidDiagram } from "../../editor/workspace/model/mermaid";
import { drawioCell, drawioElement, type DrawioPage } from "./drawioCodec";
import { diagramLabelText, type DiagramSnapshot, type DiagramTransform } from "./diagramModel";

interface MermaidNode { id: string; domId?: string; label?: string; parentId?: string; isGroup?: boolean; shape?: string; type?: string }
interface MermaidEdge { id?: string; start?: string; end?: string; source?: string; target?: string; label?: string; text?: string; arrowTypeEnd?: string; arrowTypeStart?: string; stroke?: string; thickness?: string }
interface MermaidGraph { nodes: MermaidNode[]; edges: MermaidEdge[] }
interface DiagramDb { getData?: () => MermaidGraph }
const arrowMarkers: Record<string, string> = { none: "none", extension: "block", aggregation: "diamond", composition: "diamond", only_one: "ERmandOne", zero_or_one: "ERzeroToOne", one_or_more: "ERoneToMany", zero_or_more: "ERzeroToMany" };
const arrow = (type?: string) => arrowMarkers[type || ""] || (/circle/.test(type || "") ? "oval" : /cross/.test(type || "") ? "cross" : "classic");
const plain = (value: string) => {
  const node = document.createElement("div");
  node.innerHTML = value.replace(/<br\s*\/?\s*>/gi, "\n");
  return node.textContent || "";
};

function nodeStyle(shape = ""): string {
  shape = shape.toLowerCase();
  if (/diamond|question/.test(shape)) return "rhombus;";
  if (/circle|ellipse|junction|start|end/.test(shape)) return "ellipse;";
  if (/cylinder|database/.test(shape)) return "shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=15;";
  if (/hexagon/.test(shape)) return "shape=hexagon;";
  if (/stadium|round|state/.test(shape)) return "rounded=1;arcSize=30;";
  if (/lean|parallelogram/.test(shape)) return "shape=parallelogram;";
  return "rounded=0;";
}

/** Common node-based Mermaid diagrams become native cells and connected
 * edges. Unsupported diagram families return false, never a fake conversion. */
export async function mermaidDrawioCells(page: DrawioPage, snapshot: DiagramSnapshot, transform: DiagramTransform, prefix: string, x = 0, y = 0): Promise<boolean> {
  const data = await inspectMermaidDiagram(snapshot.source, (diagram): MermaidGraph | null => {
    if (!/^(flowchart|stateDiagram|classDiagram|er$)/.test(diagram.type)) return null;
    const db = diagram.db as DiagramDb;
    const graph = db.getData?.();
    return graph ? structuredClone({ nodes: graph.nodes, edges: graph.edges }) : null;
  });
  if (!data?.nodes.length) return false;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  const svg = snapshot.svg.cloneNode(true) as SVGSVGElement;
  svg.setAttribute("width", String(snapshot.width)); svg.setAttribute("height", String(snapshot.height));
  host.append(svg); document.body.append(host);
  try {
    const ids = new Map(data.nodes.map((node, index) => [node.id, `${prefix}-node-${index}`]));
    const bounds = new Map<string, { x: number; y: number; width: number; height: number; label: string }>();
    const elements = Array.from(svg.querySelectorAll<SVGGraphicsElement>("g.node[id],g.cluster[id]"));
    const viewBox = svg.viewBox?.baseVal;
    data.nodes.forEach((node, index) => {
      // Render prefixes and Mermaid's mutable numeric counters are not node
      // identity. Match stable DB IDs, including class/state counters changed
      // by reparsing another diagram, without confusing A with another-A.
      const matches = (id: string, suffix: string) => id === suffix || id.endsWith(`-${suffix}`);
      const stableDomId = node.domId?.replace(/-\d+$/, "");
      const element = elements.find((item) => matches(item.id, node.domId || node.id))
        || (stableDomId ? elements.find((item) => matches(item.id.replace(/-\d+$/, ""), stableDomId)) : undefined);
      const box = element?.getBBox?.(), matrix = element?.getCTM?.();
      const rootMatrix = matrix ? svg.getCTM() : null;
      const point = matrix && rootMatrix ? svg.createSVGPoint() : null;
      if (point) { point.x = box?.x ?? 0; point.y = box?.y ?? 0; }
      const origin = point && matrix && rootMatrix ? point.matrixTransform(rootMatrix.inverse().multiply(matrix)) : null;
      // All label lines become one editable cell; class/ER member labels are
      // read from the exact rendered node rather than omitted from its title.
      const lines = element ? Array.from(element.querySelectorAll("text")).map(diagramLabelText).filter(Boolean).join("\n") : "";
      const marker = /^state(Start|End)$/.test(node.shape || "");
      bounds.set(node.id, { x: origin ? origin.x - (viewBox?.x || 0) : (index % 3) * 260, y: origin ? origin.y - (viewBox?.y || 0) : Math.floor(index / 3) * 160,
        width: box?.width || (marker ? 24 : 220), height: box?.height || (marker ? 24 : 80), label: marker ? "" : lines || plain(node.label || node.id) });
    });
    const groupId = `${prefix}-group`;
    const group = drawioCell(page, { id: groupId, vertex: 1, value: "", style: `group;rotation=${transform.rotation};flipH=${Number(transform.flipX)};flipV=${Number(transform.flipY)};` }, { x, y, width: snapshot.width, height: snapshot.height });
    const wrapper = drawioElement(page.model.ownerDocument, "object", { id: groupId, label: "", mermaidSource: snapshot.source, taomniKind: "mermaid", tooltip: snapshot.source });
    group.removeAttribute("id"); group.replaceWith(wrapper); wrapper.append(group);
    // Parent-child relationships keep subgraphs as editable containers. Node
    // geometry is converted from absolute SVG coordinates to parent coordinates.
    for (const node of data.nodes) {
      const box = bounds.get(node.id)!;
      const parentBox = node.parentId ? bounds.get(node.parentId) : undefined;
      drawioCell(page, { id: ids.get(node.id)!, parent: parentBox ? ids.get(node.parentId!)! : groupId, vertex: 1, value: box.label,
        style: `${node.isGroup ? "rounded=1;container=1;collapsible=0;verticalAlign=top;fillColor=#f8fafc;" : `${nodeStyle(node.shape || node.type)}fillColor=#dbeafe;`}whiteSpace=wrap;html=0;strokeColor=#64748b;fontColor=#1f2937;fontSize=14;spacing=8;` },
      { x: box.x - (parentBox?.x || 0), y: box.y - (parentBox?.y || 0), width: box.width, height: box.height });
    }
    for (const [index, edge] of data.edges.entries()) {
      const source = ids.get(edge.start || edge.source || ""), target = ids.get(edge.end || edge.target || "");
      if (!source || !target) throw new Error("Cannot resolve Mermaid edge endpoints");
      drawioCell(page, { id: `${prefix}-edge-${index}`, parent: groupId, edge: 1, source, target, value: plain(edge.label || edge.text || ""),
        style: `edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;fontSize=13;strokeColor=#475569;endArrow=${arrow(edge.arrowTypeEnd)};endFill=${Number(edge.arrowTypeEnd !== "extension" && edge.arrowTypeEnd !== "aggregation")};startArrow=${edge.arrowTypeStart ? arrow(edge.arrowTypeStart) : "none"};startFill=${Number(edge.arrowTypeStart !== "extension" && edge.arrowTypeStart !== "aggregation")};dashed=${Number(edge.stroke === "dotted" || edge.thickness === "dotted")};` }, { relative: 1 });
    }
    return true;
  } finally { host.remove(); }
}
