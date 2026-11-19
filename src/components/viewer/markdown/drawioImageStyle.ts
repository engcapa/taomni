import { sanitizeImageSvg } from "../../../lib/imageSafety";
import { getLocale } from "../../../lib/i18n";

const embeddedImage = /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml)(?:;charset=utf-8)?(;base64)?,([\s\S]+)$/i;
const missingImage = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24"><rect x="1" y="1" width="30" height="22" rx="2" fill="#f1f5f9" stroke="#64748b" stroke-dasharray="3 2"/><path d="M5 18l6-6 4 3 5-7 7 10" fill="none" stroke="#64748b"/></svg>',
);

function offlineImage(value: string): string | undefined {
  if (/^(?:javascript:|vbscript:|data:(?!image\/))/i.test(value)) {
    throw new Error("draw.io contains an unsafe image reference");
  }
  const match = embeddedImage.exec(value);
  if (!match) return undefined;
  const mime = match[1].toLowerCase().replace(/^jpg$/, "jpeg");
  const encoded = match[3];
  try {
    if (mime === "svg+xml") {
      const source = !match[2] && encoded.startsWith("%")
        ? decodeURIComponent(encoded)
        : new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
      return "data:image/svg+xml," + encodeURIComponent(sanitizeImageSvg(source));
    }
    const base64 = encoded.replace(/\s/g, "");
    if (/^[a-z\d+/]+={0,2}$/i.test(base64) && base64.length % 4 !== 1) {
      // draw.io restores the base64 parameter after parsing semicolon-separated styles.
      return `data:image/${mime},${base64}`;
    }
  } catch {
    // Preserve the cell and original source when an embedded image is damaged.
  }
  return undefined;
}

export function sanitizeDrawioStyle(style: string, rich: boolean): { style: string; missingImages: number } {
  let missingImages = 0;
  const parts = style.split(/;(?!base64,|charset=utf-8(?:;base64)?,)/i).filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    if (key === "fontSource") return "";
    if (key === "image") {
      const image = offlineImage(entry.slice(separator + 1).trim());
      if (!image) missingImages++;
      return `image=${image ?? missingImage}`;
    }
    if (/javascript:|https?:|file:|url\(|expression\(|<|>/i.test(entry)) throw new Error("draw.io contains an unsafe style");
    // The bundled viewer registers this shape, but its frame stencil is an
    // external asset. Use a basic shape in the offline rendering copy.
    if (entry === "shape=mxgraph.kubernetes.icon") return "shape=hexagon";
    return !rich && key === "html" ? "html=0" : entry;
  });
  return { style: (style.startsWith(";") ? ";" : "") + parts.join(";"), missingImages };
}

export function drawioMissingImagesMessage(count: number): string {
  if (getLocale() === "zh-CN") return `${count} 张图片无法离线显示，原始引用已保留。`;
  return count === 1 ? "1 image unavailable offline. Original reference preserved."
    : `${count} images unavailable offline. Original references preserved.`;
}
