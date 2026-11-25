import { useEffect, useState } from "react";
import { Play, ShieldAlert, Trash2, X } from "lucide-react";
import type { SavedMacroEntry } from "../../../lib/notepad/macro/macroManager";
import { useViewerLabels } from "../../viewer/viewerLabels";

export type NotepadMacroModalKind = "save" | "runMulti" | "manage" | "tamper" | null;

export function MacroDialogs({
  kind,
  macros,
  tamperInfo,
  onClose,
  onSaveNamed,
  onRunMulti,
  onDeleteMacro,
  onRenameMacro,
  onRunSavedMacro,
  onAcceptTampered,
  onResetMacros,
}: {
  kind: NotepadMacroModalKind;
  macros: SavedMacroEntry[];
  tamperInfo: { expectedHash: string; actualHash: string } | null;
  onClose: () => void;
  onSaveNamed: (name: string, shortcut?: string) => Promise<void>;
  onRunMulti: (mode: "times" | "eof", count: number) => Promise<void>;
  onDeleteMacro: (name: string) => Promise<void>;
  onRenameMacro: (oldName: string, newName: string) => Promise<void>;
  onRunSavedMacro: (macro: SavedMacroEntry) => Promise<void>;
  onAcceptTampered: () => Promise<void>;
  onResetMacros: () => Promise<void>;
}) {
  const label = useViewerLabels();
  const [macroName, setMacroName] = useState("");
  const [macroKey, setMacroKey] = useState("");
  const [runMode, setRunMode] = useState<"times" | "eof">("times");
  const [runCount, setRunCount] = useState(5);
  const [renaming, setRenaming] = useState<{ old: string; next: string } | null>(null);

  useEffect(() => {
    setMacroName("");
    setMacroKey("");
    setRenaming(null);
  }, [kind]);

  if (!kind) return null;

  if (kind === "save") {
    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-macro-save-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span>{label("保存已录制的宏", "Save Recorded Macro")}</span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <input
            type="text"
            className="np-input"
            data-testid="notepad-macro-name-input"
            placeholder={label("输入宏名称...", "Macro name...")}
            value={macroName}
            onChange={(e) => setMacroName(e.target.value)}
          />
          <input
            type="text"
            className="np-input"
            placeholder={label("可选快捷键，如 Alt+Shift+1", "Optional shortcut e.g. Alt+Shift+1")}
            value={macroKey}
            onChange={(e) => setMacroKey(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
            <button
              type="button"
              className="np-btn primary"
              data-testid="notepad-macro-save-confirm"
              disabled={!macroName.trim()}
              onClick={async () => {
                await onSaveNamed(macroName.trim(), macroKey.trim() || undefined);
                onClose();
              }}
            >
              {label("保存", "Save")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (kind === "runMulti") {
    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-macro-multi-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span>{label("多次运行宏", "Run Macro Multiple Times")}</span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <div className="flex flex-col gap-2 text-[12px]">
            <label className="inline-flex items-center gap-2">
              <input type="radio" checked={runMode === "times"} onChange={() => setRunMode("times")} />
              <span>{label("运行指定次数：", "Run N times:")}</span>
              <input
                type="number"
                min={1}
                max={10000}
                className="np-input w-24"
                data-testid="notepad-macro-count-input"
                value={runCount}
                onChange={(e) => setRunCount(Math.max(1, Number(e.target.value)))}
              />
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" checked={runMode === "eof"} onChange={() => setRunMode("eof")} />
              <span>{label("一直运行直到文件结尾", "Run until the end of file")}</span>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
            <button
              type="button"
              className="np-btn primary"
              data-testid="notepad-macro-multi-run"
              onClick={async () => {
                await onRunMulti(runMode, runCount);
                onClose();
              }}
            >
              {label("运行", "Run")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (kind === "tamper") {
    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-macro-tamper-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span className="inline-flex items-center gap-1.5 text-amber-500">
              <ShieldAlert size={15} />
              {label("宏配置文件完整性校验失败", "Macro Integrity Check Failed")}
            </span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <p className="text-[12px]">
            {label(
              "macros.json 的 SHA-256 与记录的 macros.sha256 不匹配，可能被外部修改。",
              "macros.json SHA-256 does not match macros.sha256 and may have been modified externally.",
            )}
          </p>
          {tamperInfo && (
            <div className="text-[11px] font-mono bg-[var(--taomni-bg)] p-2 rounded border border-[var(--taomni-divider)] break-all">
              <div>Expected: {tamperInfo.expectedHash || "(missing)"}</div>
              <div>Actual: {tamperInfo.actualHash}</div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="np-btn"
              data-testid="notepad-macro-tamper-reset"
              onClick={async () => {
                await onResetMacros();
                onClose();
              }}
            >
              {label("清空并重置", "Reset Empty")}
            </button>
            <button
              type="button"
              className="np-btn primary"
              data-testid="notepad-macro-tamper-accept"
              onClick={async () => {
                await onAcceptTampered();
                onClose();
              }}
            >
              {label("信任并更新签名", "Accept & Update Hash")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-macro-manage-dialog">
      <div className="np-modal">
        <div className="np-modal-header">
          <span>{label("管理已保存的宏", "Manage Saved Macros")}</span>
          <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
        </div>
        {macros.length === 0 ? (
          <div className="text-[12px] text-[var(--taomni-text-muted)]">{label("暂无已保存的宏。", "No saved macros yet.")}</div>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-72 overflow-auto">
            {macros.map((m) => (
              <div key={m.name} className="flex items-center gap-2 border border-[var(--taomni-divider)] rounded px-2 py-1 text-[12px]">
                {renaming?.old === m.name ? (
                  <>
                    <input
                      type="text"
                      className="np-input flex-1"
                      value={renaming.next}
                      onChange={(e) => setRenaming({ old: m.name, next: e.target.value })}
                    />
                    <button
                      type="button"
                      className="np-btn primary"
                      onClick={async () => {
                        if (renaming.next.trim()) await onRenameMacro(m.name, renaming.next.trim());
                        setRenaming(null);
                      }}
                    >
                      {label("保存", "Save")}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 font-medium">{m.name}</span>
                    <span className="text-[11px] text-[var(--taomni-text-muted)]">{m.steps.length} steps</span>
                    <button type="button" className="np-btn" onClick={() => void onRunSavedMacro(m)} title={label("运行", "Run")}><Play size={12} /></button>
                    <button type="button" className="np-btn" onClick={() => setRenaming({ old: m.name, next: m.name })}>{label("重命名", "Rename")}</button>
                    <button type="button" className="np-btn" data-testid={`notepad-macro-del-${m.name}`} onClick={() => void onDeleteMacro(m.name)}><Trash2 size={12} /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
