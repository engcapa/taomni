import DOMPurify from "dompurify";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import { effectiveFileType, type FileEntry } from "../../../lib/sftp";

export const TEXT_PREVIEW_LIMIT = 256 * 1024;
export const IMAGE_PREVIEW_LIMIT = 20 * 1024 * 1024;
export const CSV_PREVIEW_ROWS = 100;

export type PreviewKind = "empty" | "multi" | "directory" | "text" | "markdown" | "csv" | "image" | "metadata" | "binary" | "too-large" | "error";

const TEXT_EXTENSIONS = new Set([
  "txt", "log", "md", "markdown", "csv", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc",
  "rs", "toml", "yaml", "yml", "xml", "html", "htm", "css", "scss", "less", "sass", "vue", "svelte",
  "py", "pyi", "go", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "m", "mm",
  "php", "rb", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "ini", "conf", "config", "env",
  "properties", "gradle", "cmake", "make", "gitignore", "gitattributes", "editorconfig", "dockerignore",
]);
const TEXT_NAMES = new Set(["readme", "license", "licence", "copying", "makefile", "dockerfile", "gemfile", "procfile"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);
const IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "image/avif", "image/x-icon", "image/vnd.microsoft.icon",
]);

export function fileExtension(name: string): string {
  const normalized = name.toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot < 0 ? "" : normalized.slice(dot + 1);
}

export function previewKind(entry: FileEntry): PreviewKind {
  if (entry.fileType === "dir") return "directory";
  if (effectiveFileType(entry) !== "file") return "metadata";
  const extension = fileExtension(entry.name);
  if (IMAGE_EXTENSIONS.has(extension)) return entry.size > IMAGE_PREVIEW_LIMIT ? "too-large" : "image";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "csv") return "csv";
  if (TEXT_EXTENSIONS.has(extension) || TEXT_NAMES.has(entry.name.toLowerCase())) return "text";
  return "metadata";
}

/** Parse only the visible CSV prefix, including escaped quotes and embedded newlines. */
export function parseCsvPreview(text: string, maxRows = CSV_PREVIEW_ROWS): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (quoted || !fieldStarted) {
        quoted = !quoted;
      } else {
        field += character;
      }
      fieldStarted = true;
    } else if (!quoted && character === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (!quoted && (character === "\r" || character === "\n")) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      if (rows.length === maxRows) return { rows, truncated: index + 1 < text.length };
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += character;
      fieldStarted = true;
    }
  }
  if ((fieldStarted || field.length > 0 || row.length > 0) && rows.length < maxRows) {
    row.push(field);
    rows.push(row);
  }
  return { rows, truncated: false };
}

/** Reuse the app's Markdown renderer, with an additional offline-only policy. */
export function renderOfflineMarkdown(text: string): string {
  return DOMPurify.sanitize(renderFormatted(text, "md") ?? "", {
    ALLOWED_TAGS: ["a", "abbr", "b", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "kbd", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul"],
    ALLOWED_ATTR: ["title", "colspan", "rowspan"],
    FORBID_ATTR: ["href", "src", "srcset", "style", "ping", "background", "action", "formaction"],
    ALLOW_DATA_ATTR: false,
  }) as string;
}

/** SVG remains an image, never an active document or a network resource loader. */
export function previewImageBlob(bytes: number[], mime: string): Blob {
  const contentType = mime.toLowerCase().split(";")[0].trim();
  if (!IMAGE_MIME_TYPES.has(contentType)) throw new Error("Unsupported image format");
  if (bytes.length > IMAGE_PREVIEW_LIMIT) throw new Error("too_large: image exceeds 20 MB");
  const data = new Uint8Array(bytes);
  if (contentType !== "image/svg+xml") return new Blob([data], { type: contentType });
  const sanitized = DOMPurify.sanitize(new TextDecoder().decode(data), {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["style", "script", "foreignObject", "image", "use", "feImage", "a", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["href", "xlink:href", "style", "src", "srcset"],
    ALLOW_DATA_ATTR: false,
  }) as string;
  const document = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  if (document.documentElement.localName !== "svg") throw new Error("Invalid SVG image");
  for (const element of [document.documentElement, ...document.documentElement.querySelectorAll("*")]) {
    for (const attribute of Array.from(element.attributes)) {
      // Keep local gradient/clip references, but discard every external CSS URL.
      if (/url\s*\(/i.test(attribute.value) && !/^url\(\s*["']?#[\w:.-]+["']?\s*\)$/i.test(attribute.value.trim())) {
        element.removeAttributeNode(attribute);
      }
    }
  }
  return new Blob([new XMLSerializer().serializeToString(document.documentElement)], { type: contentType });
}
