import { markdownBasename } from "../../../lib/markdownAssets";
import { writeText, writeMultiFormat } from "../../../lib/clipboard";
import { getAppPlatform, isTauriRuntime } from "../../../lib/runtime";
import { notifyClipboardWritten } from "../../../lib/clipboardOwnership";
import { exportMarkdownFolder, saveExportBlob } from "./exportFiles";
import { markdownExportCss, prepareMarkdownExport, type MarkdownExportKind, type MarkdownExportSettings } from "./exportModel";

export interface MarkdownExportResult { path?: string; status: "saved" | "copied" | "print-opened" | "cancelled" }

async function exportPng(root: HTMLElement, settings: MarkdownExportSettings, title: string): Promise<Blob> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;width:800px;pointer-events:none;z-index:-1";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = markdownExportCss(settings, title);
  const wrapper = document.createElement("div");
  wrapper.style.background = settings.theme === "dark" ? "#191c22" : "#ffffff";
  wrapper.style.color = settings.theme === "dark" ? "#e5e7eb" : "#1f2937";
  wrapper.style.font = "15px/1.75 system-ui,sans-serif";
  wrapper.append(root);
  shadow.append(style, wrapper);
  document.body.append(host);
  try {
    await Promise.all(Array.from(root.querySelectorAll("img")).map((image) => image.decode()));
    await document.fonts?.ready;
    const width = 800, height = Math.ceil(wrapper.getBoundingClientRect().height);
    if (!height || height > 32700 || width * height > 40_000_000) throw new Error("Document is too long for a safe PNG export; use HTML or PDF instead");
    const { toBlob } = await import("html-to-image");
    const blob = await toBlob(wrapper, { width, height, pixelRatio: 1, skipFonts: true, backgroundColor: settings.theme === "dark" ? "#191c22" : "#ffffff" });
    if (!blob || !blob.size) throw new Error("PNG export did not produce an image");
    return blob;
  } finally { host.remove(); }
}

export async function printMarkdownHtml(html: string): Promise<void> {
  const frame = document.createElement("iframe");
  frame.title = "Markdown print";
  frame.style.cssText = "position:fixed;left:-100000px;top:0;width:800px;height:600px;border:0";
  document.body.append(frame);
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => { if (cleanupTimer) clearTimeout(cleanupTimer); frame.remove(); };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Print document loading timed out")), 15000);
      frame.onload = () => { clearTimeout(timer); resolve(); };
      frame.onerror = () => { clearTimeout(timer); reject(new Error("Print document could not be loaded")); };
      frame.srcdoc = html;
    });
    const target = frame.contentWindow;
    if (!target || typeof target.print !== "function") throw new Error("System printing is unavailable in this WebView");
    await Promise.all(Array.from(frame.contentDocument?.images || []).map((image) => image.decode()));
    await frame.contentDocument?.fonts.ready;
    target.addEventListener("afterprint", cleanup, { once: true });
    // Some WebViews never emit afterprint. Keep the document available while
    // the native dialog owns it and eventually release it without claiming PDF
    // bytes were saved (the system dialog controls that).
    cleanupTimer = setTimeout(cleanup, 5 * 60 * 1000);
    target.focus(); target.print();
  } catch (error) { cleanup(); throw error; }
}

export async function exportMarkdown(
  kind: MarkdownExportKind,
  content: string,
  docPath: string,
  settings: MarkdownExportSettings,
): Promise<MarkdownExportResult> {
  if (kind === "markdown") {
    const path = await exportMarkdownFolder(content, docPath);
    return path ? { status: "saved", path } : { status: "cancelled" };
  }
  const prepared = await prepareMarkdownExport(content, docPath, settings);
  const stem = markdownBasename(docPath).replace(/\.(md|markdown)$/i, "");
  if (kind === "print" || kind === "pdf") {
    await printMarkdownHtml(prepared.html);
    return { status: "print-opened" };
  }
  if (kind === "html-source") {
    await writeText(prepared.html);
    return { status: "copied" };
  }
  if (kind === "richtext") {
    if (isTauriRuntime() && getAppPlatform() === "macos") {
      // The shared macOS path guarantees native multi-format or rejects. Other
      // platforms' helper may silently fall back to text, which is not a
      // successful rich-text export, so require both actual MIME types there.
      await writeMultiFormat({ text: prepared.root.textContent || "", html: prepared.html });
      return { status: "copied" };
    }
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Rich-text clipboard is unavailable in this WebView");
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([prepared.html], { type: "text/html" }),
      "text/plain": new Blob([prepared.root.textContent || ""], { type: "text/plain" }),
    })]);
    notifyClipboardWritten();
    return { status: "copied" };
  }
  let blob: Blob;
  if (kind === "png") blob = await exportPng(prepared.root, settings, prepared.title);
  else if (kind === "docx") blob = await (await import("./exportDocx")).markdownDocx(prepared.root, prepared.title, settings);
  else blob = new Blob([prepared.html], { type: "text/html;charset=utf-8" });
  const path = await saveExportBlob(`${stem}.${kind}`, blob, docPath);
  return path ? { status: "saved", path } : { status: "cancelled" };
}
