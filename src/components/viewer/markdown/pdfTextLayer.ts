import type { PdfSearchFont } from "./pdfSearchFont";

export interface PdfTextCluster {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Measure the original DOM once, before applying page translations. Grapheme
 * boxes preserve wrapping, mixed fonts, spaces, emoji and SVG label geometry. */
export function pdfTextClusters(root: HTMLElement): PdfTextCluster[] {
  const origin = root.getBoundingClientRect();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const range = document.createRange();
  const clusters: PdfTextCluster[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!node.textContent || !parent || parent.closest("script,style,noscript,svg title,svg desc,svg defs,.katex-mathml")) continue;
    let hidden = false;
    const clips: DOMRect[] = [];
    for (let owner: Element | null = parent; owner && owner !== root; owner = owner.parentElement) {
      const style = getComputedStyle(owner);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") { hidden = true; break; }
      if (/(hidden|clip|auto|scroll)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) clips.push(owner.getBoundingClientRect());
    }
    if (hidden) continue;
    for (const { segment, index } of segmenter.segment(node.textContent)) {
      range.setStart(node, index);
      range.setEnd(node, index + segment.length);
      const rect = range.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
      for (const clip of clips) {
        left = Math.max(left, clip.left); right = Math.min(right, clip.right);
        top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
      }
      if (right <= left || bottom <= top) continue;
      clusters.push({ text: segment, left: left - origin.left, top: top - origin.top, width: right - left, height: bottom - top });
    }
  }
  return clusters;
}

export function paintPdfText(
  font: PdfSearchFont,
  clusters: PdfTextCluster[],
  page: { pixelHeight: number; inset: number; contentWidth: number },
  slice: { top: number; bottom: number },
) {
  const points = 72 / 96;
  for (const cluster of clusters) {
    const center = cluster.top + cluster.height / 2;
    // Assign every grapheme to one page, even when an oversized block spans pages.
    if (center < slice.top || center >= slice.bottom || cluster.left >= page.contentWidth || cluster.left + cluster.width <= 0) continue;
    const left = Math.max(0, cluster.left);
    const right = Math.min(page.contentWidth, cluster.left + cluster.width);
    font.write(cluster.text, (page.inset + left) * points,
      (page.inset + cluster.top - slice.top + cluster.height) * points,
      (right - left) * points, cluster.height * points, page.pixelHeight * points);
  }
}

export function paintPdfPageLabel(font: PdfSearchFont, label: HTMLElement, page: HTMLElement) {
  const origin = page.getBoundingClientRect(), box = label.getBoundingClientRect();
  const points = 72 / 96;
  for (const cluster of pdfTextClusters(label)) {
    if (cluster.left >= box.width || cluster.left + cluster.width <= 0) continue;
    font.write(cluster.text, (box.left - origin.left + cluster.left) * points,
      (box.top - origin.top + cluster.top + cluster.height) * points,
      Math.min(cluster.width, box.width - cluster.left) * points, cluster.height * points, origin.height * points);
  }
}
