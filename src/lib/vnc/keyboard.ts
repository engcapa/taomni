/** Map a DOM KeyboardEvent to an RFB keysym. */
export function keyEventToKeysym(e: KeyboardEvent): number {
  if (e.code.startsWith("Numpad")) {
    const keypad: Record<string, number> = {
      Numpad0: 0xffb0,
      Numpad1: 0xffb1,
      Numpad2: 0xffb2,
      Numpad3: 0xffb3,
      Numpad4: 0xffb4,
      Numpad5: 0xffb5,
      Numpad6: 0xffb6,
      Numpad7: 0xffb7,
      Numpad8: 0xffb8,
      Numpad9: 0xffb9,
      NumpadDecimal: 0xffae,
      NumpadDivide: 0xffaf,
      NumpadMultiply: 0xffaa,
      NumpadSubtract: 0xffad,
      NumpadAdd: 0xffab,
      NumpadEnter: 0xff8d,
      NumpadEqual: 0xffbd,
      NumpadComma: 0xffac,
    };
    const keysym = keypad[e.code];
    if (keysym !== undefined) return keysym;
  }
  // Printable characters
  const printable = [...e.key];
  if (printable.length === 1) {
    return codePointToKeysym(printable[0].codePointAt(0) ?? 0);
  }
  // Named keys
  switch (e.key) {
    case "Backspace":
      return 0xff08;
    case "Tab":
      return 0xff09;
    case "Enter":
      return 0xff0d;
    case "Escape":
      return 0xff1b;
    case "Insert":
      return 0xff63;
    case "Delete":
      return 0xffff;
    case "Home":
      return 0xff50;
    case "End":
      return 0xff57;
    case "PageUp":
      return 0xff55;
    case "PageDown":
      return 0xff56;
    case "ArrowLeft":
      return 0xff51;
    case "ArrowUp":
      return 0xff52;
    case "ArrowRight":
      return 0xff53;
    case "ArrowDown":
      return 0xff54;
    case "Shift":
      return e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT ? 0xffe2 : 0xffe1;
    case "Control":
      return e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT ? 0xffe4 : 0xffe3;
    case "Alt":
      return e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT ? 0xffea : 0xffe9;
    case "Meta":
      return e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT ? 0xffec : 0xffeb;
    case "AltGraph":
      return 0xfe03;
    case "CapsLock":
      return 0xffe5;
    case "NumLock":
      return 0xff7f;
    case "ScrollLock":
      return 0xff14;
    case "PrintScreen":
      return 0xff61;
    case "Pause":
      return 0xff13;
    case "ContextMenu":
      return 0xff67;
    case "F1":
      return 0xffbe;
    case "F2":
      return 0xffbf;
    case "F3":
      return 0xffc0;
    case "F4":
      return 0xffc1;
    case "F5":
      return 0xffc2;
    case "F6":
      return 0xffc3;
    case "F7":
      return 0xffc4;
    case "F8":
      return 0xffc5;
    case "F9":
      return 0xffc6;
    case "F10":
      return 0xffc7;
    case "F11":
      return 0xffc8;
    case "F12":
      return 0xffc9;
    default: {
      const functionMatch = /^F(1[3-9]|2[0-4])$/.exec(e.key);
      if (functionMatch) return 0xffbd + Number(functionMatch[1]);
      return 0;
    }
  }
}

/** X11 keysyms used by the session menu's special-key actions. */
export const VNC_KEYSYM = {
  controlL: 0xffe3,
  altL: 0xffe9,
  delete: 0xffff,
  f8: 0xffc5,
} as const;

/**
 * Map a Unicode code point to an RFB keysym.
 *
 * Latin-1 (≤ U+00FF) maps directly — that's also the X11 keysym range. Code
 * points above 0xFF use the X.org "Unicode keysym" extension: 0x01000000 |
 * codepoint. GNOME (vino), KDE, TigerVNC, RealVNC, and X.Org all accept it,
 * which is the only way to deliver CJK/Emoji to a server that doesn't speak
 * ExtendedClipboard (the legacy ClientCutText channel is Latin-1 and
 * physically can't carry those characters).
 */
export function codePointToKeysym(cp: number): number {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return 0;
  }
  if (cp <= 0xff) return cp;
  return 0x01000000 | cp;
}

/** Iterate Unicode code points in a string (handles surrogate pairs). */
export function* iterCodePoints(text: string): Generator<number> {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) yield cp;
  }
}
