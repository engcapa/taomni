import { inspectMermaidDiagram } from "../../editor/workspace/model/mermaid";
import type { DrawioPage } from "./drawioCodec";
import type { DiagramSnapshot, DiagramTransform } from "./diagramModel";
import { mermaidGraphCells, type MermaidGraph } from "./drawioMermaidGraph";
import { mermaidSequenceCells, type MermaidSequence } from "./drawioMermaidSequence";
import { MermaidGeometry, retainMermaidSource } from "./drawioMermaidGeometry";

interface DiagramDb {
  getData?: () => MermaidGraph;
  getActors?: () => Map<string, MermaidSequence["actors"][number][1]>;
  getMessages?: () => MermaidSequence["messages"];
}
type MermaidData = { kind: "graph"; graph: MermaidGraph } | { kind: "sequence"; sequence: MermaidSequence };

/** Native cells for supported Mermaid families, with no overall group. Other
 * families return false so their source-preserving SVG fallback stays explicit. */
export async function mermaidDrawioCells(page: DrawioPage, snapshot: DiagramSnapshot, transform: DiagramTransform, prefix: string, x = 0, y = 0): Promise<boolean> {
  const data = await inspectMermaidDiagram(snapshot.source, (diagram): MermaidData | null => {
    const db = diagram.db as DiagramDb;
    if (diagram.type === "sequence" && db.getActors && db.getMessages) {
      return structuredClone({ kind: "sequence", sequence: { actors: Array.from(db.getActors()), messages: db.getMessages() } });
    }
    if (!/^(flowchart|stateDiagram|classDiagram|er$)/.test(diagram.type)) return null;
    const graph = db.getData?.();
    return graph?.nodes.length ? structuredClone({ kind: "graph", graph: { nodes: graph.nodes, edges: graph.edges } }) : null;
  });
  if (!data) return false;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  const svg = snapshot.svg.cloneNode(true) as SVGSVGElement;
  svg.setAttribute("width", String(snapshot.width)); svg.setAttribute("height", String(snapshot.height));
  host.append(svg); document.body.append(host);
  try {
    const geometry = new MermaidGeometry(page, svg, snapshot, transform, x, y);
    const cells = data.kind === "graph" ? mermaidGraphCells(data.graph, geometry, prefix) : mermaidSequenceCells(data.sequence, geometry, prefix);
    if (!cells.length) return false;
    retainMermaidSource(page, cells.find((cell) => cell.getAttribute("vertex") === "1") || cells[0], snapshot.source);
    return true;
  } finally { host.remove(); }
}
