import { NotepadDialog } from "./NotepadDialog";
import { useEffect, useMemo, useState } from "react";
import { ClipboardCopy, FileText, MonitorUp, Search } from "lucide-react";
import type { OpenFileMode } from "../../../lib/openFile";
import { isHandlerAvailable, isOfficeExtension } from "../../../lib/openFile/handlers";
import type { FileHandler } from "../../../lib/openFile/preferences";
import type { HostedDocRef } from "../../../lib/notepad/host/types";
import { useDocumentStore } from "../../../stores/documentStore";
import { useNotepadStore } from "../../../stores/notepadStore";
import { useViewerLabels } from "../../viewer/viewerLabels";

/**
 * Small picker dialogs shared by the Notepad command menu (file -> open with,
 * edit -> paste special / clipboard history / insert custom date, compare
 * targets). Every dialog follows the workbench modal conventions used by the
 * other Notepad dialogs so styling and keyboard handling stay consistent.
 */

export type NotepadPickerDialog =
  | { kind: "openWith"; path: string }
  | { kind: "pasteSpecial" }
  | { kind: "clipboardHistory" }
  | { kind: "insertDate" }
  | { kind: "comparePick"; clipboardText: string; savedContent: string; savedTitle: string }
  | null;

const OPEN_WITH_OPTIONS: Array<{ mode: OpenFileMode; zh: string; en: string; icon: React.ReactNode; disabled?: boolean }> = [
  { mode: "taomni", zh: "Taomni 默认打开", en: "Taomni default", icon: <FileText size={14} /> },
  { mode: "workspace", zh: "Code editor（Code Workspace）", en: "Code editor (Code Workspace)", icon: <MonitorUp size={14} /> },
  { mode: "notepad", zh: "Notepad", en: "Notepad", icon: <FileText size={14} /> },
  { mode: "taoffice", zh: "TaOffice", en: "TaOffice", icon: <FileText size={14} /> },
];

