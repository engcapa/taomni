import DOMPurify from "dompurify";

const IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml",
  "image/avif", "image/x-icon", "image/vnd.microsoft.icon",
]);

/** One offline, image-only policy for Explorer and the full viewer. Callers own their size limit. */
export function safeImageBlob(bytes: readonly number[] | Uint8Array, mime: string, maxBytes: number): Blob {
  const contentType = mime.toLowerCase().split(";")[0].trim();
  if (!IMAGE_MIME_TYPES.has(contentType)) throw new Error("Unsupported image format");
  if (bytes.length > maxBytes) throw new Error(`too_large: image exceeds ${maxBytes / 1024 / 1024} MiB`);
  const data = new Uint8Array(bytes);
  if (contentType !== "image/svg+xml") return new Blob([data], { type: contentType });
  const source = new TextDecoder().decode(data);
  const original = new DOMParser().parseFromString(source, "image/svg+xml");
  if (original.querySelector("parsererror") || original.documentElement.localName !== "svg") {
    throw new Error("Invalid SVG image");
  }
  const sanitized = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["style", "script", "foreignObject", "image", "use", "feImage", "a", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["href", "xlink:href", "style", "src", "srcset", "xml:base"],
    ALLOW_DATA_ATTR: false,
  });
  const document = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg") throw new Error("Invalid SVG image");
  for (const element of [document.documentElement, ...document.documentElement.querySelectorAll("*")]) {
    for (const attribute of Array.from(element.attributes)) {
      // Keep local gradient/clip references, never external CSS resource loads.
      if (/url\s*\(/i.test(attribute.value) && !/^url\(\s*["']?#[\w:.-]+["']?\s*\)$/i.test(attribute.value.trim())) {
        element.removeAttributeNode(attribute);
      }
    }
  }
  return new Blob([new XMLSerializer().serializeToString(document.documentElement)], { type: contentType });
}
