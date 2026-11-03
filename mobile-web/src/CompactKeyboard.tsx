import { useState } from "react";
import { applyTypedModifiers, type Modifiers } from "./terminalKeys";

const LETTERS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const SYMBOLS = ["1234567890", "-/:;()$&@", "_\\|~`[]{}"];
const SHIFT_SYMBOLS = ["!@#$%^&*()", "=+\"'<>?,:", "_\\|~`[]{}"];

/** Direct PTY keys: no editable element takes focus or opens the OS keyboard. */
export function CompactKeyboard({ disabled, modifiers, onSend }: {
  disabled: boolean;
  modifiers: Modifiers;
  onSend: (value: string) => void;
}) {
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const send = (value: string) => {
    onSend(applyTypedModifiers(value, modifiers));
    setShift(false);
  };
  const key = (value: string, label = value, id = value) => <button
    key={id} type="button" disabled={disabled} data-testid={`mobile-type-${id}`}
    aria-label={label} onMouseDown={event => event.preventDefault()} onClick={() => send(value)}
  >{label}</button>;
  return <div className="compact-keyboard" data-testid="mobile-compact-keyboard" role="group" aria-label="紧凑终端键盘" onContextMenu={event => event.preventDefault()}>
    {(symbols ? shift ? SHIFT_SYMBOLS : SYMBOLS : LETTERS).map((row, index) => <div className="typing-row" key={index}>
      {index === 2 && <button type="button" disabled={disabled} aria-label="Shift" aria-pressed={shift} onMouseDown={event => event.preventDefault()} onClick={() => setShift(v => !v)}>⇧</button>}
      {Array.from(shift && !symbols ? row.toUpperCase() : row).map(value => key(value))}
      {index === 2 && key("\x7f", "退格", "backspace")}
    </div>)}
    <div className="typing-row">
      <button type="button" disabled={disabled} aria-label="切换数字符号" aria-pressed={symbols} onMouseDown={event => event.preventDefault()} onClick={() => setSymbols(v => !v)}>{symbols ? "ABC" : "123"}</button>
      {key("/", "/", "slash")}{key("-", "-", "dash")}
      <button type="button" className="space-key" disabled={disabled} data-testid="mobile-type-space" onMouseDown={event => event.preventDefault()} onClick={() => send(" ")}>空格</button>
      {key(".", ".", "dot")}{key("\r", "回车", "enter")}
    </div>
  </div>;
}
