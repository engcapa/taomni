import { useEffect, useRef, useState } from "react";
import { FolderOpen, ShieldAlert, Trash2, X } from "lucide-react";
import { useViewerLabels } from "../../viewer/viewerLabels";
import { selectSaveFilePath } from "../../../lib/ipc/files";
import { notepadDialogDirectory } from "../../../lib/notepad/persistence/savePath";

export type NotepadLifecycleModal =
  | { kind: "saveAs"; defaultPath: string; initialPath: string; defaultDir: string; copy?: boolean }
  | { kind: "rename"; currentName: string }
  | { kind: "trash"; path: string; name: string }
  | { kind: "elevated"; path: string; error: string }
  | { kind: "folderDrop"; folder: string; totalCandidates: number; skippedBinary: number; files: string[] }
  | { kind: "wholeDocConfirm"; actionLabel: string; onConfirm: () => Promise<void> | void }
  | {
      kind: "summary";
      name: string;
      path: string | null;
      encoding: string;
      eol: string;
      content: string;
      bytes: number;
    };

export type NotepadSaveAsModal = Extract<NotepadLifecycleModal, { kind: "saveAs" }>;

/**
 * Save As is its own component so its editable path state is initialized by the
 * mount that first shows the dialog. The host `FileLifecycleDialogs` stays
 * mounted with `modal = null` between opens; keeping Save As state there left a
 * first-render window where the input was still empty before a passive effect
 * copied `initialPath` in (observed on macOS browser QA as a transient empty
 * controlled value). Mounting on open removes that race and re-initializes
 * cleanly for every open.
 */
