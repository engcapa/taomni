import type * as HtmlToImage from "html-to-image";

/** Inline computed styles can dominate a long document's SVG (and its parse on
 * every page). Share identical frozen HTML declarations in a scoped sheet.
 * Keep SVG rules/IDs, pseudo-element rules and mutable page owners intact. */
export function compactPdfStyles(document: Document, mutable: Element[]): void {
  const scope = `pdf-style-${crypto.randomUUID()}`;
  document.documentElement.setAttribute("id", scope);
  const declarations = new Map<string, string>(), rules: string[] = [];
  for (const node of document.querySelectorAll<HTMLElement>("[style]")) {
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || mutable.includes(node)) continue;
    const text = node.style.cssText;
    if (!text) continue;
    let name = declarations.get(text);
    if (!name) {
      name = `${scope}-${declarations.size}`; declarations.set(text, name);
      // The computed declarations replace inline styles. Scope specificity
      // keeps original author rules from overriding these frozen values.
      rules.push(`#${scope}#${scope}#${scope} .${name}{${text}}`);
    }
    node.classList.add(name); node.removeAttribute("style");
  }
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = rules.join("\n"); document.documentElement.prepend(style);
}

/** Clone/style/embed the full document once. Each page then changes only its
 * clipping viewport, content translation and page-number label. */
export async function createPdfCapture(
  capture: typeof HtmlToImage,
  page: HTMLElement,
  root: HTMLElement,
  viewport: HTMLElement,
  footer: HTMLElement,
  layout: { pixelWidth: number; pixelHeight: number },
  background: string,
): Promise<(slice: { top: number; bottom: number }, pageLabel: string) => Promise<HTMLCanvasElement>> {
  const nonce = crypto.randomUUID();
  root.setAttribute("data-pdf-capture", `${nonce}-root`); viewport.setAttribute("data-pdf-capture", `${nonce}-viewport`); footer.setAttribute("data-pdf-capture", `${nonce}-footer`);
  const fontEmbedCSS = await capture.getFontEmbedCSS(page);
  const svg = await capture.toSvg(page, { fontEmbedCSS, width: layout.pixelWidth, height: layout.pixelHeight, backgroundColor: background });
  const template = new DOMParser().parseFromString(decodeURIComponent(svg.slice(svg.indexOf(",") + 1)), "image/svg+xml");
  const copiedRoot = template.querySelector<HTMLElement>(`[data-pdf-capture="${nonce}-root"]`);
  const copiedViewport = template.querySelector<HTMLElement>(`[data-pdf-capture="${nonce}-viewport"]`);
  const copiedFooter = template.querySelector<HTMLElement>(`[data-pdf-capture="${nonce}-footer"]`);
  if (template.querySelector("parsererror") || !copiedRoot || !copiedViewport) throw new Error("Cannot prepare PDF page rendering");
  compactPdfStyles(template, [copiedRoot, copiedViewport]);
  const serializer = new XMLSerializer();
  return async (slice, pageLabel) => {
    copiedViewport.style.height = `${slice.bottom - slice.top}px`;
    copiedRoot.style.transform = `translateY(-${slice.top}px)`;
    if (copiedFooter) copiedFooter.textContent = pageLabel;
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error("Cannot render the PDF page"));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serializer.serializeToString(template))}`;
    });
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = layout.pixelWidth * 300 / 96; canvas.height = layout.pixelHeight * 300 / 96;
    const context = canvas.getContext("2d");
    if (!context) { canvas.width = canvas.height = 0; throw new Error("PDF image rendering is unavailable"); }
    context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  };
}
