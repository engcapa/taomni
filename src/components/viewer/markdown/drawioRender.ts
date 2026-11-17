import DOMPurify from "dompurify";
import { drawioElement, type DrawioPage } from "./drawioCodec";

export interface DrawioPreview { svg: string; width: number; height: number; warnings: string[] }
const SVG_NS = "http://www.w3.org/2000/svg";
const importedPages = new WeakMap<HTMLElement, DrawioPage>();
export function rememberDrawio(element: HTMLElement, page: DrawioPage): void { importedPages.set(element, page); }
export function renderedDrawioPage(element: HTMLElement): DrawioPage | undefined { return importedPages.get(element); }

export function drawioPlainText(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: ["br", "p", "div", "li", "tr"], ALLOWED_ATTR: [] });
  template.content.querySelectorAll("br").forEach((element) => element.replaceWith("\n"));
  template.content.querySelectorAll("p,div,li,tr").forEach((element) => element.append("\n"));
  return template.content.textContent?.trim() || "";
}

/** Rebuild a rendering copy from a small model schema. Raw XML is retained
 * separately; external links, executable HTML and remote images never reach
 * the graph decoder or the WebView network stack. */
export function safeDrawioModel(page: DrawioPage): Element {
  const doc = document.implementation.createDocument("", "mxGraphModel");
  const root = doc.createElement("root"); doc.documentElement.append(root);
  const sources = Array.from(page.model.querySelector("root")!.children);
  const ids = new Set<string>();
  const parents = new Map<string, string>();
  for (const source of sources) {
    const cell = source.tagName === "mxCell" ? source : source.querySelector(":scope > mxCell");
    if (!cell) continue;
    const id = source.getAttribute("id") || cell.getAttribute("id") || "";
    if (!id || ids.has(id)) throw new Error("Invalid draw.io cell identity");
    ids.add(id); parents.set(id, cell.getAttribute("parent") || "");
    const attrs: Record<string, string> = { id };
    for (const key of ["parent", "vertex", "edge", "source", "target", "collapsed", "visible"]) {
      const value = cell.getAttribute(key); if (value !== null) attrs[key] = value;
    }
    const rawLabel = source === cell ? cell.getAttribute("value") || "" : source.getAttribute("label") || "";
    attrs.value = drawioPlainText(rawLabel);
    const style = cell.getAttribute("style") || "";
    const parts = style.split(";").filter(Boolean).map((entry) => {
      const [key, ...rest] = entry.split("=");
      const value = rest.join("=");
      if (key === "image") {
        if (!/^data:image\/(?:png|jpe?g|gif|webp|bmp),[a-z\d+/=]+$/i.test(value)) {
          // SVG data needs a full sanitizer before it can be used as an image.
          if (!/^data:image\/svg\+xml,[a-z\d+/=]+$/i.test(value)) throw new Error("draw.io contains an external or unsupported image; embed images before importing");
          const svg = new TextDecoder().decode(Uint8Array.from(atob(value.split(",")[1]), (char) => char.charCodeAt(0)));
          const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["image", "use", "foreignObject", "style", "a"], FORBID_ATTR: ["href", "xlink:href"] });
          return `image=data:image/svg+xml,${encodeURIComponent(clean)}`;
        } else return `image=${value.replace(",", ";base64,")}`;
      }
      if (/javascript:|https?:|file:|url\(|expression\(|<|>/i.test(entry)) throw new Error("draw.io contains an unsafe style");
      return key === "html" ? "html=0" : entry;
    });
    attrs.style = parts.join(";");
    const target = drawioElement(doc, "mxCell", attrs);
    const geometry = cell.querySelector(":scope > mxGeometry");
    if (geometry) {
      const allowedTags = new Set(["mxGeometry", "mxPoint", "Array", "mxRectangle"]);
      const allowedAttrs = new Set(["x", "y", "width", "height", "relative", "as"]);
      const copy = (node: Element): Element => {
        if (!allowedTags.has(node.tagName)) throw new Error("Unsupported draw.io geometry");
        const output = doc.createElement(node.tagName);
        for (const attr of Array.from(node.attributes)) if (allowedAttrs.has(attr.name)) {
          if (attr.name !== "as" && (!Number.isFinite(Number(attr.value)) || Math.abs(Number(attr.value)) > 1000000)) throw new Error("draw.io geometry exceeds safe bounds");
          output.setAttribute(attr.name, attr.value);
        }
        for (const child of Array.from(node.children)) output.append(copy(child));
        return output;
      };
      target.append(copy(geometry));
    }
    root.append(target);
  }
  for (const id of ids) {
    const path = new Set<string>(); let cursor = id;
    while (parents.get(cursor)) {
      if (path.has(cursor) || path.size > 100) throw new Error("draw.io contains cyclic or deeply nested parents");
      path.add(cursor); cursor = parents.get(cursor)!;
      if (!ids.has(cursor)) throw new Error("draw.io has a missing parent cell");
    }
  }
  return doc.documentElement;
}

export async function renderDrawioPage(page: DrawioPage): Promise<DrawioPreview> {
  const model = safeDrawioModel(page);
  const { Graph, ModelXmlSerializer, ImageExport, SvgCanvas2D } = await import("@maxgraph/core");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none";
  document.body.append(host);
  const graph = new Graph(host, undefined, []);
  try {
    graph.setEnabled(false); graph.setHtmlLabels(false);
    new ModelXmlSerializer(graph.getDataModel()).import(model);
    graph.getView().validate();
    await document.fonts?.ready;
    const bounds = graph.getGraphBounds();
    if (!Number.isFinite(bounds.width) || bounds.width > 100000 || bounds.height > 100000) throw new Error("draw.io sheet is too large to preview");
    const width = Math.max(80, Math.ceil(bounds.width + 24)), height = Math.max(60, Math.ceil(bounds.height + 24));
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS); svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height)); svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const canvas = new SvgCanvas2D(svg, false); canvas.foEnabled = false;
    canvas.translate(12 - bounds.x, 12 - bounds.y);
    const graphRoot = graph.getDataModel().getRoot();
    if (!graphRoot) throw new Error("draw.io has no graph root");
    const state = graph.getView().getState(graphRoot);
    if (state) new ImageExport().drawState(state, canvas);
    const warnings: string[] = [];
    if (Array.from(model.querySelectorAll("mxCell")).some((cell) => /shape=mxgraph\./.test(cell.getAttribute("style") || ""))) warnings.push("Custom stencil shapes may use a basic outline in this preview. Original draw.io data is retained.");
    return { svg: new XMLSerializer().serializeToString(svg), width, height, warnings };
  } finally { graph.destroy(); host.remove(); }
}
