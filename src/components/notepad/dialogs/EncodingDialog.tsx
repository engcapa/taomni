import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import {
  notepadCheckEncodingLoss,
  notepadListEncodings,
  type NotepadEncodingGroup,
  type NotepadEncodingLossReport,
} from "../../../lib/notepad/ipc";
import { useViewerLabels } from "../../viewer/viewerLabels";

const FALLBACK_GROUPS: NotepadEncodingGroup[] = [
  { group: "Unicode", encodings: ["UTF-8", "UTF-8 BOM", "UTF-16LE", "UTF-16BE"] },
  { group: "East Asian ANSI", encodings: ["GBK", "GB18030", "Big5", "Shift_JIS", "EUC-JP", "EUC-KR"] },
  { group: "Western / Latin", encodings: ["windows-1252", "ISO-8859-1", "ISO-8859-15", "windows-1250"] },
  { group: "Cyrillic / Greek", encodings: ["windows-1251", "KOI8-R", "ISO-8859-5", "windows-1253"] },
];

export function EncodingDialog({
  open,
  currentEncoding,
  canReopenFromDisk,
  content,
  onClose,
  onReopenAs,
  onConvertTo,
}: {
  open: boolean;
  currentEncoding: string;
  canReopenFromDisk: boolean;
  content: string;
  onClose: () => void;
  onReopenAs: (encoding: string) => Promise<void>;
  onConvertTo: (encoding: string) => void;
}) {
  const label = useViewerLabels();
  const [groups, setGroups] = useState<NotepadEncodingGroup[]>(FALLBACK_GROUPS);
  const [selected, setSelected] = useState(currentEncoding);
  const [actionMode, setActionMode] = useState<"convert" | "reopen">("convert");
  const [loss, setLoss] = useState<NotepadEncodingLossReport | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(currentEncoding);
    void notepadListEncodings().then((res) => {
      if (Array.isArray(res) && res.length > 0) setGroups(res);
    }).catch(() => undefined);
  }, [open, currentEncoding]);

  useEffect(() => {
    if (!open || actionMode !== "convert") {
      setLoss(null);
      return;
    }
    let cancelled = false;
    void notepadCheckEncodingLoss(content, selected)
      .then((res) => {
        if (!cancelled) setLoss(res);
      })
      .catch(() => {
        if (!cancelled) setLoss(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selected, actionMode, content]);

  if (!open) return null;

  return (
    <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-encoding-dialog">
      <div className="np-modal wide">
        <div className="np-modal-header">
          <span>{label("字符编码与转换", "Character Encoding & Conversion")}</span>
          <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="flex gap-4 text-[12px]">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              checked={actionMode === "convert"}
              data-testid="notepad-enc-mode-convert"
              onChange={() => setActionMode("convert")}
            />
            {label("转换为目标编码（保存时使用）", "Convert to Encoding (on Save)")}
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              disabled={!canReopenFromDisk}
              checked={actionMode === "reopen"}
              data-testid="notepad-enc-mode-reopen"
              onChange={() => setActionMode("reopen")}
            />
            {label("按指定编码从磁盘重新读取", "Reopen from Disk with Encoding")}
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
          {groups.map((grp) => (
            <div key={grp.group} className="border border-[var(--taomni-divider)] rounded p-2">
              <div className="font-semibold mb-1.5 text-[11px] text-[var(--taomni-text-muted)]">{grp.group}</div>
              <div className="flex flex-wrap gap-1.5">
                {grp.encodings.map((enc) => (
                  <button
                    key={enc}
                    type="button"
                    data-testid={`notepad-enc-option-${enc}`}
                    className={`np-btn ${selected === enc ? "primary" : ""}`}
                    onClick={() => setSelected(enc)}
                  >
                    {enc}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {actionMode === "convert" && loss && loss.unrepresentableCount > 0 && (
          <div
            className="flex items-start gap-2 p-2.5 rounded border border-amber-500/60 bg-amber-500/10 text-[12px]"
            data-testid="notepad-encoding-loss-warning"
          >
            <AlertTriangle size={16} className="shrink-0 text-amber-500 mt-0.5" />
            <div>
              <div className="font-semibold">
                {label(
                  `编码兼容性警告：有 ${loss.unrepresentableCount} 个字符无法在 ${loss.encoding} 中表示`,
                  `Encoding loss warning: ${loss.unrepresentableCount} characters cannot be represented in ${loss.encoding}`,
                )}
              </div>
              {loss.samples.length > 0 && (
                <div className="font-mono text-[11px] mt-1">
                  {label("示例字符：", "Sample chars: ")}
                  {loss.samples.join(" , ")}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
          <button
            type="button"
            className="np-btn primary"
            data-testid="notepad-enc-apply"
            onClick={async () => {
              if (actionMode === "reopen" && canReopenFromDisk) {
                await onReopenAs(selected);
              } else {
                onConvertTo(selected);
              }
              onClose();
            }}
          >
            {actionMode === "reopen" ? label("重新读取", "Reopen") : label("应用编码", "Apply Conversion")}
          </button>
        </div>
      </div>
    </div>
  );
}
