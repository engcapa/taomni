import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { KEY_ROWS, KEY_STRIP, NO_MODIFIERS, keySequence, type KeyDef, type Modifiers } from "./terminalKeys";

const REPEAT_DELAY_MS = 450;
const REPEAT_INTERVAL_MS = 80;

// Keeping focus in xterm's hidden textarea keeps the soft keyboard open while
// the user taps keys; a focused button would dismiss it after every tap.
const keepFocus = (event: MouseEvent) => event.preventDefault();

export function TerminalKeybar({ disabled, modifiers, onModifiers, onSend, appCursor }: {
  disabled: boolean;
  modifiers: Modifiers;
  onModifiers: (next: Modifiers) => void;
  onSend: (data: string) => void;
  appCursor: () => boolean;
}) {
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; repeat?: ReturnType<typeof setInterval>; repeated: boolean }>({ repeated: false });
  const stop = () => {
    clearTimeout(timers.current.delay);
    clearInterval(timers.current.repeat);
    timers.current.delay = timers.current.repeat = undefined;
  };
  useEffect(() => stop, []);
  useEffect(() => { if (disabled) stop(); }, [disabled]);

  // The sequence is fixed at press time so a held Ctrl-→ keeps its modifier
  // while repeating; the one-shot modifiers are cleared after the first send.
  const press = (def: KeyDef) => {
    const data = keySequence(def, modifiers, appCursor());
    onSend(data);
    if (modifiers.ctrl || modifiers.alt) onModifiers(NO_MODIFIERS);
    return data;
  };
  const startRepeat = (def: KeyDef) => {
    stop();
    timers.current.delay = setTimeout(() => {
      timers.current.repeated = true;
      const data = press(def);
      timers.current.repeat = setInterval(() => onSend(data), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  };
  const click = (def: KeyDef) => {
    if (disabled) return;
    if (def.key.kind === "modifier") {
      const name = def.key.modifier;
      onModifiers({ ...modifiers, [name]: !modifiers[name] });
      return;
    }
    // A long press already sent the key; the trailing click must not add one more.
    if (timers.current.repeated) { timers.current.repeated = false; return; }
    stop();
    press(def);
  };
  const pointerDown = (def: KeyDef) => (event: PointerEvent) => {
    // A repeat that ended with the finger sliding off never got its click.
    timers.current.repeated = false;
    if (disabled || !def.repeat || event.button !== 0) return;
    startRepeat(def);
  };

  const button = (def: KeyDef) => {
    const modifier = def.key.kind === "modifier" ? def.key.modifier : null;
    return <button
      key={def.id}
      type="button"
      data-testid={`mobile-key-${def.id}`}
      className={modifier ? "modifier" : undefined}
      aria-pressed={modifier ? modifiers[modifier] : undefined}
      aria-label={def.title}
      title={def.title}
      disabled={disabled}
      onMouseDown={keepFocus}
      onPointerDown={pointerDown(def)}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onClick={() => click(def)}
    >{def.label}</button>;
  };
  const all = KEY_ROWS.flat();
  const primary = ["esc", "tab", "ctrl", "alt", "left", "up", "down", "right"];
  const ordered = [...primary.map(id => all.find(def => def.id === id)!), ...all.filter(def => !primary.includes(def.id))];
  return <div className="keys" onContextMenu={e => e.preventDefault()}>
    <div className="keybar" role="group" aria-label="终端常用键" data-testid="mobile-keybar">{ordered.map(button)}</div>
    <div className="keystrip" role="group" aria-label="组合键与符号" data-testid="mobile-keystrip">{KEY_STRIP.map(button)}</div>
  </div>;
}
