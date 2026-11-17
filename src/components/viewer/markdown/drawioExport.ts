import { bytesDataUrl } from "../../../lib/markdownAssets";
import { drawioCell, drawioElement, drawioFile, newDrawioPage, type DrawioPage } from "./drawioCodec";
import { DEFAULT_DIAGRAM_VIEW, snapshotDiagram, type DiagramSnapshot, type DiagramTransform } from "./diagramModel";
import { diagramSvg } from "./diagramExport";
import { mermaidDrawioCells } from "./drawioMermaid";
import { renderedDrawioPage } from "./drawioRender";

export interface DrawioExportOptions { scope: "document" | "images"; layout: "separate" | "single" }
export const DEFAULT_DRAWIO_OPTIONS: DrawioExportOptions = { scope: "document", layout: "separate" };
export interface DrawioExportDocument { xml: string; pages: number; nativeDiagrams: number; fallbackDiagrams: number }
const TEXT_STYLE = "text;html=1;whiteSpace=wrap;overflow=fill;align=left;verticalAlign=top;spacing=8;fontSize=15;fontColor=#1f2937;";

async function svgImageCell(page: DrawioPage, image: DiagramSnapshot, transform: DiagramTransform, id: string, x: number, y: number): Promise<Element> {
  const svg = await diagramSvg(image, transform);
  const url = bytesDataUrl(new TextEncoder().encode(svg), "image/svg+xml").replace(";base64,", ",");
  const cell = drawioCell(page, { id, vertex: 1, value: "", style: `shape=image;imageAspect=1;aspect=fixed;image=${url};` }, { x, y, width: image.width, height: image.height });
  const object = drawioElement(page.model.ownerDocument, "object", { id, label: "", mermaidSource: image.source, taomniKind: "mermaid-svg", tooltip: "SVG fallback: edit Mermaid source" });
  cell.removeAttribute("id"); cell.replaceWith(object); object.append(cell);
  return cell;
}

export async function singleDiagramDrawio(image: DiagramSnapshot, transform: DiagramTransform = DEFAULT_DIAGRAM_VIEW): Promise<DrawioExportDocument> {
  const page = newDrawioPage("diagram-1", image.filename);
  const converted = await mermaidDrawioCells(page, image, transform, "mermaid", 40, 40);
  if (!converted) await svgImageCell(page, image, transform, "mermaid", 40, 40);
  return { xml: drawioFile([page]), pages: 1, nativeDiagrams: Number(converted), fallbackDiagrams: Number(!converted) };
}

/** Text stays as editable HTML text cells. Each table cell has independent
 * geometry and a shared row/group parent, so diagrams.net can edit its data. */
