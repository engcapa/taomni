import { useMemo, useState } from "react";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { NOTEPAD_COMMAND_CATALOG } from "../../../lib/notepad/commands/catalog";
import {
  formatShortcutDisplay,
  keyboardEventToShortcut,
  useNotepadKeymap,
} from "../../../lib/notepad/commands/keymap";
import { useViewerLabels } from "../../viewer/viewerLabels";

export function ShortcutMapperDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const label = useViewerLabels();
  const [filter, setFilter] = useState("");
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const { setBinding, clearBinding, resetBinding, resetAll, resolveShortcut, getConflicts } =
    useNotepadKeymap();

  const conflicts = getConflicts();
  const conflictCommandSet = useMemo(() => {
    const s = new Set<string>();
    for (const c of conflicts) {
      for (const id of c.commandIds) s.add(id);
    }
    return s;
  }, [conflicts]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return NOTEPAD_COMMAND_CATALOG.filter(
      (cmd) => !q || cmd.defaultLabel.toLowerCase().includes(q) || cmd.id.toLowerCase().includes(q),
    );
  }, [filter]);

  if (!open) return null;

  return (
    <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-shortcut-mapper-dialog">
      <div className="np-modal wide">
        <div className="np-modal-header">
          <span>{label("快捷键映射器", "Shortcut Mapper")}</span>
          <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="flex gap-2 items-center">
          <input
            type="text"
            className="np-input flex-1"
            data-testid="notepad-keymap-filter"
            placeholder={label("筛选命令...", "Filter commands...")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className="np-btn inline-flex items-center gap-1"
            data-testid="notepad-keymap-reset-all"
            onClick={() => resetAll()}
          >
            <RotateCcw size={12} />
            {label("全部重置", "Reset All")}
          </button>
        </div>

        {conflicts.length > 0 && (
          <div
            className="flex items-center gap-2 text-[12px] p-2 rounded border border-amber-500/60 bg-amber-500/10"
            data-testid="notepad-keymap-conflict-banner"
          >
            <AlertTriangle size={14} className="text-amber-500 shrink-0" />
            <span>
              {label(
                `检测到 ${conflicts.length} 组快捷键冲突`,
                `${conflicts.length} shortcut conflict(s) detected`,
              )}
            </span>
          </div>
        )}

        <div className="max-h-80 overflow-auto border border-[var(--taomni-divider)] rounded text-[12px]">
          {rows.map((cmd) => {
            const current = resolveShortcut(cmd.id);
            const isCapturing = capturingId === cmd.id;
            const hasConflict = conflictCommandSet.has(cmd.id);
            return (
              <div
                key={cmd.id}
                className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--taomni-divider)]/50"
              >
                <span className="text-[10px] uppercase w-16 text-[var(--taomni-text-muted)]">{cmd.category}</span>
                <span className="flex-1 truncate">{cmd.defaultLabel}</span>
                <button
                  type="button"
                  data-testid={`notepad-keymap-bind-${cmd.id}`}
                  className={`np-btn font-mono min-w-28 ${isCapturing ? "primary" : ""} ${hasConflict ? "border-amber-500 text-amber-500" : ""}`}
                  onClick={() => setCapturingId(cmd.id)}
                  onKeyDown={(e) => {
                    if (!isCapturing) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "Escape") {
                      setCapturingId(null);
                      return;
                    }
                    const chord = keyboardEventToShortcut(e.nativeEvent);
                    if (chord) {
                      setBinding(cmd.id, chord);
                      setCapturingId(null);
                    }
                  }}
                >
                  {isCapturing ? label("请按键...", "Press keys...") : formatShortcutDisplay(current) || label("未绑定", "(none)")}
                </button>
                <button type="button" className="np-btn" onClick={() => clearBinding(cmd.id)}>×</button>
                <button type="button" className="np-btn" onClick={() => resetBinding(cmd.id)} title="Reset">↺</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
