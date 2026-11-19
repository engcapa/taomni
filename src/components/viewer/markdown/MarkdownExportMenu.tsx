import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useElementResizeFrame } from "../../../hooks/useElementResizeFrame";
import { ThemedSelect } from "../../ThemedSelect";
import { ChevronDown, Copy, Download, FileCode2, FileImage, FileText, FolderDown, Printer, X } from "lucide-react";
import { useViewerLabels } from "../viewerLabels";
import type { ViewerDocument } from "../../../lib/viewer";
import { markdownBasename } from "../../../lib/markdownAssets";
import { MarkdownExportResultActions, exportWorkspaceId } from "./MarkdownExportResultActions";
import { exportMarkdown } from "./markdownExport";
import { DEFAULT_EXPORT_SETTINGS, type MarkdownExportKind, type MarkdownExportSettings } from "./exportModel";
import type { MarkdownDocumentOwner } from "./markdownOwner";
import { DrawioExportSettings } from "./DrawioExportSettings";

export function MarkdownExportMenu({ document: current, onError, printRequest = 0, onExport }: { document: ViewerDocument; onError: (message: string) => void; printRequest?: number; onExport?: MarkdownDocumentOwner["onExport"] }) {
  const label = useViewerLabels();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<MarkdownExportKind | null>(null);
  const [settings, setSettings] = useState(DEFAULT_EXPORT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [savedFile, setSavedFile] = useState<string | null>(null);
  const [savedWorkspace, setSavedWorkspace] = useState<string>();
  const identity = useRef(current.key);
  identity.current = current.key;
  useEffect(() => { setNotice(""); setSaved(null); setSavedFile(null); setBusy(false); }, [current.key]);
  const [exportState, setExportState] = useState("idle");
  useEffect(() => { if (printRequest) { setOpen(false); setDialog("print"); } }, [printRequest]);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const trigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", escape);
    menu.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  const update = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect(), popup = menu.current?.getBoundingClientRect();
    if (!anchor || !popup) return;
    const below = anchor.bottom + 6;
    const left = Math.max(8, Math.min(anchor.right - popup.width, window.innerWidth - popup.width - 8));
    const top = Math.max(8, below + popup.height <= window.innerHeight - 8 ? below : anchor.top - popup.height - 6);
    setPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
  }, []);
  const schedule = useElementResizeFrame(menu, update);
  useLayoutEffect(() => {
    if (!open) return;
    update();
    window.addEventListener("scroll", schedule, true);
    return () => window.removeEventListener("scroll", schedule, true);
  }, [open, update, schedule]);
  const run = async (kind: MarkdownExportKind) => {
    if (busy) return;
    const documentKey = current.key;
    const workspaceId = exportWorkspaceId();
    setOpen(false); setDialog(null); setBusy(true); setSaved(null); setExportState("busy");
    setNotice(label("正在导出…", "Exporting…"));
    try {
      const result = await (onExport ? onExport(kind, current.content, settings) : exportMarkdown(kind, current.content, current.path, settings));
      if (!alive.current || identity.current !== documentKey) return;
      setExportState(result.status);
      if (result.status === "saved") { setSaved(result.path || null); setSavedFile(result.openPath ?? result.path ?? null); setSavedWorkspace(workspaceId); setNotice(label("导出完成", "Export completed")); }
      else if (result.status === "copied") setNotice(label("已复制到剪贴板", "Copied to clipboard"));
      else if (result.status === "opened") setNotice(label("已在系统浏览器打开", "Opened in system browser"));
      else if (result.status === "print-opened") setNotice(label("已请求系统打印，请在系统窗口中完成打印。", "System printing requested. Complete printing in the system dialog."));
      else setNotice(label("已取消导出", "Export cancelled"));
      if (result.drawio) {
        const { pages, nativeDiagrams, fallbackDiagrams } = result.drawio;
        setNotice(label(`draw.io：${pages} 个 Sheet，${nativeDiagrams} 个可编辑图表，${fallbackDiagrams} 个 SVG 回退`, `draw.io: ${pages} sheets, ${nativeDiagrams} editable diagrams, ${fallbackDiagrams} SVG fallbacks`));
      }
    } catch (error) {
      if (!alive.current || identity.current !== documentKey) return;
      setExportState("failed");
      setNotice(label("导出失败，源文件未更改", "Export failed; source file unchanged"));
      onError(error instanceof Error ? error.message : String(error));
    } finally { if (alive.current && identity.current === documentKey) { setBusy(false); trigger.current?.focus(); } }
  };
  const entries: Array<[MarkdownExportKind, string, string, typeof Download]> = [
    ["html", "HTML（自包含，内嵌图片）", "HTML (self-contained, embedded images)", FileCode2],
    ["pdf", "PDF", "PDF", FileText], ["png", "PNG 长图", "PNG long image", FileImage],
    ["docx", "Word（.docx）", "Word (.docx)", FileText],
    ["drawio", "draw.io（全文档 / 全部图片）", "draw.io (document / all images)", FileImage],
    ["markdown", "Markdown + 图片文件夹", "Markdown + image folder", FolderDown],
    ["richtext", "复制为富文本（粘贴到邮件/文档）", "Copy rich text (paste into mail/docs)", Copy],
    ["html-source", "复制为 HTML 源码", "Copy HTML source", Copy], ["print", "打印…", "Print…", Printer],
  ];
  return <>
    <div className="fv-md-export-control" ref={root}>
      <button ref={trigger} className="fv-button primary" data-testid="markdown-export" disabled={busy || current.loading} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Download />{label("导出", "Export")}<ChevronDown /></button>
      {open && createPortal(<div className="fv" style={{ display: "contents" }}><div ref={menu} className="fv-menu fv-md-export-menu" style={{ position: "fixed", ...position }} role="menu" data-testid="markdown-export-menu" onKeyDown={(event) => {
        if (event.key === "Tab") { setOpen(false); trigger.current?.focus(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") || []);
        const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
        <div className="fv-md-menu-title">{label("导出为", "Export as")}</div>
        {entries.map(([kind, zh, en, Icon]) => <button key={kind} role="menuitem" className={kind === "richtext" ? "fv-md-menu-divider" : ""} data-testid={`markdown-export-${kind}`} onClick={() => {
          setOpen(false);
          if (kind === "pdf" || kind === "print" || kind === "docx" || kind === "drawio") setDialog(kind);
          else void run(kind);
        }}><Icon /><span>{label(zh, en)}</span>{kind === "pdf" && <small>{label("页面设置", "Page setup")}</small>}{kind === "print" && <small>{/Mac/i.test(navigator.platform) ? "⌘P" : "Ctrl+P"}</small>}</button>)}
      </div></div>, window.document.body)}
    </div>
    {notice && <div className="fv-md-export-notice" role="status" data-testid="markdown-export-status" data-export-state={exportState} data-export-path={saved || undefined}><span>{notice}</span>{saved && savedFile && <MarkdownExportResultActions path={saved} filePath={savedFile} workspaceId={savedWorkspace} onError={onError} />}<button className="fv-icon-button" aria-label={label("关闭提示", "Dismiss")} onClick={() => setNotice("")}><X /></button></div>}
    {dialog && createPortal(<div className="fv" style={{ display: "contents" }}>{dialog === "drawio" ? <DrawioExportSettings settings={settings} onChange={setSettings} onCancel={() => { setDialog(null); trigger.current?.focus(); }} onConfirm={(kind) => void run(kind)} /> : <ExportSettings kind={dialog} filename={markdownBasename(current.path)} settings={settings} onChange={setSettings} onCancel={() => { setDialog(null); trigger.current?.focus(); }} onConfirm={() => void run(dialog)} />}</div>, window.document.body)}
  </>;
}

function ExportSettings({ kind, filename, settings, onChange, onCancel, onConfirm }: {
  kind: MarkdownExportKind; filename: string; settings: MarkdownExportSettings;
  onChange: (value: MarkdownExportSettings) => void; onCancel: () => void; onConfirm: () => void;
}) {
  const label = useViewerLabels();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>("[role=combobox]")?.focus(); }, []);
  const patch = (value: Partial<MarkdownExportSettings>) => onChange({ ...settings, ...value });
  const check = (field: "toc" | "pageNumbers" | "fileHeader" | "wrapCode" | "highlight", zh: string, en: string) => <label className="fv-md-setting-check"><input type="checkbox" data-testid={`markdown-export-${field}`} checked={settings[field]} onChange={(event) => patch({ [field]: event.target.checked })} />{label(zh, en)}</label>;
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
      <div className="fv-md-field"><span>{label("主题", "Theme")}</span>
        <ThemedSelect label={label("主题", "Theme")} value={settings.theme} onChange={(theme) => patch({ theme })} options={[
          { value: "light", label: label("浅色（打印友好）", "Light (print-friendly)") }, { value: "dark", label: label("深色", "Dark") },
        ]} />
      </div>
      <div className="fv-md-field"><span>{label("页面", "Page")}</span>
        <ThemedSelect label={label("纸张", "Paper")} value={settings.paper} onChange={(paper) => patch({ paper })} options={[
          { value: "A4", label: "A4" }, { value: "Letter", label: "Letter" },
        ]} />
        <ThemedSelect label={label("方向", "Orientation")} value={settings.orientation} onChange={(orientation) => patch({ orientation })} options={[
          { value: "portrait", label: label("纵向", "Portrait") }, { value: "landscape", label: label("横向", "Landscape") },
        ]} />
        <ThemedSelect label={label("页边距", "Margins")} value={settings.margins} onChange={(margins) => patch({ margins })} options={[
          { value: "normal", label: label("页边距 常规", "Margins: normal") }, { value: "narrow", label: label("窄", "Narrow") }, { value: "wide", label: label("宽", "Wide") },
        ]} />
      </div>
      <div className="fv-md-field"><span>{label("包含", "Include")}</span>{check("toc", "目录", "Contents")}{check("pageNumbers", "页码", "Page numbers")}{check("fileHeader", "页眉文件名", "Filename header")}</div>
      <div className="fv-md-field"><span>{label("代码块", "Code blocks")}</span>{check("wrapCode", "保持换行", "Wrap lines")}{check("highlight", "语法高亮", "Syntax highlighting")}</div>
      <p className="fv-md-export-hint">{kind === "print" ? label("打印使用系统打印窗口。", "Printing uses the system print dialog.") : label("图片以内嵌方式导出；本地相对路径图片已解析。PDF 直接保存为文件，无需打印机。", "Images are embedded; local relative images are resolved. PDF saves directly to a file without a printer.")}</p>
    </div>
    <footer><button className="fv-button outline" onClick={onCancel}>{label("取消", "Cancel")}</button><button className="fv-button primary" data-testid="markdown-export-confirm" onClick={onConfirm}>{label("导出…", "Export…")}</button></footer>
  </div></div>;
}