export async function markdownDrawio(root: HTMLElement, title: string, options: DrawioExportOptions): Promise<DrawioExportDocument> {
  const pages: DrawioPage[] = [];
  const main = newDrawioPage("document", title);
  if (options.scope === "document" || options.layout === "single") pages.push(main);
  let cursor = 40, index = 0, images = 0, nativeDiagrams = 0, fallbackDiagrams = 0;
  const text = (element: HTMLElement) => {
    if (options.scope !== "document" || !element.textContent?.trim()) return;
    const size = /^H[1-6]$/.test(element.tagName) ? Math.max(16, 30 - Number(element.tagName[1]) * 2) : 15;
    const clone = element.cloneNode(true) as HTMLElement;
    clone.style.cssText = "margin:0;font-size:inherit;line-height:1.6";
    const lines = (element.innerText || element.textContent || "").split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 65)), 0);
    const height = Math.max(40, lines * (size + 9) + 18);
    drawioCell(main, { id: `text-${++index}`, vertex: 1, value: clone.outerHTML, style: `${TEXT_STYLE}fontSize=${size};`, taomniKind: "text", taomniTag: element.tagName.toLowerCase() }, { x: 40, y: cursor, width: 800, height });
    cursor += height + 16;
  };
  const table = (element: HTMLTableElement) => {
    if (options.scope !== "document") return;
    const rows = Array.from(element.rows), columns = Math.max(...rows.map((row) => row.cells.length));
    if (!rows.length || !columns) return;
    const id = `table-${++index}`, width = Math.max(800, columns * 120), cellWidth = width / columns;
    const heights = rows.map((row) => Math.max(40, ...Array.from(row.cells).map((cell) => Math.ceil((cell.textContent?.length || 1) / Math.max(8, cellWidth / 9)) * 24 + 16)));
    const total = heights.reduce((sum, height) => sum + height, 0);
    drawioCell(main, { id, vertex: 1, value: "", style: "group;", taomniKind: "table", taomniColumns: columns }, { x: 40, y: cursor, width, height: total });
    let top = 0;
    rows.forEach((row, rowIndex) => {
      Array.from(row.cells).forEach((cell, column) => drawioCell(main, { id: `${id}-${rowIndex}-${column}`, parent: id, vertex: 1, value: cell.innerHTML,
        style: `whiteSpace=wrap;html=1;align=left;verticalAlign=middle;spacing=8;strokeColor=#cbd5e1;fillColor=${cell.tagName === "TH" ? "#e2e8f0" : "#ffffff"};fontColor=#1f2937;fontSize=14;`,
        taomniRow: rowIndex, taomniColumn: column, taomniHeader: Number(cell.tagName === "TH") }, { x: column * cellWidth, y: top, width: cellWidth, height: heights[rowIndex] }));
      top += heights[rowIndex];
    });
    cursor += total + 24;
  };
  const picture = async (element: HTMLElement) => {
    const number = ++images;
    const imported = renderedDrawioPage(element);
    const name = imported?.name || (element instanceof HTMLImageElement ? element.alt || `Image ${number}` : `Mermaid ${number}`);
    const separate = options.layout === "separate";
    const page = separate ? newDrawioPage(`image-${number}`, `${number} · ${name}`.slice(0, 100)) : main;
    const y = separate ? 40 : cursor;
    let height: number;
    if (imported) {
      const width = Number(element.querySelector("svg")?.getAttribute("width")) || 800;
      height = Number(element.querySelector("svg")?.getAttribute("height")) || 600;
      const group = `import-${number}`;
      drawioCell(page, { id: group, vertex: 1, value: "", style: "group;" }, { x: 40, y, width, height });
      const oldRoot = imported.model.querySelector("root")!;
      for (const source of Array.from(oldRoot.children)) {
        const cell = source.tagName === "mxCell" ? source : source.querySelector("mxCell");
        const id = source.getAttribute("id") || cell?.getAttribute("id");
        if (!cell || !id || id === "0" || id === "1") continue;
        const copy = source.cloneNode(true) as Element;
        copy.querySelectorAll("mxCell").forEach((node) => {
          for (const key of ["id", "parent", "source", "target"]) {
            const value = node.getAttribute(key);
            if (value) node.setAttribute(key, value === "1" && key === "parent" ? group : `${group}-${value}`);
          }
        });
        if (copy.tagName === "mxCell") for (const key of ["id", "parent", "source", "target"]) {
          const value = copy.getAttribute(key); if (value) copy.setAttribute(key, value === "1" && key === "parent" ? group : `${group}-${value}`);
        }
        else copy.setAttribute("id", `${group}-${id}`);
        page.model.querySelector("root")!.append(copy);
      }
    } else if (element.classList.contains("fv-md-mermaid")) {
      const snapshot = snapshotDiagram(element, name);
      const native = await mermaidDrawioCells(page, snapshot, DEFAULT_DIAGRAM_VIEW, `diagram-${number}`, 40, y);
      if (!native) await svgImageCell(page, snapshot, DEFAULT_DIAGRAM_VIEW, `diagram-${number}`, 40, y);
      nativeDiagrams += Number(native); fallbackDiagrams += Number(!native);
      height = snapshot.height;
    } else {
      const image = element as HTMLImageElement;
      await image.decode();
      const src = image.getAttribute("src") || "";
      if (!/^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,/i.test(src)) throw new Error("Images must be embedded before draw.io export");
      const width = Math.min(800, image.naturalWidth || 640);
      height = width * (image.naturalHeight || 480) / (image.naturalWidth || 640);
      drawioCell(page, { id: `image-${number}`, vertex: 1, value: "", style: `shape=image;imageAspect=1;aspect=fixed;image=${src.replace(";base64,", ",")};`, tooltip: name }, { x: 40, y, width, height });
    }
    if (separate) {
      pages.push(page);
      if (options.scope === "document") {
        drawioCell(main, { id: `reference-${number}`, vertex: 1, value: `↗ ${page.name}`, link: `data:page/id,${page.id}`, style: `${TEXT_STYLE}fontColor=#2563eb;`, taomniKind: "sheet-reference" }, { x: 40, y: cursor, width: 800, height: 44 });
        cursor += 60;
      }
    } else cursor += height + 24;
  };
  const visit = async (element: HTMLElement): Promise<void> => {
    if (element.matches(".fv-md-drawio-source")) return;
    if (element.matches(".fv-md-mermaid,.fv-md-drawio,img")) { await picture(element); return; }
    if (element instanceof HTMLTableElement) { table(element); return; }
    if (!element.querySelector(".fv-md-mermaid,.fv-md-drawio,img,table")) { text(element); return; }
    for (const child of Array.from(element.childNodes)) {
      if (child instanceof HTMLElement) await visit(child);
      else if (child.textContent?.trim()) { const paragraph = document.createElement("p"); paragraph.textContent = child.textContent; text(paragraph); }
    }
  };
  for (const element of Array.from(root.children)) if (element instanceof HTMLElement) await visit(element);
  if (options.scope === "images" && !images) throw new Error("This Markdown document contains no images or diagrams");
  return { xml: drawioFile(pages), pages: pages.length, nativeDiagrams, fallbackDiagrams };
}
