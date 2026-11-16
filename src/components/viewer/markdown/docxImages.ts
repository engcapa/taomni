import type { MarkdownExportSettings } from "./exportModel";
import { embeddedSvg, portableWordSvg } from "./wordSvg";

export const WORD_IMAGE_DPI = 600;
const MAX_PIXELS = 40_000_000;
export function wordPageLayout(settings: MarkdownExportSettings) {
  const margin = settings.margins === "narrow" ? 680 : settings.margins === "wide" ? 1814 : 1134;
  const portrait = settings.paper === "A4" ? [11906, 16838] : [12240, 15840];
  const [pageWidth, pageHeight] = settings.orientation === "landscape" ? [portrait[1], portrait[0]] : portrait;
  return { margin, pageWidth, pageHeight, width: (pageWidth - 2 * margin) / 15, height: (pageHeight - 2 * margin - 720) / 15 };
}

/** Geometry, physical layout (96 CSS pixels/inch) and media samples are distinct. */
export function wordImageLayout(width: number, height: number, settings: MarkdownExportSettings, vector: boolean) {
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error("Invalid image geometry for Word export");
  const page = wordPageLayout(settings);
  const scale = Math.min(vector ? Infinity : 1, page.width / width, page.height / height);
  const displayWidth = Math.max(1, Math.round(width * scale));
  const displayHeight = Math.max(1, Math.round(height * scale));
  const pixelWidth = vector ? Math.ceil(displayWidth * WORD_IMAGE_DPI / 96) : Math.ceil(width);
  const pixelHeight = vector ? Math.ceil(displayHeight * WORD_IMAGE_DPI / 96) : Math.ceil(height);
  if (pixelWidth * pixelHeight > MAX_PIXELS || pixelWidth > 32700 || pixelHeight > 32700) {
    throw new Error("The image exceeds the safe Word conversion limit; export as SVG/HTML or PDF instead");
  }
  return { width: displayWidth, height: displayHeight, pixelWidth, pixelHeight };
}

export function svgGeometry(svg: Element): { width: number; height: number } {
  const box = svg.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
  const absolute = (name: string) => {
    const value = svg.getAttribute(name)?.trim() || "";
    return /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number.parseFloat(value) : 0;
  };
  const width = absolute("width"), height = absolute("height");
  if (!width || !height) throw new Error("SVG export requires a valid viewBox or absolute width and height");
  return { width, height };
}

export async function wordImageData(node: Element, settings: MarkdownExportSettings): Promise<{
  bytes: Uint8Array; svg?: Uint8Array; type?: "png" | "jpg"; width: number; height: number;
}> {
  const svg = embeddedSvg(node);
  const vector = Boolean(svg);
  let geometry: { width: number; height: number } | undefined;
  let svgText: string | undefined;
  if (svg) {
    geometry = svgGeometry(svg);
    svgText = await portableWordSvg(svg, geometry.width, geometry.height, settings.theme === "dark");
  }
  const source = svgText ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}` : node.getAttribute("src") || "";
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve(); image.onerror = () => reject(new Error("Cannot decode an exported image")); image.src = source;
  });
  geometry ??= { width: image.naturalWidth, height: image.naturalHeight };
  const layout = wordImageLayout(geometry.width, geometry.height, settings, vector);
  const original = !vector && /^data:image\/(png|jpe?g);base64,([\s\S]+)$/i.exec(source);
  if (original) return { bytes: Uint8Array.from(atob(original[2]), (char) => char.charCodeAt(0)),
    type: original[1].toLowerCase() === "png" ? "png" : "jpg", width: layout.width, height: layout.height };
  const canvas = document.createElement("canvas");
  canvas.width = layout.pixelWidth; canvas.height = layout.pixelHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image conversion is unavailable");
  if (vector) {
    context.fillStyle = settings.theme === "dark" ? "#191c22" : "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const binary = atob(canvas.toDataURL("image/png").split(",")[1]);
  return { bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)), svg: svgText ? new TextEncoder().encode(svgText) : undefined,
    width: layout.width, height: layout.height };
}
