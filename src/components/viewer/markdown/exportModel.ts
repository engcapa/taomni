import { markdownBasename } from "../../../lib/markdownAssets";
import { enhanceMarkdown, markdownFragment } from "./markdownRender";

export type MarkdownExportKind = "html" | "pdf" | "png" | "docx" | "markdown" | "richtext" | "html-source" | "print";
export interface MarkdownExportSettings {
  theme: "light" | "dark";
  paper: "A4" | "Letter";
  orientation: "portrait" | "landscape";
  margins: "normal" | "narrow" | "wide";
  toc: boolean;
  pageNumbers: boolean;
  fileHeader: boolean;
  wrapCode: boolean;
  highlight: boolean;
}
export const DEFAULT_EXPORT_SETTINGS: MarkdownExportSettings = {
  theme: "light", paper: "A4", orientation: "portrait", margins: "normal",
  toc: true, pageNumbers: true, fileHeader: false, wrapCode: true, highlight: true,
};
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function markdownExportCss(settings: MarkdownExportSettings, filename: string): string {
  const dark = settings.theme === "dark";
  const margin = settings.margins === "narrow" ? 12 : settings.margins === "wide" ? 32 : 20;
  const header = filename.replace(/[\n\r]/g, " ").replace(/["\\]/g, "\\$&").replace(/</g, "\\3c ");
  return `:root{color-scheme:${settings.theme}}*{box-sizing:border-box}body{margin:0;background:${dark ? "#191c22" : "#fff"};color:${dark ? "#e5e7eb" : "#1f2937"};font:15px/1.75 system-ui,-apple-system,"Segoe UI",sans-serif}.fv-md-export{max-width:800px;margin:auto;padding:30px 44px}h1{font-size:2em;line-height:1.3;border-bottom:1px solid #cbd5e1;padding-bottom:.25em}h2{font-size:1.5em;margin:1.3em 0 .5em}h3{font-size:1.2em}p{margin:.6em 0}a{color:${dark ? "#93c5fd" : "#2563eb"}}blockquote{border-left:4px solid #93c5fd;margin:.8em 0;padding:.1em 1em;color:${dark ? "#cbd5e1" : "#64748b"};background:${dark ? "#242934" : "#f8fafc"}}pre{border:1px solid ${dark ? "#475569" : "#dbe1e8"};border-radius:8px;padding:12px 14px;background:${dark ? "#242934" : "#f6f8fa"};overflow-wrap:anywhere;white-space:${settings.wrapCode ? "pre-wrap" : "pre"};overflow:auto;font:12.5px/1.6 ui-monospace,monospace}code{font-family:ui-monospace,monospace}p code,li code{font-size:.88em;border:1px solid #cbd5e1;border-radius:4px;padding:1px 5px}table{border-collapse:collapse;width:100%;font-size:14px;margin:.9em 0}th,td{border:1px solid ${dark ? "#475569" : "#cbd5e1"};padding:6px 12px;text-align:left}th{background:${dark ? "#242934" : "#f1f5f9"}}img,svg{max-width:100%;height:auto}img{border-radius:8px}hr{border:0;border-top:2px solid #cbd5e1;margin:1.4em 0}.fv-md-mermaid{text-align:center}.fv-md-task-item{list-style:none;position:relative;padding-left:23px;margin-left:-1.3em}.fv-md-task-state{position:absolute;left:0;top:0;font-family:system-ui,sans-serif;text-decoration:none}.fv-md-task-item.is-checked{text-decoration:line-through;opacity:.8}nav{border-bottom:1px solid #cbd5e1;margin-bottom:24px;padding-bottom:16px}nav a{display:block}h1,h2,h3,h4,h5,h6{break-after:avoid}tr,img,svg{break-inside:avoid}${settings.highlight ? ".tok-keyword{color:#a855f7}.tok-string{color:#16a34a}.tok-comment{color:#64748b}.tok-number{color:#d97706}.tok-variableName,.tok-typeName{color:#2563eb}" : ""}@media print{body{background:${dark ? "#191c22" : "white"};-webkit-print-color-adjust:exact;print-color-adjust:exact}.fv-md-export{max-width:none;padding:0}a{color:inherit;text-decoration:none}pre{overflow:visible}nav a{text-decoration:none}}@page{size:${settings.paper} ${settings.orientation};margin:${margin}mm;${settings.fileHeader ? `@top-center{content:"${header}";font:10px sans-serif}` : ""}${settings.pageNumbers ? '@bottom-center{content:counter(page);font:10px sans-serif}' : ""}}`;
}

export async function prepareMarkdownExport(
  content: string,
  docPath: string,
  settings: MarkdownExportSettings,
): Promise<{ root: HTMLElement; html: string; title: string }> {
  const root = markdownFragment(content);
  root.className = "fv-md-export";
  await enhanceMarkdown(root, { docPath, cancelled: () => false }, true);
  if (!settings.highlight) root.querySelectorAll("pre code span").forEach((span) => span.replaceWith(span.textContent || ""));
  // markdownFragment restores passive task symbols after shared sanitization;
  // exports preserve completion state without introducing active form controls.
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
  headings.forEach((heading, index) => { heading.id = `heading-${index + 1}`; });
  if (settings.toc && headings.length) {
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Table of contents");
    headings.forEach((heading) => {
      const link = document.createElement("a");
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      link.style.paddingLeft = `${(Number(heading.tagName.slice(1)) - 1) * 14}px`;
      nav.append(link);
    });
    root.prepend(nav);
  }
  const title = markdownBasename(docPath);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><title>${escapeHtml(title)}</title><style>${markdownExportCss(settings, title)}</style></head><body>${root.outerHTML}</body></html>`;
  return { root, html, title };
}
