import type { MarkdownExportSettings } from "./exportModel";

export interface PdfFragment { top: number; bottom: number }
export function pdfPageLayout(settings: MarkdownExportSettings) {
  const size = settings.paper === "A4" ? [210, 297] : [215.9, 279.4];
  const [width, height] = settings.orientation === "landscape" ? [size[1], size[0]] : size;
  const margin = settings.margins === "narrow" ? 12 : settings.margins === "wide" ? 32 : 20;
  const px = 96 / 25.4;
  return { width, height, margin, pixelWidth: width * px, pixelHeight: height * px,
    contentWidth: (width - margin * 2) * px, contentHeight: (height - margin * 2) * px, inset: margin * px };
}

/** Move a page boundary before a line/row/image, rather than slicing its ink.
 * Oversized blocks may span pages; their individual text lines are also inputs. */
export function paginatePdf(height: number, pageHeight: number, fragments: PdfFragment[]): PdfFragment[] {
  if (!(Number.isFinite(height) && height > 0 && Number.isFinite(pageHeight) && pageHeight > 0)) throw new Error("Invalid PDF page geometry");
  const pages: PdfFragment[] = [];
  let top = 0;
  while (top < height - 0.1) {
    let bottom = Math.min(height, top + pageHeight);
    if (bottom < height) {
      let previous = bottom + 1;
      while (bottom < previous) {
        previous = bottom;
        for (const fragment of fragments) {
          if (fragment.bottom - fragment.top > pageHeight || fragment.top <= top + 0.5) continue;
          if (fragment.top < bottom - 0.1 && fragment.bottom > bottom + 0.1) bottom = Math.min(bottom, fragment.top);
        }
      }
    }
    if (bottom <= top + 0.5) bottom = Math.min(height, top + pageHeight);
    pages.push({ top, bottom }); top = bottom;
    if (pages.length > 200) throw new Error("Document exceeds the 200-page PDF export limit; split it into smaller documents");
  }
  return pages;
}

export function pdfFragments(root: HTMLElement): PdfFragment[] {
  const offset = root.getBoundingClientRect().top;
  const fragments: PdfFragment[] = [];
  const add = (rect: DOMRect) => { if (rect.height > 0) fragments.push({ top: rect.top - offset, bottom: rect.bottom - offset }); };
  root.querySelectorAll("img,svg,table tr,h1,h2,h3,h4,h5,h6").forEach((node) => {
    add(node.getBoundingClientRect());
    if (/^H[1-6]$/.test(node.tagName)) {
      const next = node.nextElementSibling;
      if (next) fragments.push({ top: node.getBoundingClientRect().top - offset, bottom: Math.min(next.getBoundingClientRect().bottom, next.getBoundingClientRect().top + 28) - offset });
    }
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim() || node.parentElement?.closest("svg,style,.katex-mathml")) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    Array.from(range.getClientRects()).forEach(add);
  }
  return fragments;
}
