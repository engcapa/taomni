import { useViewerLabels } from "../viewer/viewerLabels";
import "./notepad-toolbar-statusbar.css";

function formatBackupClock(value: number | string): string {
  if (typeof value === "string") return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function NotepadStatusBar({
  length,
  lines,
  cursorLine,
  cursorColumn,
  selChars,
  selLines,
  eol,
  encoding,
  bom,
  insertMode,
  readOnly,
  zoomPct,
  backupState,
  onCycleEol,
  onOpenEncoding,
  onToggleInsertMode,
  onResetZoom,
  remote = false,
  recording = false,
  backupIntervalSec = 30,
  lastBackupAt,
}: {
  length: number;
  lines: number;
  cursorLine: number;
  cursorColumn: number;
  selChars: number;
  selLines: number;
  eol: "LF" | "CRLF" | "CR";
  encoding: string;
  bom: boolean;
  insertMode: boolean;
  readOnly: boolean;
  zoomPct: number;
  backupState: "idle" | "saving" | "saved" | "error";
  onCycleEol: () => void;
  onOpenEncoding: () => void;
  onToggleInsertMode: () => void;
  onToggleReadonly: () => void;
  onResetZoom: () => void;
  remote?: boolean;
  recording?: boolean;
  backupIntervalSec?: number;
  lastBackupAt?: number | string;
}) {
  const label = useViewerLabels();
  const encodingLabel = encoding === "UTF-8" && bom ? "UTF-8 BOM" : encoding;
  const backupLabel =
    lastBackupAt === undefined
      ? label(`自动备份 ${backupIntervalSec}s`, `Auto backup ${backupIntervalSec}s`)
      : label(
          `备份 ${backupIntervalSec}s · ${formatBackupClock(lastBackupAt)}`,
          `Backup ${backupIntervalSec}s · ${formatBackupClock(lastBackupAt)}`,
        );

  return (
    <footer className="np-statusbar" data-testid="notepad-status-bar">
      <span className="np-status-item" data-testid="viewer-cursor">
        {label(`行 ${cursorLine}，列 ${cursorColumn}`, `Ln ${cursorLine}, Col ${cursorColumn}`)}
        {selChars > 0 && (
          <span data-testid="notepad-status-sel">
            {label(
              ` · 选 ${selChars}${selLines > 1 ? `（${selLines} 行）` : ""}`,
              ` · Sel ${selChars}${selLines > 1 ? ` (${selLines} lines)` : ""}`,
            )}
          </span>
        )}
      </span>

      <span className="np-status-sep" />

      <span className="np-status-item" data-testid="notepad-status-stats">
        {label(`${lines} 行 · ${length} 字符`, `${lines} lines · ${length} chars`)}
      </span>

      <span className="np-status-spacer" />

      {remote && (
        <span className="np-status-chip" data-testid="notepad-status-remote">
          {label("远程只读副本", "Remote read-only copy")}
        </span>
      )}
      {readOnly && !remote && (
        <span className="np-status-chip warn" data-testid="notepad-status-readonly">
          {label("只读", "Read-only")}
        </span>
      )}
      {recording && (
        <span className="np-status-chip rec" data-testid="notepad-status-rec">
          ● REC
        </span>
      )}
      <span
        className="np-status-item np-status-backup"
        data-testid="notepad-status-backup"
        data-state={backupState}
        title={lastBackupAt === undefined ? undefined : label("自动备份", "Auto backup")}
      >
        {backupLabel}
      </span>

      <span className="np-status-sep" />

      <button type="button" className="np-status-item" data-testid="notepad-status-eol" onClick={onCycleEol}>
        {eol}
      </button>
      <button type="button" className="np-status-item" data-testid="notepad-status-encoding" onClick={onOpenEncoding}>
        {encodingLabel}
      </button>
      <button type="button" className="np-status-item" data-testid="notepad-status-ovr" onClick={onToggleInsertMode}>
        {insertMode ? "INS" : "OVR"}
      </button>
      <button type="button" className="np-status-item" data-testid="notepad-status-zoom" onClick={onResetZoom}>
        {zoomPct}%
      </button>
    </footer>
  );
}
