import { drawioCell, drawioElement, type DrawioPage } from "./drawioCodec";
import { diagramBounds, normalizeRotation, type DiagramSnapshot, type DiagramTransform } from "./diagramModel";
import { compactNativeCurve } from "./drawioMermaidCurves";

export interface MermaidPoint { x: number; y: number }
export interface MermaidBox extends MermaidPoint { width: number; height: number }
export interface MermaidRoute { points: MermaidPoint[]; curved: boolean }
type Attributes = Record<string, string | number>;
const number = (value: string | null) => Number.parseFloat(value || "0") || 0;
const round = (value: number) => Math.round(value * 1000) / 1000;

/** SVG measurement and whole-view transforms, without a grouping cell. All
 * positions remain in Mermaid coordinates until written to the graph. */
export class MermaidGeometry {
  private readonly verticalTerminals = new Set<string>();

  constructor(readonly page: DrawioPage, readonly svg: SVGSVGElement, readonly snapshot: DiagramSnapshot,
    readonly transform: DiagramTransform, readonly x: number, readonly y: number) {}

  point(element: SVGGraphicsElement, point: MermaidPoint): MermaidPoint {
    const matrix = element.getCTM?.(), root = this.svg.getCTM?.();
    let result = point;
    if (matrix && root) {
      const svgPoint = this.svg.createSVGPoint();
      svgPoint.x = point.x; svgPoint.y = point.y;
      result = svgPoint.matrixTransform(root.inverse().multiply(matrix));
    }
    const viewBox = this.svg.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
    return { x: result.x - (viewBox?.[0] || 0), y: result.y - (viewBox?.[1] || 0) };
  }

  box(element: SVGGraphicsElement): MermaidBox {
    const box = element.getBBox?.() ?? { x: number(element.getAttribute("x")), y: number(element.getAttribute("y")),
      width: number(element.getAttribute("width")), height: number(element.getAttribute("height")) };
    const corners = [this.point(element, box), this.point(element, { x: box.x + box.width, y: box.y }),
      this.point(element, { x: box.x, y: box.y + box.height }), this.point(element, { x: box.x + box.width, y: box.y + box.height })];
    const x = Math.min(...corners.map((p) => p.x)), y = Math.min(...corners.map((p) => p.y));
    return { x, y, width: Math.max(...corners.map((p) => p.x)) - x, height: Math.max(...corners.map((p) => p.y)) - y };
  }