export function PickerDialogs({
  modal,
  onClose,
  onOpenWith,
  onRememberHandler,
  onPaste,
  onInsertText,
  onCompare,
  readClipboard,
}: {
  modal: NotepadPickerDialog;
  onClose: () => void;
  onOpenWith: (mode: OpenFileMode) => void;
  onRememberHandler: (mode: Exclude<OpenFileMode, "source">) => void;
  onPaste: (text: string, kind: "plain" | "html" | "rtf" | "binary") => void;
  onInsertText: (text: string) => void;
  onCompare: (leftTitle: string, leftContent: string) => void;
  readClipboard: () => Promise<string>;
}) {
  const label = useViewerLabels();
  const clipboardHistory = useNotepadStore((state) => state.clipboardHistory);
  const [rememberFor, setRememberFor] = useState<Partial<Record<OpenFileMode, boolean>>>({});

  useEffect(() => {
    setRememberFor({});
  }, [modal]);

  const openWithOptions = modal?.kind === "openWith"
    ? OPEN_WITH_OPTIONS.filter((opt) => opt.mode !== "taoffice" || isOfficeExtension(modal.path))
    : [];

  return (
    <>
      {modal?.kind === "openWith" && (
        <NotepadDialog testId="notepad-open-with-dialog" onClose={onClose} closeId="notepad-open-with-close"
          title={label("打开方式", "Open With")}
          footer={<>
            <button type="button" className="np-btn" onClick={onClose}>{label("关闭", "Close")}</button>
          </>}>
          <p className="np-dialog-hint">{label("选择打开此文件的应用；可勾选“记住”把选择保存为该扩展名的默认打开方式。", "Choose the application for this file. Check Remember to store the choice for this extension.")}</p>
          <div className="np-pick-list">
            {openWithOptions.map((option) => {
              const handlerId = (option.mode === "taomni" ? "taomni" : option.mode) as FileHandler;
              const disabled = option.disabled ?? !isHandlerAvailable(handlerId);
              const remembered = Boolean(rememberFor[option.mode]);
              return (
                <div key={option.mode} className="np-pick-row" data-disabled={disabled || undefined}>
                  <button
                    type="button"
                    className="np-pick-main"
                    data-testid={`notepad-open-with-${option.mode}`}
                    disabled={disabled}
                    onClick={() => {
                      if (remembered) onRememberHandler(option.mode as Exclude<OpenFileMode, "source">);
                      onOpenWith(option.mode);
                    }}
                  >
                    {option.icon}
                    <span>{label(option.zh, option.en)}</span>
                    {option.disabled && <span className="np-chip">{label("开发中", "In development")}</span>}
                  </button>
                  <label className="np-pick-remember">
                    <input
                      type="checkbox"
                      data-testid={`notepad-open-with-remember-${option.mode}`}
                      disabled={disabled}
                      checked={remembered}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setRememberFor((prev) => ({ ...prev, [option.mode]: checked }));
                      }}
                    />
                    {label("记住", "Remember")}
                  </label>
                </div>
              );
            })}
          </div>
        </NotepadDialog>
      )}

      {modal?.kind === "pasteSpecial" && (
        <NotepadDialog testId="notepad-paste-special-dialog" onClose={onClose} closeId="notepad-paste-special-close"
          title={label("特殊粘贴", "Paste Special")}
          footer={<>
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
          </>}>
          <div className="np-pick-list">
            <button type="button" className="np-pick-main" data-testid="notepad-paste-plain" onClick={() => void readClipboard().then((text) => onPaste(text, "plain"))}>
              <ClipboardCopy size={14} />{label("纯文本", "Plain text")}
            </button>
            <button type="button" className="np-pick-main" data-testid="notepad-paste-html" onClick={() => void readClipboard().then((text) => onPaste(text, "html"))}>
              <ClipboardCopy size={14} />{label("HTML 源码", "HTML source")}
            </button>
            <button type="button" className="np-pick-main" data-testid="notepad-paste-rtf" onClick={() => void readClipboard().then((text) => onPaste(text, "rtf"))}>
              <ClipboardCopy size={14} />{label("RTF 源码", "RTF source")}
            </button>
            <button type="button" className="np-pick-main" data-testid="notepad-paste-binary" onClick={() => void readClipboard().then((text) => onPaste(text, "binary"))}>
              <ClipboardCopy size={14} />{label("二进制（保留 NUL）", "Binary (keep NUL)")}
            </button>
          </div>
          <p className="np-dialog-hint">{label("系统剪贴板中的富文本格式由浏览器/宿主提供；不可用时回退为纯文本内容。", "Rich clipboard formats depend on the host; plain text is used when unavailable.")}</p>
        </NotepadDialog>
      )}

      {modal?.kind === "clipboardHistory" && (
        <NotepadDialog testId="notepad-clipboard-history-dialog" onClose={onClose} closeId="notepad-clipboard-history-close"
          title={label("剪贴板历史", "Clipboard History")}
          footer={<>
            <button type="button" className="np-btn" data-testid="notepad-clipboard-history-clear" onClick={() => useNotepadStore.setState({ clipboardHistory: [] })}>{label("清空", "Clear")}</button>
            <button type="button" className="np-btn primary" onClick={onClose}>{label("关闭", "Close")}</button>
          </>}>
          {clipboardHistory.length === 0 ? (
            <p className="np-dialog-hint" data-testid="notepad-clipboard-history-empty">{label("暂无历史条目。", "No history entries yet.")}</p>
          ) : (
            <div className="np-pick-list" data-testid="notepad-clipboard-history-list">
              {clipboardHistory.map((entry, index) => (
                <button
                  key={`${index}-${entry.slice(0, 16)}`}
                  type="button"
                  className="np-pick-main np-pick-pre"
                  data-testid={`notepad-clipboard-history-item-${index}`}
                  title={entry}
                  onClick={() => { onPaste(entry, "plain"); onClose(); }}
                >
                  {entry.length > 160 ? `${entry.slice(0, 160)}…` : entry}
                </button>
              ))}
            </div>
          )}
        </NotepadDialog>
      )}

      {modal?.kind === "insertDate" && <InsertDateDialog onClose={onClose} onInsert={onInsertText} />}

      {modal?.kind === "comparePick" && (
        <NotepadDialog testId="notepad-compare-pick-dialog" onClose={onClose} closeId="notepad-compare-pick-close"
          title={label("选择对比目标", "Choose Compare Target")}
          footer={<>
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
          </>}>
          <div className="np-pick-list">
            <button
              type="button"
              className="np-pick-main"
              data-testid="notepad-compare-pick-saved"
              onClick={() => onCompare(label(`${modal.savedTitle}（磁盘版本）`, `${modal.savedTitle} (saved)`), modal.savedContent)}
            >
              <FileText size={14} />{label("与磁盘版本对比", "Compare with saved version")}
            </button>
            <button
              type="button"
              className="np-pick-main"
              data-testid="notepad-compare-pick-clipboard"
              onClick={() => onCompare(label("剪贴板", "Clipboard"), modal.clipboardText)}
            >
              <ClipboardCopy size={14} />{label("与剪贴板对比", "Compare with clipboard")}
            </button>
            <ComparePickDocuments onPick={(doc, content) => onCompare(doc.title || doc.path || doc.docKey, content)} />
          </div>
        </NotepadDialog>
      )}
    </>
  );
}

