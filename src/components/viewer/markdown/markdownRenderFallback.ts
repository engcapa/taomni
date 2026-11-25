import { bytesDataUrl } from "../../../lib/markdownAssets";

export type MarkdownRenderFallbackKind = "image" | "mermaid" | "drawio";

export interface MarkdownRenderWarning {
  /** Stable across Live, Split, and export remounts for the same source element. */
  id: string;
  kind: MarkdownRenderFallbackKind;
  label: string;
  reference: string;
  message: string;
}

export type MarkdownWarningHandler = (warning: MarkdownRenderWarning) => void;
export type MarkdownRenderLabel = (zh: string, en: string) => string;

export function markdownRenderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMarkdownRenderWarning(
  kind: MarkdownRenderFallbackKind,
  reference: string,
  label: string,
  error: unknown,
): MarkdownRenderWarning {
  return { id: `${kind}:${reference}`, kind, label, reference, message: markdownRenderError(error) };
}

/** The same semantic fallback is used by Live, Split, and every rendered export. */
export function createMarkdownRenderPlaceholder(
  warning: MarkdownRenderWarning,
  translate: MarkdownRenderLabel = (_zh, en) => en,
): HTMLElement {
  const subject = warning.kind === "image"
    ? translate("图片无法显示", "Image unavailable")
    : warning.kind === "mermaid"
      ? translate("Mermaid 图表无法渲染", "Mermaid diagram unavailable")
      : translate("draw.io 图表无法渲染", "draw.io diagram unavailable");
  const root = document.createElement(warning.kind === "image" ? "span" : "div");
  root.className = `fv-md-render-placeholder fv-md-render-placeholder-${warning.kind}${warning.kind === "image" ? " fv-md-image-error" : " fv-md-render-error"}`;
  root.dataset.testid = "markdown-render-placeholder";
  root.dataset.kind = warning.kind;
  if (warning.kind === "image") root.dataset.reference = warning.reference;
  root.setAttribute("role", "note");
  root.setAttribute("aria-label", `${subject}: ${warning.label}. ${warning.message}`);
  root.title = warning.message;

  const marker = document.createElement("span");
  marker.className = "fv-md-render-placeholder-marker";
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = "⚠";
  const body = document.createElement("span");
  body.className = "fv-md-render-placeholder-body";
  const title = document.createElement("strong");
  title.textContent = subject;
  const detail = document.createElement("span");
  detail.className = "fv-md-render-placeholder-detail";
  detail.textContent = warning.kind === "image" && warning.label !== warning.reference
    ? `${warning.label} · ${warning.reference}`
    : warning.label;
  body.append(title, detail);
  root.append(marker, body);
  return root;
}

function xmlText(value: string, limit: number): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").slice(0, limit)
    .replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

/** Markdown folder exports need a real portable asset rather than app-only HTML. */
export function markdownImagePlaceholderDataUrl(warning: MarkdownRenderWarning): string {
  const title = xmlText(`Image unavailable: ${warning.label}`, 100);
  const reference = xmlText(warning.reference, 140);
  const message = xmlText(warning.message, 140);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120" viewBox="0 0 640 120" role="img" aria-label="${title}"><rect x="1" y="1" width="638" height="118" rx="8" fill="#fff7ed" stroke="#d97706" stroke-width="2" stroke-dasharray="6 4"/><text x="20" y="34" fill="#92400e" font-family="system-ui,sans-serif" font-size="16" font-weight="600">⚠ ${title}</text><text x="20" y="65" fill="#78350f" font-family="ui-monospace,monospace" font-size="12">${reference}</text><text x="20" y="91" fill="#92400e" font-family="system-ui,sans-serif" font-size="12">${message}</text></svg>`;
  return bytesDataUrl(new TextEncoder().encode(svg), "image/svg+xml");
}
