import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InputMode } from "./terminalDisplay";

const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

/** Rare actions live in an overlay so they never take rows from the terminal. */
export function TerminalMore({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); root.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="terminal-more" ref={root}>
    <button data-testid="mobile-terminal-more" aria-label="更多终端操作" aria-expanded={open} onMouseDown={keepFocus} onClick={() => setOpen(v => !v)}>⋯</button>
    {open && <div className="terminal-menu" data-testid="mobile-terminal-menu" onClick={event => {
      const button = (event.target as HTMLElement).closest("button");
      if (button && !button.dataset.testid?.startsWith("mobile-terminal-font-")) setOpen(false);
    }}>{children}</div>}
  </div>;
}

export function TerminalInputMode({ mode, disabled, onChange }: { mode: InputMode; disabled: boolean; onChange: (mode: InputMode) => void }) {
  return <div className="input-modes" data-testid="mobile-input-modes" role="group" aria-label="终端输入方式">
    <button data-testid="mobile-input-compact" aria-pressed={mode === "compact"} onMouseDown={keepFocus} onClick={() => onChange(mode === "compact" ? "hidden" : "compact")}>紧凑键盘</button>
    <button data-testid="mobile-terminal-keyboard" disabled={disabled} aria-pressed={mode === "system"} onMouseDown={keepFocus} onClick={() => onChange(mode === "system" ? "hidden" : "system")}>中文 / 系统键盘</button>
    <button data-testid="mobile-input-hide" aria-label="收起输入区" disabled={mode === "hidden"} onMouseDown={keepFocus} onClick={() => onChange("hidden")}>⌄</button>
  </div>;
}
