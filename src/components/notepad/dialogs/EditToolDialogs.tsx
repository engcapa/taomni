import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { previewColumnCells, type ColumnInsertSpec, type ColumnNumberRadix } from "../../../lib/notepad/transforms/column";
import { useViewerLabels } from "../../viewer/viewerLabels";

export type NotepadEditModalKind = "goto" | "columnEditor" | null;

export function EditToolDialogs({
  kind,
  currentLine,
  totalLines,
  currentOffset,
  totalLength,
  onClose,
  onGoTo,
  onApplyColumn,
}: {
  kind: NotepadEditModalKind;
  currentLine: number;
  totalLines: number;
  currentOffset: number;
  totalLength: number;
  onClose: () => void;
  onGoTo: (mode: "line" | "offset", value: number) => void;
  onApplyColumn: (spec: ColumnInsertSpec) => void;
}) {
  const label = useViewerLabels();
  const [goMode, setGoMode] = useState<"line" | "offset">("line");
  const [goVal, setGoVal] = useState(String(goMode === "line" ? currentLine : currentOffset));

  const [colMode, setColMode] = useState<"text" | "number">("text");
  const [colText, setColText] = useState("");
  const [initial, setInitial] = useState(1);
  const [increment, setIncrement] = useState(1);
  const [repeat, setRepeat] = useState(1);
  const [radix, setRadix] = useState<ColumnNumberRadix>(10);
  const [leadingZeros, setLeadingZeros] = useState(false);

  useEffect(() => {
    if (kind === "goto") {
      setGoVal(String(goMode === "line" ? currentLine : currentOffset));
    }
  }, [kind, goMode, currentLine, currentOffset]);

  if (!kind) return null;

  if (kind === "goto") {
    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-goto-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span>{label("转到行 / 偏移量", "Go To Line / Offset")}</span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <div className="flex gap-4 text-ui-body">
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" checked={goMode === "line"} onChange={() => { setGoMode("line"); setGoVal(String(currentLine)); }} />
              {label(`行号 (1–${totalLines})`, `Line (1–${totalLines})`)}
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" checked={goMode === "offset"} onChange={() => { setGoMode("offset"); setGoVal(String(currentOffset)); }} />
              {label(`字符偏移 (0–${totalLength})`, `Offset (0–${totalLength})`)}
            </label>
          </div>
          <input
            type="number"
            className="np-input"
            data-testid="notepad-goto-input"
            value={goVal}
            onChange={(e) => setGoVal(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
            <button
              type="button"
              className="np-btn primary"
              data-testid="notepad-goto-confirm"
              onClick={() => {
                const parsed = Number.parseInt(goVal, 10);
                const minVal = goMode === "line" ? 1 : 0;
                onGoTo(goMode, Number.isNaN(parsed) ? minVal : Math.max(minVal, parsed));
                onClose();
              }}
            >
              {label("跳转", "Go")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const spec: ColumnInsertSpec = colMode === "text"
    ? { mode: "text", text: colText }
    : { mode: "number", initial, increment, repeat, radix, leadingZeros };
  const preview = previewColumnCells(spec, 4);

  return (
    <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-column-dialog">
      <div className="np-modal">
        <div className="np-modal-header">
          <span>{label("列块编辑 (Column Editor)", "Column / Block Editor")}</span>
          <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="flex gap-4 text-ui-body">
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" checked={colMode === "text"} onChange={() => setColMode("text")} />
            {label("插入文本", "Text to Insert")}
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" checked={colMode === "number"} data-testid="notepad-col-mode-number" onChange={() => setColMode("number")} />
            {label("插入递增数字", "Number to Insert")}
          </label>
        </div>

        {colMode === "text" ? (
          <input
            type="text"
            className="np-input"
            data-testid="notepad-col-text"
            placeholder={label("每行插入的文本...", "Text inserted on every spanned line...")}
            value={colText}
            onChange={(e) => setColText(e.target.value)}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 text-ui-body">
            <label className="flex flex-col gap-1">
              <span>{label("起始数字", "Initial number")}</span>
              <input type="number" className="np-input" data-testid="notepad-col-initial" value={initial} onChange={(e) => setInitial(Number(e.target.value))} />
            </label>
            <label className="flex flex-col gap-1">
              <span>{label("步进增量", "Increase by")}</span>
              <input type="number" className="np-input" data-testid="notepad-col-step" value={increment} onChange={(e) => setIncrement(Number(e.target.value))} />
            </label>
            <label className="flex flex-col gap-1">
              <span>{label("每步重复次数", "Repeat")}</span>
              <input type="number" min={1} className="np-input" data-testid="notepad-col-repeat" value={repeat} onChange={(e) => setRepeat(Math.max(1, Number(e.target.value)))} />
            </label>
            <label className="flex flex-col gap-1">
              <span>{label("进制格式", "Format")}</span>
              <select className="np-input" data-testid="notepad-col-radix" value={radix} onChange={(e) => setRadix(Number(e.target.value) as ColumnNumberRadix)}>
                <option value={10}>Dec (10)</option>
                <option value={16}>Hex (16)</option>
                <option value={8}>Oct (8)</option>
                <option value={2}>Bin (2)</option>
              </select>
            </label>
            <label className="col-span-2 inline-flex items-center gap-2">
              <input type="checkbox" checked={leadingZeros} data-testid="notepad-col-zeros" onChange={(e) => setLeadingZeros(e.target.checked)} />
              {label("前导补零", "Leading zeros")}
            </label>
          </div>
        )}

        <div className="text-ui-small bg-[var(--taomni-bg)] border border-[var(--taomni-divider)] rounded p-2 font-mono">
          <div className="text-[var(--taomni-text-muted)] mb-1">{label("预览（前 4 行）", "Preview (first 4 rows)")}</div>
          {preview.map((item, idx) => <div key={idx}>{item || "(empty)"}</div>)}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
          <button
            type="button"
            className="np-btn primary"
            data-testid="notepad-col-apply"
            onClick={() => {
              onApplyColumn(spec);
              onClose();
            }}
          >
            {label("确定插入", "Insert")}
          </button>
        </div>
      </div>
    </div>
  );
}