  map(point: MermaidPoint): MermaidPoint {
    const { width, height } = this.snapshot;
    const bounds = diagramBounds(width, height, this.transform.rotation);
    const angle = normalizeRotation(this.transform.rotation) * Math.PI / 180;
    const dx = (point.x - width / 2) * (this.transform.flipX ? -1 : 1);
    const dy = (point.y - height / 2) * (this.transform.flipY ? -1 : 1);
    return { x: round(this.x + bounds.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle)),
      y: round(this.y + bounds.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle)) };
  }

  vertex(attributes: Attributes, box: MermaidBox): Element {
    if (/(?:^|;)direction=(?:north|south);/.test(String(attributes.style))) this.verticalTerminals.add(String(attributes.id));
    const center = this.map({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    return drawioCell(this.page, { ...attributes, vertex: 1,
      // SVG anchors already use the displayed shape bounds. draw.io otherwise
      // rotates them again for direction=south (maxGraph defaults differently).
      style: `${attributes.style || ""}anchorPointDirection=0;legacyAnchorPoints=1;rotation=${normalizeRotation(this.transform.rotation)};flipH=${Number(this.transform.flipX)};flipV=${Number(this.transform.flipY)};` },
    { x: round(center.x - box.width / 2), y: round(center.y - box.height / 2), width: round(box.width), height: round(box.height) });
  }

  route(element: SVGGraphicsElement): MermaidRoute {
    const read = (name: string) => number(element.getAttribute(name));
    let points: MermaidPoint[] = [], curved = false;
    if (element.tagName.toLowerCase() === "line") points = [{ x: read("x1"), y: read("y1") }, { x: read("x2"), y: read("y2") }];
    else {
      const path = element as SVGPathElement, d = path.getAttribute("d") || "";
      curved = /[cqsta]/i.test(d.replace(/[\deE+.,\s-]/g, ""));
      // Mermaid emits absolute M/L for straight and stepped connectors. Keep
      // every corner; length sampling would cut across those corners.
      if (!curved) points = linearPathPoints(d);
      else if (path.getTotalLength && path.getPointAtLength) {
        const length = path.getTotalLength(), count = Math.min(192, Math.max(32, Math.ceil(length / 8)));
        const samples = Array.from({ length: count + 1 }, (_, i) => {
          const point = path.getPointAtLength(length * i / count);
          return { x: point.x, y: point.y };
        });
        points = compactNativeCurve(samples);
      }
    }
    return { curved, points: points.map((point) => this.point(element, point)) };
  }

  edge(attributes: Attributes, route: MermaidRoute, terminals?: { source: MermaidBox; target: MermaidBox }, label?: MermaidPoint): Element {
    const points = route.points.map((point) => this.map(point));
    const first = route.points[0], last = route.points.at(-1);
    const anchor = (name: string, point: MermaidPoint, box: MermaidBox, terminal: string | number) => {
      let x = (point.x - box.x) / (box.width || 1), y = (point.y - box.y) / (box.height || 1);
      // Legacy draw.io swaps flip axes for north/south shapes even when
      // anchorPointDirection=0. Compensate before its flip/rotation transform.
      if (this.verticalTerminals.has(String(terminal)) && this.transform.flipX !== this.transform.flipY) { x = 1 - x; y = 1 - y; }
      return `${name}X=${round(x)};${name}Y=${round(y)};${name}Perimeter=0;`;
    };
    const ports = terminals && first && last ? anchor("exit", first, terminals.source, attributes.source) + anchor("entry", last, terminals.target, attributes.target) : "";
    const cell = drawioCell(this.page, { ...attributes, edge: 1,
      style: `${attributes.style || ""}shape=connector;edgeStyle=none;noEdgeStyle=1;rounded=0;curved=${Number(route.curved)};${ports}` }, { relative: 1 });
    const geometry = cell.querySelector("mxGeometry")!;
    const pointElement = (point: MermaidPoint, as?: string) => drawioElement(this.page.model.ownerDocument, "mxPoint", { x: round(point.x), y: round(point.y), ...(as ? { as } : {}) });
    if (points.length >= 2) {
      geometry.append(pointElement(points[0], "sourcePoint"), pointElement(points.at(-1)!, "targetPoint"));
      if (points.length > 2) {
        const array = drawioElement(this.page.model.ownerDocument, "Array", { as: "points" });
        array.append(...points.slice(1, -1).map((point) => pointElement(point))); geometry.append(array);
      }
      if (label) {
        const center = routeMidpoint(points), position = this.map(label);
        geometry.append(pointElement({ x: position.x - center.x, y: position.y - center.y }, "offset"));
      }
    }
    return cell;
  }
}

/** Only the first independent cell owns original source metadata. This is an
 * mxGraph user object, not a parent/group, so clicking never selects the lot. */
export function retainMermaidSource(page: DrawioPage, cell: Element, source: string): void {
  const object = drawioElement(page.model.ownerDocument, "object", { id: cell.getAttribute("id")!, label: cell.getAttribute("value") || "",
    mermaidSource: source, taomniKind: "mermaid", tooltip: source });
  cell.removeAttribute("id"); cell.removeAttribute("value"); cell.replaceWith(object); object.append(cell);
}

export function linearPathPoints(d: string): MermaidPoint[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
  const points: MermaidPoint[] = [];
  let command = "", point = { x: 0, y: 0 }, index = 0;
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++];
    if (!/^[mlhv]$/i.test(command)) return [];
    const relative = command === command.toLowerCase(), kind = command.toLowerCase();
    const a = Number(tokens[index++]);
    const b = kind === "h" || kind === "v" ? 0 : Number(tokens[index++]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
    point = kind === "h" ? { x: a + (relative ? point.x : 0), y: point.y }
      : kind === "v" ? { x: point.x, y: a + (relative ? point.y : 0) }
        : { x: a + (relative ? point.x : 0), y: b + (relative ? point.y : 0) };
    points.push(point);
    if (kind === "m") command = relative ? "l" : "L";
  }
  return points;
}

function routeMidpoint(points: MermaidPoint[]): MermaidPoint {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) {
      const ratio = lengths[i] ? remaining / lengths[i] : 0;
      return { x: points[i].x + (points[i + 1].x - points[i].x) * ratio, y: points[i].y + (points[i + 1].y - points[i].y) * ratio };
    }
    remaining -= lengths[i];
  }
  return points[0];
}