function NotepadSaveAsDialog({
  modal,
  onClose,
  onSaveAs,
}: {
  modal: NotepadSaveAsModal;
  onClose: () => void;
  onSaveAs: (path: string, overwrite: boolean, copy?: boolean) => Promise<void>;
}) {
  const label = useViewerLabels();
  const [pathInput, setPathInput] = useState(modal.initialPath || modal.defaultPath);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submitSaveAs = async (forceOverwrite: boolean) => {
    setErr(null);
    setBusy(true);
    try {
      await onSaveAs(pathInput.trim(), forceOverwrite, modal.copy);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("exists:")) {
        setOverwrite(true);
        setErr(label("目标文件已存在，请确认是否覆盖。", "Target file already exists. Confirm overwrite to replace it."));
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-save-as-dialog">
      <div className="np-modal">
        <div className="np-modal-header">
          <span>{modal.copy ? label("保存副本", "Save a Copy") : label("另存为", "Save As")}</span>
          <button type="button" className="np-btn" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            className="np-input flex-1"
            data-testid="notepad-save-as-input"
            placeholder="/path/to/file.txt"
            value={pathInput}
            onChange={(e) => { setPathInput(e.target.value); setOverwrite(false); }}
          />
          <button
            type="button"
            className="np-btn"
            data-testid="notepad-save-as-browse"
            title={modal.defaultDir}
            onClick={async () => {
              // U2: the native picker opens in the resolved default directory.
              const picked = await selectSaveFilePath(
                modal.defaultPath.split(/[\\/]/).pop(),
                notepadDialogDirectory(modal.defaultDir),
              );
              if (picked) setPathInput(picked);
            }}
          >
            <FolderOpen size={13} />
          </button>
        </div>
        {err && <div className="text-[12px] text-red-500" data-testid="notepad-dialog-error">{err}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
          <button
            type="button"
            className="np-btn primary"
            data-testid="notepad-save-as-confirm"
            disabled={busy || !pathInput.trim()}
            onClick={() => void submitSaveAs(overwrite)}
          >
            {overwrite ? label("覆盖保存", "Overwrite") : label("保存", "Save")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FileLifecycleDialogs({
  modal,
  onClose,
  onSaveAs,
  onRename,
  onTrash,
  onElevatedSave,
  onOpenFolderFiles,
  onDisableWholeDocPrompt,
}: {
  modal: NotepadLifecycleModal | null;
  onClose: () => void;
  onSaveAs: (path: string, overwrite: boolean, copy?: boolean) => Promise<void>;
  onRename: (newName: string) => Promise<void>;
  onTrash: () => Promise<void>;
  onElevatedSave: () => Promise<void>;
  onOpenFolderFiles: (files: string[]) => Promise<void>;
  onDisableWholeDocPrompt?: () => void;
}) {
  const label = useViewerLabels();
  const [nameInput, setNameInput] = useState(modal?.kind === "rename" ? modal.currentName : "");
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lastModalRef = useRef<NotepadLifecycleModal | null>(null);
  // Re-initialize the editable fields whenever a new modal opens so a stale
  // value from the previous open cannot leak into the next Rename.
  useEffect(() => {
    if (modal === lastModalRef.current) return;
    lastModalRef.current = modal;
    setErr(null);
    setDontAskAgain(false);
    if (modal?.kind === "rename") setNameInput(modal.currentName);
  }, [modal]);

  if (!modal) return null;

  if (modal.kind === "saveAs") {
    return (
      <NotepadSaveAsDialog
        key={`${modal.copy ? "copy" : "save"}:${modal.initialPath || modal.defaultPath}`}
        modal={modal}
        onClose={onClose}
        onSaveAs={onSaveAs}
      />
    );
  }

  if (modal.kind === "rename") {
    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-rename-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span>{label("重命名文件", "Rename File")}</span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <input
            type="text"
            className="np-input"
            data-testid="notepad-rename-input"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
          />
          {err && <div className="text-[12px] text-red-500">{err}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
            <button
              type="button"
              className="np-btn primary"
              data-testid="notepad-rename-confirm"
              disabled={busy || !nameInput.trim()}
              onClick={async () => {
                setErr(null);
                setBusy(true);
                try {
                  await onRename(nameInput.trim());
                  onClose();
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {label("重命名", "Rename")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (modal.kind === "trash") {
    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-trash-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span className="inline-flex items-center gap-1.5"><Trash2 size={14} />{label("移到回收站", "Move to Trash")}</span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <p className="text-[12px]">
            {label(`确定要将 “${modal.name}” 移到系统回收站并关闭标签页吗？`, `Move "${modal.name}" to the system Trash and close its tab?`)}
          </p>
          <p className="text-[11px] font-mono text-[var(--taomni-text-muted)] break-all">{modal.path}</p>
          {err && <div className="text-[12px] text-red-500">{err}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
            <button
              type="button"
              className="np-btn primary"
              data-testid="notepad-trash-confirm"
              disabled={busy}
              onClick={async () => {
                setErr(null);
                setBusy(true);
                try {
                  await onTrash();
                  onClose();
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {label("移到回收站", "Move to Trash")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (modal.kind === "elevated") {
    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-elevated-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span className="inline-flex items-center gap-1.5"><ShieldAlert size={14} />{label("需要管理员权限保存", "Administrator Permission Required")}</span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <p className="text-[12px]">{modal.error}</p>
          <p className="text-[11px] font-mono text-[var(--taomni-text-muted)] break-all">{modal.path}</p>
          {err && <div className="text-[12px] text-red-500">{err}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
            <button
              type="button"
              className="np-btn primary"
              data-testid="notepad-elevated-retry"
              disabled={busy}
              onClick={async () => {
                setErr(null);
                setBusy(true);
                try {
                  await onElevatedSave();
                  onClose();
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {label("提权重试保存", "Retry Elevated Save")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (modal.kind === "folderDrop") {
    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-folder-drop-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span>{label("批量打开文件夹文本文件", "Open Text Files from Folder")}</span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <p className="text-[12px]">
            {label(
              `目录 ${modal.folder} 共发现 ${modal.totalCandidates} 个文件（已跳过 ${modal.skippedBinary} 个二进制文件）。最多一次打开 ${modal.files.length} 个文件，是否继续？`,
              `Found ${modal.totalCandidates} files in ${modal.folder} (skipped ${modal.skippedBinary} binary). Open up to ${modal.files.length} text files?`,
            )}
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
            <button
              type="button"
              className="np-btn primary"
              data-testid="notepad-folder-drop-confirm"
              onClick={async () => {
                await onOpenFolderFiles(modal.files);
                onClose();
              }}
            >
              {label(`打开 ${modal.files.length} 个文件`, `Open ${modal.files.length} Files`)}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (modal.kind === "wholeDocConfirm") {
    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-whole-doc-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span>{label("确认对全文执行行操作", "Confirm Whole-Document Operation")}</span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <p className="text-[12px]">
            {label(
              `当前没有选中文本，将对整个文档执行「${modal.actionLabel}」。是否继续？`,
              `No selection is active. Apply "${modal.actionLabel}" to the entire document?`,
            )}
          </p>
          <label className="inline-flex items-center gap-2 text-[12px] cursor-pointer">
            <input
              type="checkbox"
              data-testid="notepad-whole-doc-dont-ask"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
            />
            {label("不再提示（可在首选项中恢复）", "Don't ask again (can re-enable in Preferences)")}
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
            <button
              type="button"
              className="np-btn primary"
              data-testid="notepad-whole-doc-confirm"
              onClick={() => {
                if (dontAskAgain) onDisableWholeDocPrompt?.();
                const action = modal.onConfirm;
                onClose();
                void action();
              }}
            >
              {label("继续执行", "Apply")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Summary dialog
  const lines = modal.content.split("\n").length;
  const words = (modal.content.trim() ? modal.content.trim().split(/\s+/).length : 0);
  const charsNoWs = modal.content.replace(/\s/g, "").length;
  return (
    <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-summary-dialog">
      <div className="np-modal">
        <div className="np-modal-header">
          <span>{label("文档摘要", "Document Summary")}</span>
          <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <span className="text-[var(--taomni-text-muted)]">{label("名称", "Name")}</span><span>{modal.name}</span>
          <span className="text-[var(--taomni-text-muted)]">{label("路径", "Path")}</span><span className="break-all font-mono text-[11px]">{modal.path ?? label("未保存草稿", "Untitled")}</span>
          <span className="text-[var(--taomni-text-muted)]">{label("编码 / 换行", "Encoding / EOL")}</span><span>{modal.encoding} · {modal.eol}</span>
          <span className="text-[var(--taomni-text-muted)]">{label("字符数（含空白 / 不含空白）", "Characters (all / non-ws)")}</span><span>{modal.content.length} / {charsNoWs}</span>
          <span className="text-[var(--taomni-text-muted)]">{label("词数 / 行数", "Words / Lines")}</span><span>{words} / {lines}</span>
          <span className="text-[var(--taomni-text-muted)]">{label("字节大小", "Byte Length")}</span><span>{modal.bytes.toLocaleString()} bytes</span>
        </div>
        <div className="flex justify-end">
          <button type="button" className="np-btn primary" onClick={onClose}>{label("关闭", "Close")}</button>
        </div>
      </div>
    </div>
  );
}
