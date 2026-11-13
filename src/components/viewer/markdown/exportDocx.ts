import type { Paragraph, ParagraphChild, Table, RunOptions } from "./docxRuntime.js";
import type { MarkdownExportSettings } from "./exportModel";

async function imageData(source: string): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve(); image.onerror = () => reject(new Error("Cannot decode an exported image")); image.src = source;
  });
  const width = image.naturalWidth || 640, height = image.naturalHeight || 360;
  if (width * height > 40_000_000) throw new Error("An image exceeds the safe Word conversion size");
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image conversion is unavailable");
  context.drawImage(image, 0, 0);
  const data = canvas.toDataURL("image/png").split(",")[1];
  const binary = atob(data);
  const ratio = Math.min(1, 600 / width);
  return { bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)), width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

/** Convert the already-sanitized, image-embedded rendering, not a second
 * Markdown parse. The document library is fetched only on the Word path. */
export async function markdownDocx(root: HTMLElement, title: string, settings: MarkdownExportSettings): Promise<Blob> {
  const d = await import("./docxRuntime.js");
  const inline = async (node: Node, style: RunOptions = {}): Promise<ParagraphChild[]> => {
    if (node.nodeType === Node.TEXT_NODE) return [new d.TextRun({ ...style, text: node.textContent || "" })];
    if (!(node instanceof Element)) return [];
    const tag = node.tagName.toLowerCase();
    if (tag === "br") return [new d.TextRun({ break: 1 })];
    if (tag === "img" || tag === "svg") {
      const src = tag === "img" ? node.getAttribute("src") || "" : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(node))}`;
      const image = await imageData(src);
      return [new d.ImageRun({ type: "png", data: image.bytes, transformation: { width: image.width, height: image.height },
        altText: { title: node.getAttribute("alt") || "Diagram", description: node.getAttribute("alt") || "", name: "Image" } })];
    }
    const next: RunOptions = { ...style, bold: style.bold || tag === "strong" || tag === "b",
      italics: style.italics || tag === "em" || tag === "i", strike: style.strike || ["del", "s"].includes(tag),
      ...(tag === "code" ? { font: "Consolas", size: 22 } : {}) };
    const children = (await Promise.all(Array.from(node.childNodes).map((child) => inline(child, next)))).flat();
    if (tag === "a") {
      const href = node.getAttribute("href") || "";
      if (/^https?:/i.test(href) || /^mailto:/i.test(href)) return [new d.ExternalHyperlink({ link: href, children })];
    }
    return children;
  };
  const blocks = async (parent: Element, depth = 0): Promise<Array<Paragraph | Table>> => {
    const result: Array<Paragraph | Table> = [];
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent?.trim()) result.push(new d.Paragraph({ children: await inline(node) }));
        continue;
      }
      if (!(node instanceof Element)) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === "nav") { if (settings.toc) result.push(...await blocks(node)); continue; }
      if (tag === "table") {
        const rows: InstanceType<typeof d.TableRow>[] = [];
        for (const row of Array.from(node.querySelectorAll("tr"))) {
          const cells: InstanceType<typeof d.TableCell>[] = [];
          for (const cell of Array.from(row.children)) cells.push(new d.TableCell({ children: [new d.Paragraph({ children: await inline(cell, { bold: cell.tagName === "TH" }) })] }));
          rows.push(new d.TableRow({ children: cells, tableHeader: row.parentElement?.tagName === "THEAD" }));
        }
        if (rows.length) result.push(new d.Table({ rows, width: { size: 100, type: d.WidthType.PERCENTAGE } }));
      } else if (tag === "ul" || tag === "ol") {
        for (const item of Array.from(node.children)) {
          const copy = item.cloneNode(true) as Element;
          copy.querySelectorAll("ul,ol").forEach((nested) => nested.remove());
          result.push(new d.Paragraph({ children: await inline(copy),
            ...(tag === "ul" ? { bullet: { level: Math.min(depth, 8) } } : { numbering: { reference: "markdown-numbering", level: Math.min(depth, 8) } }) }));
          for (const nested of Array.from(item.children).filter((child) => ["UL", "OL"].includes(child.tagName))) {
            const container = document.createElement("div"); container.append(nested.cloneNode(true)); result.push(...await blocks(container, depth + 1));
          }
        }
      } else if (tag === "div" || tag === "section" || tag === "article") result.push(...await blocks(node, depth));
      else if (tag === "hr") result.push(new d.Paragraph({ children: [new d.TextRun("────────────────────────────────")] }));
      else {
        const heading = /^h([1-6])$/.exec(tag);
        result.push(new d.Paragraph({ children: await inline(node),
          ...(heading ? { heading: [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3,
            d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6][Number(heading[1]) - 1] } : {}),
          ...(tag === "blockquote" ? { indent: { left: 360 }, border: { left: { color: "93C5FD", size: 12, style: d.BorderStyle.SINGLE, space: 12 } } } : {}),
          ...(tag === "pre" ? { shading: { fill: "F6F8FA" }, spacing: { before: 120, after: 120 } } : {}),
        }));
      }
    }
    return result;
  };
  const margin = settings.margins === "narrow" ? 680 : settings.margins === "wide" ? 1814 : 1134;
  const doc = new d.Document({ title, numbering: { config: [{ reference: "markdown-numbering", levels: Array.from({ length: 9 }, (_, level) => ({ level, format: d.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: d.AlignmentType.START,
    style: { paragraph: { indent: { left: (level + 1) * 360, hanging: 260 } } } })) }] },
    sections: [{ properties: { page: { size: { width: settings.paper === "A4" ? 11906 : 12240, height: settings.paper === "A4" ? 16838 : 15840,
      orientation: settings.orientation === "landscape" ? d.PageOrientation.LANDSCAPE : d.PageOrientation.PORTRAIT },
      margin: { top: margin, bottom: margin, left: margin, right: margin } } },
    ...(settings.fileHeader ? { headers: { default: new d.Header({ children: [new d.Paragraph(title)] }) } } : {}),
    ...(settings.pageNumbers ? { footers: { default: new d.Footer({ children: [new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.TextRun({ children: [d.PageNumber.CURRENT] })] })] }) } } : {}),
    children: await blocks(root) }],
  });
  return d.Packer.toBlob(doc);
}
