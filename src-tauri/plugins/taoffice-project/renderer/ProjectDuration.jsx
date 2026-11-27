import { MINUTE } from "./scheduleTime.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useRef, useState } = React;
const HOUR = 60 * MINUTE;

export function ProjectDuration({ duration, onApply, saving, label }) {
  const [input, setInput] = useState(null);
  const field = useRef(null);
  const button = useRef(null);
  const restoreFocus = useRef(false);
  const editing = input !== null;
  const hours = duration == null ? null : Number((duration / HOUR).toFixed(4));
  const valid = editing && input.trim() && Number.isFinite(Number(input)) && Number(input) >= 0 && Number(input) <= 87_840;

  useEffect(() => {
    if (editing) {
      field.current?.focus();
      field.current?.select();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      button.current?.focus();
    }
  }, [editing]);

  if (!onApply) return hours ?? "—";
  const title = label("编辑工期（小时）", "Edit duration (hours)");
  const done = () => {
    restoreFocus.current = true;
    setInput(null);
  };
  function apply(event) {
    event.preventDefault();
    event.stopPropagation();
    if (valid && onApply(Math.round(Number(input) * HOUR))) done();
  }
  if (editing) return <form className="taoffice-project-duration-form" onSubmit={apply} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    done();
  }}>
    <input ref={field} type="text" inputMode="decimal" className="taomni-input"
      data-testid="taoffice-project-duration-input" aria-label={title} aria-invalid={!valid}
      value={input} disabled={saving} onChange={(event) => setInput(event.target.value)} />
    <button type="button" className="taomni-btn" onClick={done}>{label("取消", "Cancel")}</button>
    <button type="submit" className="taomni-btn" disabled={saving || !valid}>{label("应用工期", "Apply duration")}</button>
  </form>;
  return <button ref={button} type="button" className="taomni-btn" data-testid="taoffice-project-duration"
    disabled={saving} aria-label={hours === null ? title : `${title}: ${hours}`} title={title}
    onClick={() => setInput(hours === null ? "" : String(hours))}>{hours ?? "—"}</button>;
}
