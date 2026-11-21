import type { NotepadPrintDefaults } from "../../../stores/notepadPreferences";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function expandTemplate(tpl: string, docName: string): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);
  return tpl
    .replace(/\{name\}|\$\(FILE_NAME\)/g, docName)
    .replace(/\{date\}|\$\(DATE\)/g, dateStr)
    .replace(/\{time\}|\$\(TIME\)/g, timeStr)
    .replace(/\{page\}|\$\(CURRENT_PAGE\)/g, "1");
}

export function buildPrintableHtml(options: {
  title: string;
  content: string;
  selection?: string;
  settings: NotepadPrintDefaults;
  fontSizePx?: number;
}): string {
  const sourceText =
    options.settings.range === "selection" && options.selection
      ? options.selection
      : options.content;
  const lines = sourceText.split("\n");
  const header = expandTemplate(options.settings.header, options.title);
  const footer = expandTemplate(options.settings.footer, options.title);
  const colorMode = options.settings.colorMode;
  const bg = colorMode === "inv" ? "#111827" : "#ffffff";
  const fg = colorMode === "inv" ? "#f9fafb" : "#111827";
  const fontSize = Math.max(8, Math.min(24, options.fontSizePx ?? 12));

  const bodyLines = lines
    .map((line, i) => {
      const lnHtml = options.settings.lineNumbers
        ? `<span class="ln">${i + 1}</span>`
        : "";
      return `<div class="line">${lnHtml}<span class="txt">${line ? escapeHtml(line) : "&nbsp;"}</span></div>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(options.title)}</title>
<style>
  @page { margin: ${Math.max(5, Math.min(50, options.settings.marginMm))}mm; }
  body { margin: 0; padding: 0; background: ${bg}; color: ${fg}; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: ${fontSize}px; line-height: 1.45; }
  .hdr, .ftr { display: flex; justify-content: space-between; font-size: 11px; opacity: 0.7; border-bottom: 1px solid #d1d5db; padding: 4px 0 6px; margin-bottom: 10px; }
  .ftr { border-bottom: 0; border-top: 1px solid #d1d5db; margin-top: 12px; padding: 6px 0 0; }
  .line { display: flex; white-space: pre-wrap; word-break: break-word; }
  .ln { min-width: 42px; text-align: right; padding-right: 12px; color: #6b7280; user-select: none; }
  .txt { flex: 1; }
</style>
</head>
<body>
  ${header ? `<div class="hdr"><span>${escapeHtml(header)}</span></div>` : ""}
  <main>${bodyLines}</main>
  ${footer ? `<div class="ftr"><span>${escapeHtml(footer)}</span></div>` : ""}
</body>
</html>`;
}

/** Print Notepad document through an isolated hidden iframe (reuses markdownExport pattern). */
export function printNotepadDocument(options: {
  title: string;
  content: string;
  selection?: string;
  settings: NotepadPrintDefaults;
  fontSizePx?: number;
}): void {
  const html = buildPrintableHtml(options);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      setTimeout(() => iframe.remove(), 1000);
    }
  }, 60);
}
