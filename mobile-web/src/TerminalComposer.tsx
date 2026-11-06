import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { editDraft } from "./terminalDraft";

const HISTORY_LIMIT = 20;

/**
 * Native text fields for terminal input. Typing straight into xterm's hidden
 * textarea fights phone IMEs, autocorrect and voice dictation; a real input
 * gets all of them, and Enter sends the line. An empty line sends Enter alone.
 * The multi-line panel keeps paste explicit (it never reads the clipboard on
 * its own) and recent lines can be reused from the history.
 */
export function TerminalComposer({ disabled, panelOpen, onSend, onNotice, keyHandler, systemKeyboard = true }: {
  disabled: boolean;
  panelOpen: boolean;
  /** Sends text as a paste (newlines → Enter, bracketed when enabled); returns false when nothing was sent. */
  onSend: (text: string, enter: boolean) => boolean;
  onNotice: (text: string) => void;
  /** Lets the key bar edit a focused native draft instead of the remote shell. */
  keyHandler?: RefObject<((key: string) => boolean) | null>;
  systemKeyboard?: boolean;
}) {
  const [line, setLine] = useState("");
  const [paste, setPaste] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const composing = useRef(false);
  const lineInput = useRef<HTMLInputElement>(null);
  const pasteInput = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ field: HTMLInputElement | HTMLTextAreaElement; start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    if (systemKeyboard && !disabled) lineInput.current?.focus();
    else { lineInput.current?.blur(); pasteInput.current?.blur(); }
  }, [systemKeyboard]);
  useLayoutEffect(() => { if (disabled) { lineInput.current?.blur(); pasteInput.current?.blur(); } }, [disabled]);
  useLayoutEffect(() => {
    if (!keyHandler) return;
    keyHandler.current = key => {
      const active = document.activeElement;
      const field = active === lineInput.current ? lineInput.current : active === pasteInput.current ? pasteInput.current : null;
      if (!field) return false;
      // Do not corrupt a partially composed IME candidate with an on-screen key.
      if (disabled || composing.current) return true;
      const value = field === lineInput.current ? line : paste;
      const edit = editDraft(value, field.selectionStart ?? value.length, field.selectionEnd ?? value.length, key);
      if (!edit) return false;
      if (field === lineInput.current) setLine(edit.value); else setPaste(edit.value);
      selection.current = { field, start: edit.start, end: edit.end };
      // A pure caret move may not render (the text is unchanged).
      field.setSelectionRange(edit.start, edit.end);
      return true;
    };
    return () => { keyHandler.current = null; };
  }, [disabled, keyHandler, line, paste]);
  useLayoutEffect(() => {
    const next = selection.current;
    if (next) { next.field.setSelectionRange(next.start, next.end); selection.current = null; }
  });
  const remember = (value: string) => {
    if (value.trim()) setHistory(h => [value, ...h.filter(v => v !== value)].slice(0, HISTORY_LIMIT));
  };
  const submitLine = () => {
    if (disabled || composing.current || !onSend(line, true)) return;
    remember(line); setLine("");
  };
  const submitPaste = (enter: boolean) => {
    // Keep the text when it could not be sent, so it can be retried.
    if (disabled || !paste || !onSend(paste, enter)) return;
    remember(paste); setPaste("");
  };
  const reuse = (value: string) => { if (/[\r\n]/.test(value)) setPaste(value); else setLine(value); };
  return <>
    <form className="command-bar" hidden={!systemKeyboard} onSubmit={event => { event.preventDefault(); submitLine(); }}>
      <input
        ref={lineInput}
        data-testid="mobile-terminal-command"
        aria-label="终端命令"
        value={line}
        disabled={disabled}
        onChange={event => setLine(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          // Safari/Android IMEs use Enter to accept a candidate, not to run the
          // unfinished command. keyCode 229 covers Safari's composition edge.
          if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
        }}
        placeholder={disabled ? "先接管输入" : "输入命令…"}
        enterKeyHint="send"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        maxLength={8192}
      />
      <button className="primary" data-testid="mobile-terminal-command-send" disabled={disabled} onMouseDown={event => event.preventDefault()}>发送</button>
    </form>
    {panelOpen && <div className="paste-panel" role="region" aria-label="多行输入与历史">
      <label>多行内容<textarea ref={pasteInput} data-testid="mobile-terminal-input" disabled={disabled} value={paste} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onChange={event => setPaste(event.target.value)} maxLength={8192} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
      <div className="actions">
        <button disabled={disabled || !paste} data-testid="mobile-terminal-send" onClick={() => submitPaste(false)}>发送到终端</button>
        <button disabled={disabled || !paste} data-testid="mobile-terminal-send-enter" onClick={() => submitPaste(true)}>发送并回车</button>
        {window.isSecureContext && <button disabled={disabled} onClick={() => navigator.clipboard.readText().then(setPaste).catch(() => onNotice("无法读取剪贴板，请使用系统粘贴。"))}>读取剪贴板</button>}
      </div>
      {history.length > 0 && <p className="note">最近发送（点一下放回输入框）</p>}
      {history.map(value => <button key={value} className="history" data-testid="mobile-terminal-history" onClick={() => reuse(value)}>{value.slice(0, 80)}</button>)}
    </div>}
  </>;
}
