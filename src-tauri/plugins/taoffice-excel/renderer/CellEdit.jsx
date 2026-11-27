import { numericCell } from "./workbookEdits.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useId, useRef, useState } = React;

export function CellEdit({ type, address, original, label, platform, onCommit, onCancel, onSave }) {
  const errorId = useId();
  const input = useRef(null);
  const finished = useRef(false);
  const [value, setValue] = useState(original);
  const [error, setError] = useState("");

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  function commit(move = 0) {
    if (finished.current) return false;
    const next = type === "number" ? value.trim() : value;
    if (type === "number" && (!numericCell.test(next) || !Number.isFinite(Number(next)))) {
      setError(label("请输入有效数字。", "Enter a valid number."));
      return false;
    }
    if (!onCommit(next, move)) {
      setError(label("副本最多保存 128 处单元格更改。", "A copy can contain up to 128 edited cells."));
      return false;
    }
    finished.current = true;
    return true;
  }

  return <div className="taoffice-excel-edit">
    <input ref={input} className="taomni-input" data-testid="taoffice-excel-input"
      aria-label={label(`编辑单元格 ${address}`, `Edit cell ${address}`)} aria-invalid={!!error}
      aria-describedby={error ? errorId : undefined}
      maxLength={960} value={value} onChange={(event) => { setValue(event.target.value); setError(""); }}
      onBlur={() => commit()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        const mod = platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        if (mod && !event.altKey && !event.shiftKey && event.key === "s") {
          event.preventDefault();
          event.stopPropagation();
          if (commit()) onSave();
          return;
        }
        if (!["Escape", "Enter", "Tab"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          finished.current = true;
          onCancel();
        } else {
          commit(event.key === "Tab" ? event.shiftKey ? -1 : 1 : 0);
        }
      }} />
    {error && <span id={errorId} role="alert" data-testid="taoffice-excel-input-error">{error}</span>}
  </div>;
}
