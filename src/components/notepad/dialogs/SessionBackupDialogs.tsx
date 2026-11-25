import { NotepadDialog } from "./NotepadDialog";
import { useEffect, useState } from "react";
import { ArchiveRestore, Trash2 } from "lucide-react";
import type { NotepadBackupEntry } from "../../../lib/notepad/ipc";
import { listPendingBackups, loadPendingBackupContent } from "../../../lib/notepad/persistence/backupManager";
import { notepadBackupPrune } from "../../../lib/notepad/ipc";
import { useViewerLabels } from "../../viewer/viewerLabels";

export type NotepadSessionModalKind = "sessionSave" | "sessionLoad" | "backups" | null;

export function SessionBackupDialogs({
  kind,
  onClose,
  onSaveSession,
  onLoadSession,
  onRestoreBackup,
}: {
  kind: NotepadSessionModalKind;
  onClose: () => void;
  onSaveSession: (filePath?: string | null) => Promise<string>;
  onLoadSession: (filePath?: string | null) => Promise<void>;
  onRestoreBackup: (entry: NotepadBackupEntry, content: string) => void;
}) {
  const label = useViewerLabels();
  const [sessionPath, setSessionPath] = useState("");
  const [entries, setEntries] = useState<NotepadBackupEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setErr(null);
    setStatus(null);
    if (kind === "backups") {
      void listPendingBackups().then(setEntries).catch((e) => setErr(String(e)));
    }
  }, [kind]);

  if (!kind) return null;

  if (kind === "sessionSave" || kind === "sessionLoad") {
    const isSave = kind === "sessionSave";
    return (
      <NotepadDialog testId={`notepad-${kind}-dialog`} onClose={onClose} initialFocus='[data-testid="notepad-session-path-input"]'
        title={isSave ? label("保存会话文件", "Save Session") : label("加载会话文件", "Load Session")}
        footer={<>
          <button type="button" className="np-btn" onClick={onClose}>{label("关闭", "Close")}</button>
          <button
            type="button"
            className="np-btn primary"
            data-testid="notepad-session-confirm"
            onClick={async () => {
              setErr(null);
              try {
                if (isSave) {
                  const out = await onSaveSession(sessionPath.trim() || null);
                  setStatus(label(`会话已保存：${out}`, `Session saved: ${out}`));
                } else {
                  await onLoadSession(sessionPath.trim() || null);
                  onClose();
                }
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            {isSave ? label("保存会话", "Save Session") : label("加载会话", "Load Session")}
          </button>
        </>}>
        <p className="text-ui-small text-[var(--taomni-text-muted)]">
          {label("留空将使用默认应用数据会话文件。", "Leave blank to use default appData last-session.taomni-session.json.")}
        </p>
        <input
          type="text"
          className="np-input"
          data-testid="notepad-session-path-input"
          placeholder={label("可选绝对路径，如 /tmp/work.taomni-session.json", "Optional absolute path...")}
          value={sessionPath}
          onChange={(e) => setSessionPath(e.target.value)}
        />
        {status && <div className="text-ui-body text-emerald-600">{status}</div>}
        {err && <div className="text-ui-body text-red-500">{err}</div>}
      </NotepadDialog>
    );
  }

  return (
    <NotepadDialog testId="notepad-backups-dialog" onClose={onClose} wide
      title={<span className="inline-flex items-center gap-1.5"><ArchiveRestore size={14} />{label("崩溃恢复与定期备份快照", "Backup & Recovery Snapshots")}</span>}>
      {err && <div className="text-ui-body text-red-500">{err}</div>}
      {entries.length === 0 ? (
        <div className="text-ui-body text-[var(--taomni-text-muted)]">
          {label("没有待恢复的未保存备份快照。", "No pending unsaved backup snapshots.")}
        </div>
      ) : (
        <div className="flex flex-col gap-2 max-h-72 overflow-auto text-ui-body">
          {entries.map((item) => (
            <div key={item.id} className="flex items-center gap-2 border border-[var(--taomni-divider)] rounded p-2">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{item.name}</div>
                <div className="text-ui-small text-[var(--taomni-text-muted)] truncate">
                  {item.path ?? label("未命名文档", "Untitled")} · {item.size} chars
                </div>
              </div>
              <button
                type="button"
                className="np-btn primary"
                data-testid={`notepad-backup-restore-${item.docId}`}
                onClick={async () => {
                  const full = await loadPendingBackupContent(item.id);
                  onRestoreBackup(full.entry, full.content);
                  onClose();
                }}
              >
                {label("恢复", "Restore")}
              </button>
              <button
                type="button"
                className="np-btn"
                onClick={async () => {
                  await notepadBackupPrune(item.docId);
                  setEntries((prev) => prev.filter((e) => e.docId !== item.docId));
                }}
                title={label("丢弃快照", "Discard Snapshot")}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </NotepadDialog>
  );
}