const DOCUMENT_TOKEN_RE = /yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g;

export function formatDateWithPattern(date: Date, pattern: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return pattern.replace(DOCUMENT_TOKEN_RE, (token) => {
    switch (token) {
      case "yyyy": return String(date.getFullYear());
      case "yy": return pad(date.getFullYear() % 100);
      case "MM": return pad(date.getMonth() + 1);
      case "M": return String(date.getMonth() + 1);
      case "dd": return pad(date.getDate());
      case "d": return String(date.getDate());
      case "HH": return pad(date.getHours());
      case "H": return String(date.getHours());
      case "mm": return pad(date.getMinutes());
      case "m": return String(date.getMinutes());
      case "ss": return pad(date.getSeconds());
      case "s": return String(date.getSeconds());
      default: return token;
    }
  });
}

function InsertDateDialog({ onClose, onInsert }: { onClose: () => void; onInsert: (text: string) => void }) {
  const label = useViewerLabels();
  const [pattern, setPattern] = useState("yyyy-MM-dd HH:mm:ss");
  const preview = useMemo(() => formatDateWithPattern(new Date(), pattern), [pattern]);
  return (
    <NotepadDialog testId="notepad-insert-date-dialog" onClose={onClose} closeId="notepad-insert-date-close" initialFocus='[data-testid="notepad-insert-date-pattern"]'
      title={label("插入日期时间（自定义）", "Insert Date Time (Custom)")}
      footer={<>
        <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
        <button
          type="button"
          className="np-btn primary"
          data-testid="notepad-insert-date-confirm"
          onClick={() => { onInsert(preview); onClose(); }}
        >
          {label("插入", "Insert")}
        </button>
      </>}>
      <label className="np-field-row">
        <span>{label("格式", "Pattern")}</span>
        <input
          className="np-input"
          data-testid="notepad-insert-date-pattern"
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          placeholder="yyyy-MM-dd HH:mm:ss"
        />
      </label>
      <label className="np-field-row">
        <span>{label("预览", "Preview")}</span>
        <output className="np-input" data-testid="notepad-insert-date-preview">{preview}</output>
      </label>
      <p className="np-dialog-hint">{label("可用字段：yyyy yy MM M dd d HH H mm m ss s", "Tokens: yyyy yy MM M dd d HH H mm m ss s")}</p>
    </NotepadDialog>
  );
}

function ComparePickDocuments({ onPick }: { onPick: (doc: HostedDocRef, content: string) => void }) {
  const [docs, setDocs] = useState<HostedDocRef[]>([]);
  useEffect(() => {
    let active = true;
    // Late import keeps the host adapter out of the dialog module graph.
    void import("../../../lib/notepad/host/viewerTabHost")
      .then(({ viewerTabHost }) => { if (active) setDocs(viewerTabHost.listOpenDocs()); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (docs.length === 0) return null;
  return (
    <>
      {docs.map((doc) => (
        <button
          key={doc.docKey}
          type="button"
          className="np-pick-main"
          data-testid={`notepad-compare-pick-doc-${doc.docKey}`}
          onClick={() => onPick(doc, useDocumentStore.getState().documents[doc.docKey]?.content ?? "")}
        >
          <Search size={14} />
          {doc.title || doc.path || doc.docKey}
        </button>
      ))}
    </>
  );
}
