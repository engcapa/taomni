import { useMemo } from "react";
import { X } from "lucide-react";
import type { NotepadCompareState } from "../../../stores/notepadStore";
import { useViewerLabels } from "../../viewer/viewerLabels";

interface DiffRow {
  lineNumLeft: number | null;
  lineNumRight: number | null;
  left: string;
  right: string;
  kind: "same" | "changed" | "added" | "removed";
}

function buildLineDiffRows(
  leftText: string,
  rightText: string,
  ignoreWhitespace: boolean,
  ignoreCase: boolean,
): DiffRow[] {
  const norm = (s: string) => {
    let v = ignoreWhitespace ? s.trim().replace(/\s+/g, " ") : s;
    if (ignoreCase) v = v.toLowerCase();
    return v;
  };
  const a = leftText.split("\n");
  const b = rightText.split("\n");
  const max = Math.max(a.length, b.length);
  const rows: DiffRow[] = [];
  for (let i = 0; i < max; i += 1) {
    const l = a[i];
    const r = b[i];
    if (l === undefined) {
      rows.push({ lineNumLeft: null, lineNumRight: i + 1, left: "", right: r, kind: "added" });
    } else if (r === undefined) {
      rows.push({ lineNumLeft: i + 1, lineNumRight: null, left: l, right: "", kind: "removed" });
    } else if (norm(l) === norm(r)) {
      rows.push({ lineNumLeft: i + 1, lineNumRight: i + 1, left: l, right: r, kind: "same" });
    } else {
      rows.push({ lineNumLeft: i + 1, lineNumRight: i + 1, left: l, right: r, kind: "changed" });
    }
  }
  return rows;
}

export function CompareOverlay({
  compare,
  onPatch,
  onClose,
}: {
  compare: NotepadCompareState | null;
  onPatch: (patch: Partial<NotepadCompareState>) => void;
  onClose: () => void;
}) {
  const label = useViewerLabels();
  const rows = useMemo(
    () =>
      compare
        ? buildLineDiffRows(compare.leftContent, compare.rightContent, compare.ignoreWhitespace, compare.ignoreCase)
        : [],
    [compare],
  );
  if (!compare || !compare.open) return null;

  const diffCount = rows.filter((r) => r.kind !== "same").length;

  return (
    <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-compare-dialog">
      <div className="np-modal wide" style={{ width: "min(960px, calc(100vw - 32px))" }}>
        <div className="np-modal-header">
          <span>{label("文档对比", "Compare Documents")} ({diffCount} {label("处差异行", "differences")})</span>
          <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="flex items-center gap-4 text-[12px]">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={compare.ignoreWhitespace}
              onChange={(e) => onPatch({ ignoreWhitespace: e.target.checked })}
            />
            {label("忽略空白变化", "Ignore whitespace")}
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={compare.ignoreCase}
              onChange={(e) => onPatch({ ignoreCase: e.target.checked })}
            />
            {label("忽略大小写", "Ignore case")}
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px] font-semibold text-[var(--taomni-text-muted)]">
          <div className="truncate">{compare.leftTitle}</div>
          <div className="truncate">{compare.rightTitle}</div>
        </div>

        <div className="max-h-96 overflow-auto border border-[var(--taomni-divider)] rounded font-mono text-[11px]">
          {rows.map((row, idx) => (
            <div
              key={idx}
              className={`grid grid-cols-2 border-b border-[var(--taomni-divider)]/40 ${
                row.kind === "changed"
                  ? "bg-amber-500/15"
                  : row.kind === "added"
                    ? "bg-emerald-500/15"
                    : row.kind === "removed"
                      ? "bg-red-500/15"
                      : ""
              }`}
            >
              <div className="flex gap-2 px-2 py-0.5 border-r border-[var(--taomni-divider)] whitespace-pre-wrap break-all">
                <span className="w-8 text-right opacity-50 select-none">{row.lineNumLeft ?? ""}</span>
                <span>{row.left}</span>
              </div>
              <div className="flex gap-2 px-2 py-0.5 whitespace-pre-wrap break-all">
                <span className="w-8 text-right opacity-50 select-none">{row.lineNumRight ?? ""}</span>
                <span>{row.right}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
