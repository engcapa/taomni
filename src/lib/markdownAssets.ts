import { safeImageBlob } from "./imageSafety";
import { viewerReadBytes, viewerSavePastedImage } from "./viewer";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function markdownBasename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || "document.md";
}

export function markdownDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(0, normalized.lastIndexOf("/") + 1);
}

export function encodeMarkdownPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").map((part) => encodeURIComponent(part)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

/** Never interpret a remote URL as a local path (or fetch it through WebView proxies). */
export function resolveMarkdownAsset(docPath: string, reference: string): string | null {
  let value: string;
  try { value = decodeURIComponent(reference.trim().replace(/^<|>$/g, "")); }
  catch { throw new Error(`Invalid image path: ${reference}`); }
  if (/^file:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.hostname && url.hostname !== "localhost") throw new Error("Remote file URLs are not supported");
    value = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return null;
  }
  if (value.startsWith("//") || value.startsWith("\\\\")) throw new Error("Network image paths are blocked");
  value = value.replace(/\\/g, "/");
  if (!value || value.startsWith("#")) return null;
  const absolute = value.startsWith("/") || /^[a-z]:\//i.test(value);
  const joined = absolute ? value : markdownDirectory(docPath) + value;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push(part);
    } else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export function imageFileName(template: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const name = template.replace(/\{date\}|\{日期\}/g, day).replace(/\{time\}|\{时间\}/g, time);
  if (!name || /[\\/\x00-\x1f]/.test(name) || name === "." || name === "..") {
    throw new Error("The image filename template must not contain a directory");
  }
  return name.replace(/\.[^.]+$/, "") + ".png";
}

export function markdownImage(alt: string, relativePath: string): string {
  return `![${alt.replace(/[\[\]\\]/g, "\\$&")}](${encodeMarkdownPath(relativePath)})`;
}

export function bytesDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}


export async function readMarkdownImage(docPath: string, reference: string): Promise<string> {
  if (/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[a-z\d+/=\s]+$/i.test(reference)) return reference;
  const path = resolveMarkdownAsset(docPath, reference);
  if (!path) throw new Error(`Remote images are blocked. Save the image locally first: ${reference}`);
  const result = await viewerReadBytes(path, MAX_IMAGE_BYTES);
  const blob = safeImageBlob(result.bytes, result.mime, MAX_IMAGE_BYTES);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return bytesDataUrl(bytes, blob.type);
}

async function asPng(file: Blob): Promise<Uint8Array> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 20 MB limit");
  if (file.type === "image/png") return new Uint8Array(await file.arrayBuffer());
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The pasted image cannot be decoded"));
      image.src = url;
    });
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40_000_000) {
      throw new Error("Image dimensions exceed the safe conversion limit");
    }
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image conversion is unavailable");
    ctx.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("PNG conversion failed")), "image/png",
    ));
    return new Uint8Array(await png.arrayBuffer());
  } finally { URL.revokeObjectURL(url); }
}

export async function saveMarkdownImage(
  docPath: string,
  file: Blob,
  preferences: { markdownImageDir: string; markdownImageTemplate: string },
): Promise<{ path: string; relativePath: string; markdown: string }> {
  if (!docPath || !markdownDirectory(docPath)) throw new Error("Save the document to a folder before inserting images");
  const bytes = await asPng(file);
  const result = await viewerSavePastedImage({
    docPath,
    dir: preferences.markdownImageDir,
    fileName: imageFileName(preferences.markdownImageTemplate),
    bytes: Array.from(bytes),
  });
  // The native API returns a percent-encoded URL (not a filesystem string).
  // Decode exactly once before the shared path encoder; this preserves literal
  // '%' and filenames containing the characters '%20' without double encoding.
  return { ...result, markdown: markdownImage("image", decodeURIComponent(result.relativePath)) };
}
