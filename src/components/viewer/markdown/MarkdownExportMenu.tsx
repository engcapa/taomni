import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, Download, FileCode2, FileImage, FileText, FolderDown, Printer, X } from "lucide-react";
import { useViewerLabels } from "../viewerLabels";
import type { ViewerDocument } from "../../../lib/viewer";
import { markdownBasename, markdownDirectory } from "../../../lib/markdownAssets";
import { sftpOpenPath } from "../../../lib/sftp";
import { exportMarkdown } from "./markdownExport";
import { DEFAULT_EXPORT_SETTINGS, type MarkdownExportKind, type MarkdownExportSettings } from "./exportModel";

export function MarkdownExportMenu({ document: current, onError, printRequest = 0 }: { document: ViewerDocument; onError: (message: string) => void; printRequest?: number }) {
  const label = useViewerLabels();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<MarkdownExportKind | null>(null);
  const [settings, setSettings] = useState(DEFAULT_EXPORT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [exportState, setExportState] = useState("idle");
  useEffect(() => { if (printRequest) { setOpen(false); setDialog("print"); } }, [printRequest]);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", escape);
    root.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  const run = async (kind: MarkdownExportKind) => {
    if (busy) return;
    setOpen(false); setDialog(null); setBusy(true); setSaved(null); setExportState("busy");
    setNotice(label("正在导出…", "Exporting…"));
    try {
      const result = await exportMarkdown(kind, current.content, current.path, settings);
      if (!alive.current) return;
      setExportState(result.status);
      if (result.status === "saved") { setSaved(result.path || null); setNotice(label("导出完成", "Export completed")); }
      else if (result.status === "copied") setNotice(label("已复制到剪贴板", "Copied to clipboard"));
      else if (result.status === "print-opened") setNotice(label("已请求系统打印。在打印窗口选择“保存为 PDF”；纸张、页边距、页眉页脚与页码以系统预览为准。", "System printing requested. Choose Save as PDF in the print dialog; verify paper, margins, headers/footers and page numbers in its preview."));
      else setNotice(label("已取消导出", "Export cancelled"));
    } catch (error) {
      if (!alive.current) return;
      setExportState("failed");
      setNotice(label("导出失败，源文件未更改", "Export failed; source file unchanged"));
      onError(error instanceof Error ? error.message : String(error));
    } finally { if (alive.current) { setBusy(false); trigger.current?.focus(); } }
  };
  const entries: Array<[MarkdownExportKind, string, string, typeof Download]> = [
    ["html", "HTML（自包含，内嵌图片）", "HTML (self-contained, embedded images)", FileCode2],
    ["pdf", "PDF", "PDF", Printer], ["png", "PNG 长图", "PNG long image", FileImage],
    ["docx", "Word（.docx）", "Word (.docx)", FileText],
    ["markdown", "Markdown + 图片文件夹", "Markdown + image folder", FolderDown],
    ["richtext", "复制为富文本（粘贴到邮件/文档）", "Copy rich text (paste into mail/docs)", Copy],
    ["html-source", "复制为 HTML 源码", "Copy HTML source", Copy], ["print", "打印…", "Print…", Printer],
  ];
  return <>
    <div className="fv-md-export-control" ref={root}>
      <button ref={trigger} className="fv-button primary" data-testid="markdown-export" disabled={busy || current.loading} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Download />{label("导出", "Export")}<ChevronDown /></button>
      {open && <div className="fv-menu fv-md-export-menu" role="menu" data-testid="markdown-export-menu" onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") || []);
        const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
        <div className="fv-md-menu-title">{label("导出为", "Export as")}</div>
        {entries.map(([kind, zh, en, Icon], index) => <button key={kind} role="menuitem" className={index === 5 ? "fv-md-menu-divider" : ""} data-testid={`markdown-export-${kind}`} onClick={() => {
          setOpen(false);
          if (kind === "pdf" || kind === "print" || kind === "docx") setDialog(kind);
          else void run(kind);
        }}><Icon /><span>{label(zh, en)}</span>{kind === "pdf" && <small>{label("页面设置", "Page setup")}</small>}{kind === "print" && <small>{/Mac/i.test(navigator.platform) ? "⌘P" : "Ctrl+P"}</small>}</button>)}
      </div>}
    </div>
    {notice && <div className="fv-md-export-notice" role="status" data-testid="markdown-export-status" data-export-state={exportState} data-export-path={saved || undefined}><span>{notice}</span>{saved && <button className="fv-button" onClick={() => void sftpOpenPath(saved.endsWith(".html") || saved.endsWith(".docx") || saved.endsWith(".png") ? markdownDirectory(saved) : saved).catch((error: unknown) => onError(String(error)))}>{label("在文件管理器中显示", "Show in file manager")}</button>}<button className="fv-icon-button" aria-label={label("关闭提示", "Dismiss")} onClick={() => setNotice("")}><X /></button></div>}
    {dialog && <ExportSettings kind={dialog} filename={markdownBasename(current.path)} settings={settings} onChange={setSettings} onCancel={() => { setDialog(null); trigger.current?.focus(); }} onConfirm={() => void run(dialog)} />}
  </>;
}

function ExportSettings({ kind, filename, settings, onChange, onCancel, onConfirm }: {
  kind: MarkdownExportKind; filename: string; settings: MarkdownExportSettings;
  onChange: (value: MarkdownExportSettings) => void; onCancel: () => void; onConfirm: () => void;
}) {
  const label = useViewerLabels();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.querySelector<HTMLSelectElement>("select")?.focus(); }, []);
  const patch = (value: Partial<MarkdownExportSettings>) => onChange({ ...settings, ...value });
  const check = (field: "toc" | "pageNumbers" | "fileHeader" | "wrapCode" | "highlight", zh: string, en: string) => <label className="fv-md-setting-check"><input type="checkbox" checked={settings[field]} onChange={(event) => patch({ [field]: event.target.checked })} />{label(zh, en)}</label>;
  return <div className="fv-modal-bg" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><div ref={root} className="fv-modal fv-md-export-settings" role="dialog" aria-modal="true" aria-labelledby="fv-md-export-title" data-testid="markdown-export-settings" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    if (event.key === "Tab") {
      const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>("button,input,select") || []);
      if (event.shiftKey && window.document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && window.document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    }
  }}>
    <h3 id="fv-md-export-title">{label("导出", "Export")} {kind === "print" ? label("打印", "Print") : kind.toUpperCase()} — {filename}</h3>
    <div className="fv-md-export-fields">
      <div className="fv-md-field"><span>{label("主题", "Theme")}</span><select className="fv-select" aria-label={label("主题", "Theme")} value={settings.theme} onChange={(event) => patch({ theme: event.target.value as "light" | "dark" })}><option value="light">{label("浅色（打印友好）", "Light (print-friendly)")}</option><option value="dark">{label("深色", "Dark")}</option></select></div>
      <div className="fv-md-field"><span>{label("页面", "Page")}</span><select className="fv-select" aria-label={label("纸张", "Paper")} value={settings.paper} onChange={(event) => patch({ paper: event.target.value as "A4" | "Letter" })}><option>A4</option><option>Letter</option></select><select className="fv-select" aria-label={label("方向", "Orientation")} value={settings.orientation} onChange={(event) => patch({ orientation: event.target.value as "portrait" | "landscape" })}><option value="portrait">{label("纵向", "Portrait")}</option><option value="landscape">{label("横向", "Landscape")}</option></select><select className="fv-select" aria-label={label("页边距", "Margins")} value={settings.margins} onChange={(event) => patch({ margins: event.target.value as MarkdownExportSettings["margins"] })}><option value="normal">{label("页边距 常规", "Margins: normal")}</option><option value="narrow">{label("窄", "Narrow")}</option><option value="wide">{label("宽", "Wide")}</option></select></div>
      <div className="fv-md-field"><span>{label("包含", "Include")}</span>{check("toc", "目录", "Contents")}{check("pageNumbers", "页码", "Page numbers")}{check("fileHeader", "页眉文件名", "Filename header")}</div>
      <div className="fv-md-field"><span>{label("代码块", "Code blocks")}</span>{check("wrapCode", "保持换行", "Wrap lines")}{check("highlight", "语法高亮", "Syntax highlighting")}</div>
      <p className="fv-md-export-hint">{label("图片以内嵌方式导出；本地相对路径图片已解析。PDF/打印由系统打印窗口完成，打印支持因平台而异，请核对页面预览与页眉页脚。", "Images are embedded; local relative images are resolved. PDF/printing uses the system print dialog. Platform print support varies; verify page preview and headers/footers.")}</p>
    </div>
    <footer><button className="fv-button outline" onClick={onCancel}>{label("取消", "Cancel")}</button><button className="fv-button primary" data-testid="markdown-export-confirm" onClick={onConfirm}>{label("导出…", "Export…")}</button></footer>
  </div></div>;
}
