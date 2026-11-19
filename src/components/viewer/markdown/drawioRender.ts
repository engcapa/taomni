import DOMPurify from "dompurify";
import { drawioElement, type DrawioPage } from "./drawioCodec";
import { sanitizeDrawioStyle } from "./drawioImageStyle";
import { readDrawioGraph } from "./drawioModel";
import { renderInDrawioFrame } from "./drawioFrameClient";
import { safeDrawioLabel, safeDrawioSvg } from "./drawioLabels";
import { svgGeometry } from "./docxImages";

export interface DrawioPreview { svg: string; width: number; height: number; warnings: string[]; missingImages: number }
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
function prepareDrawioModel(page: DrawioPage, rich: boolean): { model: Element; missingImages: number } {
  const doc = document.implementation.createDocument("", "mxGraphModel");
  const background = page.model.getAttribute("background");
  if (background && /^(?:#[a-f\d]{3,8}|none|white|black)$/i.test(background)) doc.documentElement.setAttribute("background", background);
  if (page.model.getAttribute("shadow") === "1") doc.documentElement.setAttribute("shadow", "1");
  const root = doc.createElement("root"); doc.documentElement.append(root);
  const { cells } = readDrawioGraph(page.model);
  let missingImages = 0;
  for (const [id, { element, cell }] of cells) {
    const attrs: Record<string, string> = { id };
    for (const key of ["parent", "vertex", "edge", "source", "target", "collapsed", "visible"]) {
      const value = cell.getAttribute(key); if (value !== null) attrs[key] = value;
    }
    const rawLabel = element === cell ? cell.getAttribute("value") || "" : element.getAttribute("label") || "";
    const style = cell.getAttribute("style") || "";
    attrs.value = rich && /(?:^|;)html=1(?:;|$)/.test(style) ? safeDrawioLabel(rawLabel) : drawioPlainText(rawLabel);
    const sanitized = sanitizeDrawioStyle(style, rich);
    attrs.style = sanitized.style;
    missingImages += sanitized.missingImages;
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
  return { model: doc.documentElement, missingImages };
}

export function safeDrawioModel(page: DrawioPage, rich = true): Element {
  return prepareDrawioModel(page, rich).model;
}

export async function renderDrawioPage(page: DrawioPage, rich = true): Promise<DrawioPreview> {
  const { model, missingImages } = prepareDrawioModel(page, rich);
  const svg = safeDrawioSvg(await renderInDrawioFrame(model, rich));
  const warnings: string[] = [];
  if (Array.from(page.model.querySelectorAll("mxCell")).some((cell) => /shape=mxgraph\./.test(cell.getAttribute("style") || ""))) warnings.push("Some custom stencils require assets outside the bundled viewer. Original draw.io data is retained.");
  return { svg: new XMLSerializer().serializeToString(svg), ...svgGeometry(svg), warnings, missingImages };
}
