import { markdownExportCss, type MarkdownExportSettings } from "./exportModel";
import { paginatePdf, pdfFragments, pdfPageLayout } from "./pdfPages";
import { paintPdfImages, preparePdfImages } from "./pdfImages";

/** Printer-independent, offline PDF. Each page is rendered at 300 DPI with the
 * same browser typography/math/diagrams as HTML. No OS print API is invoked.
 * Page-sized canvases bound memory independently of total document height. */
export async function markdownPdf(source: HTMLElement, title: string, settings: MarkdownExportSettings, css = markdownExportCss(settings, title)): Promise<Blob> {
  const [{ jsPDF }, capture] = await Promise.all([import("jspdf"), import("html-to-image")]);
  const layout = pdfPageLayout(settings);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;z-index:-1";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `${css}.fv-md-export{padding:0;margin:0;max-width:none;display:flow-root;overflow-wrap:anywhere}.fv-md-export img,.fv-md-export svg{max-height:${layout.contentHeight}px;object-fit:contain}pre{overflow:hidden} .katex-mathml{display:none}`;
  const page = document.createElement("div");
  const background = settings.theme === "dark" ? "#191c22" : "#ffffff";
  page.style.cssText = `position:relative;width:${layout.pixelWidth}px;height:${layout.pixelHeight}px;background:${background};color:${settings.theme === "dark" ? "#e5e7eb" : "#1f2937"};font:15px/1.75 system-ui,sans-serif;overflow:hidden`;
  const viewport = document.createElement("div");
  viewport.style.cssText = `position:absolute;left:${layout.inset}px;top:${layout.inset}px;width:${layout.contentWidth}px;overflow:hidden`;
  const root = source.cloneNode(true) as HTMLElement;
  viewport.append(root); page.append(viewport); shadow.append(style, page); document.body.append(host);
  try {
    await Promise.all(Array.from(root.querySelectorAll("img")).map((image) => image.decode()));
    await document.fonts?.ready;
    const images = preparePdfImages(root);
    const height = root.getBoundingClientRect().height;
    const pages = paginatePdf(Math.max(1, height), layout.contentHeight, pdfFragments(root));
    const pdf = new jsPDF({ orientation: settings.orientation, unit: "mm", format: [layout.width, layout.height], compress: true });
    pdf.setProperties({ title, creator: "Taomni" });
    const header = document.createElement("div"), footer = document.createElement("div");
    header.style.cssText = `position:absolute;left:${layout.inset}px;right:${layout.inset}px;top:${Math.max(2, layout.inset / 2 - 7)}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:11px system-ui,sans-serif`;
    footer.style.cssText = `position:absolute;left:0;right:0;bottom:${Math.max(2, layout.inset / 2 - 7)}px;text-align:center;font:11px system-ui,sans-serif`;
    if (settings.fileHeader) { header.textContent = title; page.append(header); }
    if (settings.pageNumbers) page.append(footer);
    // Embed the fonts used by the document once, including KaTeX's local fonts.
    const fontEmbedCSS = await capture.getFontEmbedCSS(page);
    for (const [index, slice] of pages.entries()) {
      if (index > 0) pdf.addPage([layout.width, layout.height], settings.orientation);
      viewport.style.height = `${slice.bottom - slice.top}px`;
      root.style.transform = `translateY(-${slice.top}px)`;
      footer.textContent = `${index + 1} / ${pages.length}`;
      const canvas = await capture.toCanvas(page, { pixelRatio: 300 / 96, fontEmbedCSS,
        width: layout.pixelWidth, height: layout.pixelHeight, backgroundColor: background });
      paintPdfImages(images, canvas, page, viewport);
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, layout.width, layout.height, undefined, "FAST");
      canvas.width = 0; canvas.height = 0;
    }
    return pdf.output("blob");
  } finally { host.remove(); }
}
