import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

/** A snapshot of the current emulator buffer, without ANSI sequences or wraps. */
export function terminalCopyText(term: Pick<Terminal, "buffer" | "getSelection">): string {
  const selected = term.getSelection();
  if (selected) return selected;
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const next = buffer.getLine(i + 1);
    // Preserve real spaces at soft wraps, but not the empty cell used when a
    // wide character has to start on the next physical row.
    const widePadding = next?.isWrapped && next.getCell(0)?.getWidth() === 2
      && line.getCell(line.length - 1)?.getCode() === 0;
    const text = line.translateToString(!next?.isWrapped, 0, widePadding ? line.length - 1 : line.length);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

export function TerminalCopy({ text, returnFocus, onClose, onCopied }: {
  text: string;
  returnFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCopied: (message: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [selected, setSelected] = useState(false);
  const [error, setError] = useState("");
  const selection = useRef({ start: 0, end: 0 });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const previous = returnFocus?.current ?? document.activeElement as HTMLElement | null;
    field.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const items = root.current?.querySelectorAll<HTMLElement>("button,textarea");
      if (!items?.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { mounted.current = false; document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, [onClose, returnFocus]);

  const copy = async () => {
    const { start, end } = selection.current;
    const value = end > start ? text.slice(start, end) : text;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch { /* Keep the selected text available for the browser copy action. */ }
    if (!mounted.current) return;
    if (!copied && field.current) {
      field.current.focus();
      field.current.setSelectionRange(end > start ? start : 0, end > start ? end : text.length);
      try { copied = document.execCommand("copy"); } catch { /* Manual copy remains available. */ }
    }
    if (copied) { onCopied(end > start ? "已复制所选内容。" : "已复制全部可用输出。"); onClose(); }
    else setError("浏览器未允许自动复制，请长按下方文本，选择后使用系统“复制”。");
  };
  return <div className="terminal-copy-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={root} className="terminal-copy" role="dialog" aria-modal="true" aria-labelledby="mobile-copy-title" data-testid="mobile-terminal-copy-dialog">
      <div className="section-heading">
        <h2 id="mobile-copy-title">复制终端内容</h2>
        <button data-testid="mobile-terminal-copy-close" onClick={onClose} aria-label="关闭复制面板">×</button>
      </div>
      <p className="note">长按文本可选择部分内容，也可直接复制全部。这里是打开时的输出快照。</p>
      {error && <p role="status" data-testid="mobile-terminal-copy-error">{error}</p>}
      <textarea ref={field} readOnly value={text} aria-label="可复制的终端输出" data-testid="mobile-terminal-copy-text" spellCheck={false}
        onSelect={event => {
          selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
          setSelected(selection.current.end > selection.current.start);
        }} />
      <button className="primary" data-testid="mobile-terminal-copy-confirm" disabled={!text} onMouseDown={event => event.preventDefault()} onClick={() => void copy()}>{selected ? "复制所选" : "复制全部"}</button>
    </div>
  </div>;
}
