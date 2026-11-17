import { diagramLabelText } from "./diagramModel";
import { MermaidGeometry, type MermaidBox } from "./drawioMermaidGeometry";
import { mermaidPlainText } from "./drawioMermaidGraph";

export interface SequenceActor { name: string; description: string; type: string }
export interface SequenceMessage { id: string; from?: string; to?: string; message: unknown; type?: number }
export interface MermaidSequence { actors: Array<[string, SequenceActor]>; messages: SequenceMessage[] }
const TEXT = "text;html=0;whiteSpace=wrap;strokeColor=none;fillColor=none;fontColor=#1f2937;fontSize=16;spacing=0;";
const BORDER = "html=0;strokeColor=#475569;fontColor=#1f2937;fontSize=16;";

/** The rendered SVG supplies real message/activation/fragment positions;
 * the parser supplies participant identity and editable message semantics. */
export function mermaidSequenceCells(data: MermaidSequence, geometry: MermaidGeometry, prefix: string): Element[] {
  const { svg } = geometry;
  const lines = Array.from(svg.querySelectorAll<SVGGraphicsElement>(".messageLine0,.messageLine1"));
  const lifelines = Array.from(svg.querySelectorAll<SVGGraphicsElement>(".actor-line"));
  if (!data.actors.length || !lifelines.length || (data.messages.some((message) => message.from && message.to && message.type !== 2) && !lines.length)) return [];
  const cells: Element[] = [];
  let serial = 0;
  const id = (kind: string) => `${prefix}-${kind}-${serial++}`;
  const text = (element: SVGGraphicsElement, kind = "sequence-text") => {
    const label = diagramLabelText(element);
    if (label) cells.push(geometry.vertex({ id: id(kind), value: label, style: TEXT, taomniKind: kind }, geometry.box(element)));
  };
  // Fragment outlines are independent edges behind their contents.
  for (const line of svg.querySelectorAll<SVGGraphicsElement>(".loopLine")) cells.push(geometry.edge({ id: id("fragment"), value: "", style: "endArrow=none;startArrow=none;strokeColor=#64748b;", taomniKind: "sequence-fragment" }, geometry.route(line)));
  for (const element of svg.querySelectorAll<SVGGraphicsElement>("rect.note,rect.rect,rect[class^='activation']")) {
    const activation = element.getAttribute("class")?.startsWith("activation");
    cells.push(geometry.vertex({ id: id(activation ? "activation" : "note"), value: "", style: `${BORDER}fillColor=${activation ? "#dbeafe" : "#ede9fe"};`, taomniKind: activation ? "sequence-activation" : "sequence-note" }, geometry.box(element)));
  }
  const terminals = new Map<string, { id: string; box: MermaidBox }>();
  for (const line of lifelines) {
    const actor = line.getAttribute("data-id") || line.getAttribute("name") || "";
    const box = geometry.box(line), cellId = id("lifeline");
    // A thin editable line vertex is also a message terminal. Connections
    // attach at each original height instead of jumping to actor-box centers.
    box.width = Math.max(1, box.width);
    cells.push(geometry.vertex({ id: cellId, value: "", style: `${BORDER}shape=line;direction=south;dashed=1;`, taomniKind: "sequence-lifeline", participant: actor }, box));
    terminals.set(actor, { id: cellId, box });
  }
  for (const [actorId, actor] of data.actors) {
    const elements = Array.from(svg.querySelectorAll<SVGGraphicsElement>(".actor-top[name],.actor-bottom[name]"))
      .filter((element) => element.getAttribute("name") === actorId);
    for (const element of elements) {
      if (element.tagName.toLowerCase() === "rect") {
        cells.push(geometry.vertex({ id: id("participant"), value: mermaidPlainText(actor.description || actor.name), style: `${BORDER}rounded=1;whiteSpace=wrap;fillColor=#dbeafe;`, taomniKind: "sequence-participant", participant: actorId }, geometry.box(element)));
      } else if (element.tagName.toLowerCase() === "g") {
        // The stick figure is made from native ellipses/lines/text, so even
        // its parts remain editable without relying on external UML stencils.
        for (const circle of element.querySelectorAll<SVGGraphicsElement>("circle")) cells.push(geometry.vertex({ id: id("actor-head"), value: "", style: `${BORDER}shape=ellipse;fillColor=#dbeafe;`, taomniKind: "sequence-actor" }, geometry.box(circle)));
        for (const limb of element.querySelectorAll<SVGGraphicsElement>("line")) cells.push(geometry.edge({ id: id("actor-limb"), value: "", style: "endArrow=none;startArrow=none;strokeColor=#475569;", taomniKind: "sequence-actor" }, geometry.route(limb)));
        for (const label of element.querySelectorAll<SVGGraphicsElement>("text")) text(label, "sequence-actor-label");
      }
    }
  }
  const labels = Array.from(svg.querySelectorAll<SVGGraphicsElement>(".messageText"));
  for (const [index, line] of lines.entries()) {
    const sourceId = line.getAttribute("data-from") || "", targetId = line.getAttribute("data-to") || "";
    const messageId = line.getAttribute("data-id")?.replace(/^i/, "");
    const message = data.messages.find((item) => item.id === messageId);
    const source = terminals.get(sourceId), target = terminals.get(targetId);
    const route = geometry.route(line);
    if (route.points.length < 2) throw new Error("Cannot read Mermaid sequence message path");
    const label = labels[index], labelBox = label ? geometry.box(label) : undefined;
    // Edge labels in draw.io stay horizontal even when the diagram's path is
    // rotated. An independent editable text cell follows the view transform.
    const rotatedLabel = geometry.transform.rotation % 360 !== 0 && label;
    if (rotatedLabel) text(label, "sequence-message-label");
    const marker = line.getAttribute("marker-end") || "";
    const endArrow = /crosshead/.test(marker) ? "cross" : /filled/.test(marker) ? "block" : marker ? "classic" : "open";
    cells.push(geometry.edge({ id: id("message"), ...(source && target ? { source: source.id, target: target.id } : {}),
      value: rotatedLabel ? "" : typeof message?.message === "string" ? mermaidPlainText(message.message) : label ? diagramLabelText(label) : "",
      style: `${BORDER}fontSize=16;endArrow=${endArrow};startArrow=${line.hasAttribute("marker-start") ? endArrow : "none"};dashed=${Number(line.classList.contains("messageLine1"))};labelBackgroundColor=#ffffff;`,
      taomniKind: "sequence-message", from: sourceId, to: targetId }, route,
    source && target ? { source: source.box, target: target.box } : undefined,
    labelBox ? { x: labelBox.x + labelBox.width / 2, y: labelBox.y + labelBox.height / 2 } : undefined));
  }
  for (const label of svg.querySelectorAll<SVGGraphicsElement>(".sequenceNumber,.loopText,.labelText,.noteText,.titleText")) text(label);
  return cells;
}
