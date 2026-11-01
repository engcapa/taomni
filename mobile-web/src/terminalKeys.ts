// Phone key bar model: what each on-screen key sends to the PTY, and how the
// sticky Ctrl/Alt modifiers combine with on-screen keys and system-keyboard text.

export interface Modifiers { ctrl: boolean; alt: boolean }
export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

type KeyKind =
  | { kind: "text"; text: string }
  | { kind: "cursor"; final: "A" | "B" | "C" | "D" | "H" | "F" }
  | { kind: "tilde"; code: number }
  | { kind: "fixed"; text: string }
  | { kind: "modifier"; modifier: keyof Modifiers };

export interface KeyDef { id: string; label: string; title: string; repeat?: boolean; key: KeyKind }

const text = (value: string): KeyKind => ({ kind: "text", text: value });
const cursor = (final: "A" | "B" | "C" | "D" | "H" | "F"): KeyKind => ({ kind: "cursor", final });

// Two rows of eight. The arrows form an inverted T (↑ above ↓) so they can be
// hit without looking; Home/End and PgUp/PgDn sit around them.
export const KEY_ROWS: KeyDef[][] = [
  [
    { id: "esc", label: "Esc", title: "Esc", key: text("\x1b") },
    { id: "ctrl-c", label: "^C", title: "Ctrl-C 中断", key: text("\x03") },
    { id: "ctrl-l", label: "^L", title: "Ctrl-L 清屏", key: text("\x0c") },
    { id: "tab", label: "Tab", title: "Tab 补全", key: text("\t") },
    { id: "home", label: "Home", title: "行首", key: cursor("H") },
    { id: "up", label: "↑", title: "上", repeat: true, key: cursor("A") },
    { id: "end", label: "End", title: "行尾", key: cursor("F") },
    { id: "pgup", label: "PgUp", title: "上一页", repeat: true, key: { kind: "tilde", code: 5 } },
  ],
  [
    { id: "ctrl", label: "Ctrl", title: "Ctrl：作用于下一个键", key: { kind: "modifier", modifier: "ctrl" } },
    { id: "alt", label: "Alt", title: "Alt：作用于下一个键", key: { kind: "modifier", modifier: "alt" } },
    { id: "shift-tab", label: "⇧Tab", title: "Shift-Tab", key: { kind: "fixed", text: "\x1b[Z" } },
    { id: "pipe", label: "|", title: "竖线 |", key: text("|") },
    { id: "left", label: "←", title: "左", repeat: true, key: cursor("D") },
    { id: "down", label: "↓", title: "下", repeat: true, key: cursor("B") },
    { id: "right", label: "→", title: "右", repeat: true, key: cursor("C") },
    { id: "pgdn", label: "PgDn", title: "下一页", repeat: true, key: { kind: "tilde", code: 6 } },
  ],
];

const combo = (letter: string, title: string): KeyDef => ({ id: `ctrl-${letter}`, label: `^${letter.toUpperCase()}`, title: `Ctrl-${letter.toUpperCase()} ${title}`, key: text(String.fromCharCode(letter.charCodeAt(0) & 0x1f)) });
const symbol = (id: string, value: string, title: string): KeyDef => ({ id, label: value, title, key: text(value) });

// A scrolling third row: shell editing combos that otherwise need Ctrl plus the
// system keyboard, and symbols that sit two layers deep on phone keyboards.
export const KEY_STRIP: KeyDef[] = [
  { id: "backspace", label: "⌫", title: "退格", repeat: true, key: text("\x7f") },
  combo("r", "搜索历史"),
  combo("a", "行首"),
  combo("e", "行尾"),
  combo("w", "删除前一个词"),
  combo("u", "删除到行首"),
  combo("k", "删除到行尾"),
  combo("z", "挂起"),
  combo("d", "EOF / 退出"),
  symbol("tilde", "~", "波浪号 ~"),
  symbol("dash", "-", "减号 -"),
  symbol("slash", "/", "斜杠 /"),
  symbol("star", "*", "星号 *"),
  symbol("gt", ">", "大于号 >"),
  symbol("amp", "&", "与号 &"),
  symbol("dollar", "$", "美元符 $"),
  symbol("backslash", "\\", "反斜杠 \\"),
  symbol("backtick", "`", "反引号 `"),
  symbol("dquote", "\"", "双引号 \""),
  symbol("squote", "'", "单引号 '"),
];

/** Control character for `char` under Ctrl, or the character unchanged when Ctrl has no mapping. */
export function ctrlChar(char: string): string {
  if (char === " " || char === "@") return "\x00";
  if (char === "?") return "\x7f";
  if (char.length !== 1) return char;
  const code = char.toUpperCase().charCodeAt(0);
  // Only ASCII letters and @[\]^_ have C0 mappings. In particular, Ctrl+`
  // must not accidentally send NUL and Ctrl+~ must not send record-separator.
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  return char;
}

/** Applies armed modifiers to text typed on the system keyboard (first character only). */
export function applyTypedModifiers(data: string, modifiers: Modifiers): string {
  if (!data || (!modifiers.ctrl && !modifiers.alt)) return data;
  const [first, ...rest] = Array.from(data);
  const head = modifiers.ctrl ? ctrlChar(first) : first;
  return (modifiers.alt ? "\x1b" : "") + head + rest.join("");
}

/**
 * Bytes for an on-screen key. `appCursor` mirrors DECCKM: full-screen programs
 * (vim, less, many TUIs) switch arrows/Home/End to SS3 form.
 */
export function keySequence(def: KeyDef, modifiers: Modifiers, appCursor: boolean): string {
  const param = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  const { key } = def;
  switch (key.kind) {
    case "text": return applyTypedModifiers(key.text, modifiers);
    case "fixed": return key.text;
    case "cursor":
      if (param > 1) return `\x1b[1;${param}${key.final}`;
      return appCursor ? `\x1bO${key.final}` : `\x1b[${key.final}`;
    case "tilde": return param > 1 ? `\x1b[${key.code};${param}~` : `\x1b[${key.code}~`;
    case "modifier": return "";
  }
}

/**
 * Text sent from the paste panel. Line breaks become CR (what Enter sends), and
 * when the program enabled bracketed paste the text is wrapped so a multi-line
 * paste is not executed line by line. Embedded escape controls are made visible so
 * pasted content cannot end the bracket early.
 */
export function pastePayload(value: string, bracketed: boolean): string {
  const normalized = value.replace(/\r?\n/g, "\r");
  if (!bracketed) return normalized;
  // Match xterm 6: render embedded ESC visibly so a pasted terminal sequence
  // cannot terminate the bracket, including the alternate 8-bit CSI form.
  const safe = normalized.replace(/\x1b/g, "␛").replace(/\x9b/g, "␛[");
  return `\x1b[200~${safe}\x1b[201~`;
}

/** UTF-8 base64 without spreading the whole buffer into one call (engine argument limits). */
export function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(binary);
}
