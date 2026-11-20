import { svgGeometry } from "./docxImages";
import { drawioFile } from "./drawioCodec";
import { renderedDrawioPage } from "./drawioRender";

export type DiagramKind = "mermaid" | "drawio";
export const MARKDOWN_DIAGRAM_SELECTOR = ".fv-md-mermaid,.fv-md-drawio";
export const MARKDOWN_IMAGE_SELECTOR = ".fv-md-image-frame > img,.fv-md-rendered-block img,.fv-md-doc img";
export type MarkdownVisualKind = DiagramKind | "image";
export function diagramKind(element: HTMLElement | null): DiagramKind {
  return element?.classList.contains("fv-md-drawio") ? "drawio" : "mermaid";
}

export interface DiagramDefinition { source: string; theme: "light" | "dark"; kind?: DiagramKind }
export interface DiagramSnapshot extends DiagramDefinition {
  svg: SVGSVGElement;
  width: number;
  height: number;
  text: string;
  filename: string;
}
export interface ImageSnapshot {
  kind: "image";
  src: string;
  alt: string;
  width: number;
  height: number;
  filename: string;
}
export type MarkdownVisualSnapshot = DiagramSnapshot | ImageSnapshot;

export function loadedMarkdownImage(element: Element | null): element is HTMLImageElement {
  return element instanceof HTMLImageElement && element.matches(MARKDOWN_IMAGE_SELECTOR)
    && element.complete && element.naturalWidth > 0 && /^data:image\//i.test(element.src);
}

export function snapshotMarkdownImage(image: HTMLImageElement, filename: string): ImageSnapshot {
  return { kind: "image", src: image.src, alt: image.alt, width: image.naturalWidth, height: image.naturalHeight, filename };
}
const definitions = new WeakMap<HTMLElement, DiagramDefinition>();

/** Source belongs to this exact render, never a global “last Mermaid” string. */
export function rememberDiagram(element: HTMLElement, definition: DiagramDefinition): void {
  definitions.set(element, definition);
}

/** Read explicit SVG line structure even in an off-screen measuring clone. */
export function diagramLabelText(text: Element): string {
  let value = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { value += node.textContent || ""; return; }
    if (!(node instanceof Element)) return;
    const line = node.tagName.toLowerCase() === "tspan" && (node.hasAttribute("x") || node.hasAttribute("y") || Number.parseFloat(node.getAttribute("dy") || "0") !== 0);
    if (line && value.trim() && !value.endsWith("\n")) value += "\n";
    node.childNodes.forEach(visit);
  };
  text.childNodes.forEach(visit);
  return value.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** Mermaid's SVG text is generated from its definition. Read those structured
 * labels, including multiline tspans, without OCR, node IDs or CSS/source code. */
export function diagramText(svg: SVGSVGElement): string {
  return Array.from(svg.querySelectorAll("text,foreignObject")).flatMap((text) => {
    if (text.closest("defs,title,desc,symbol")) return [];
    if (text.localName === "text" && text.closest("switch")?.querySelector("foreignObject")) return [];
    for (let node: Element | null = text; node && svg.contains(node); node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return [];
    }
    const value = text.localName === "foreignObject"
      ? (text.firstElementChild instanceof HTMLElement ? text.firstElementChild.innerText : undefined) || text.textContent?.trim()
      : diagramLabelText(text);
    return value ? [value] : [];
  }).join("\n");
}

export function snapshotDiagram(element: HTMLElement, filename: string): DiagramSnapshot {
  const svg = element.querySelector<SVGSVGElement>("svg");
  const page = renderedDrawioPage(element);
  const definition: DiagramDefinition | undefined = page ? { source: drawioFile([page]), theme: "light", kind: "drawio" } : definitions.get(element);
  if (!svg || !definition) throw new Error("The diagram is not ready");
  return { ...definition, ...svgGeometry(svg), svg: svg.cloneNode(true) as SVGSVGElement, text: diagramText(svg), filename };
}

export type DiagramViewMode = "fit" | "width" | "actual" | "custom";
export interface DiagramTransform {
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}
export interface DiagramView extends DiagramTransform {
  mode: DiagramViewMode;
  scale: number;
  x: number;
  y: number;
}
export const DEFAULT_DIAGRAM_VIEW: DiagramView = { rotation: 0, flipX: false, flipY: false, mode: "fit", scale: 1, x: 0, y: 0 };
export const normalizeRotation = (rotation: number) => ((rotation % 360) + 360) % 360;
export const clampDiagramScale = (scale: number) => Math.min(16, Math.max(0.05, scale));
export function diagramBounds(width: number, height: number, rotation: number) {
  return normalizeRotation(rotation) % 180 === 90 ? { width: height, height: width } : { width, height };
}
export function diagramScale(view: DiagramView, image: { width: number; height: number }, stage: { width: number; height: number }): number {
  if (view.mode === "actual") return 1;
  if (view.mode === "custom") return view.scale;
  const box = diagramBounds(image.width, image.height, view.rotation);
  const horizontal = Math.max(1, stage.width - 32) / box.width;
  return clampDiagramScale(view.mode === "width" ? horizontal : Math.min(horizontal, Math.max(1, stage.height - 32) / box.height));
}
export function zoomDiagram(view: DiagramView, scale: number, factor: number, point = { x: 0, y: 0 }): DiagramView {
  const next = clampDiagramScale(scale * factor), ratio = next / scale;
  return { ...view, mode: "custom", scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}
