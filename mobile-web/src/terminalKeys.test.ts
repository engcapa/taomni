import { expect, it } from "vitest";
import { KEY_ROWS, KEY_STRIP, NO_MODIFIERS, applyTypedModifiers, ctrlChar, encodeBase64, keySequence, pastePayload } from "./terminalKeys";

const key = (id: string) => KEY_ROWS.flat().find(def => def.id === id)!;
const ctrl = { ctrl: true, alt: false };
const alt = { ctrl: false, alt: true };

it("lays out two rows of eight with ↑ directly above ↓ and ← → beside it", () => {
  expect(KEY_ROWS.map(row => row.length)).toEqual([8, 8]);
  const up = KEY_ROWS[0].findIndex(def => def.id === "up");
  expect(KEY_ROWS[1].slice(up - 1, up + 2).map(def => def.id)).toEqual(["left", "down", "right"]);
  expect(new Set(KEY_ROWS.flat().map(def => def.id)).size).toBe(16);
});

it("sends normal and application-mode cursor sequences for all four arrows", () => {
  expect(["up", "down", "right", "left"].map(id => keySequence(key(id), NO_MODIFIERS, false))).toEqual(["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"]);
  expect(["up", "down", "right", "left"].map(id => keySequence(key(id), NO_MODIFIERS, true))).toEqual(["\x1bOA", "\x1bOB", "\x1bOC", "\x1bOD"]);
  expect(keySequence(key("home"), NO_MODIFIERS, false)).toBe("\x1b[H");
  expect(keySequence(key("end"), NO_MODIFIERS, true)).toBe("\x1bOF");
  expect(keySequence(key("pgup"), NO_MODIFIERS, true)).toBe("\x1b[5~");
  expect(keySequence(key("pgdn"), NO_MODIFIERS, false)).toBe("\x1b[6~");
});

it("encodes Ctrl and Alt on navigation keys with the xterm modifier parameter", () => {
  expect(keySequence(key("left"), ctrl, true)).toBe("\x1b[1;5D");
  expect(keySequence(key("right"), alt, false)).toBe("\x1b[1;3C");
  expect(keySequence(key("up"), { ctrl: true, alt: true }, false)).toBe("\x1b[1;7A");
  expect(keySequence(key("pgdn"), ctrl, false)).toBe("\x1b[6;5~");
});

it("keeps the fixed control keys and applies modifiers to text keys", () => {
  expect(keySequence(key("ctrl-c"), NO_MODIFIERS, false)).toBe("\x03");
  expect(keySequence(key("ctrl-l"), NO_MODIFIERS, false)).toBe("\x0c");
  expect(keySequence(key("esc"), NO_MODIFIERS, false)).toBe("\x1b");
  expect(keySequence(key("tab"), NO_MODIFIERS, false)).toBe("\t");
  expect(keySequence(key("shift-tab"), ctrl, false)).toBe("\x1b[Z");
  expect(keySequence(key("pipe"), NO_MODIFIERS, false)).toBe("|");
  expect(keySequence(key("pipe"), alt, false)).toBe("\x1b|");
  expect(keySequence(key("ctrl"), NO_MODIFIERS, false)).toBe("");
});

it("maps typed text through one-shot Ctrl/Alt on its first character only", () => {
  expect(ctrlChar("c")).toBe("\x03");
  expect(ctrlChar("R")).toBe("\x12");
  expect(ctrlChar("[")).toBe("\x1b");
  expect(ctrlChar(" ")).toBe("\x00");
  expect(ctrlChar("?")).toBe("\x7f");
  expect(ctrlChar("中")).toBe("中");
  expect(ctrlChar("`")).toBe("`");
  expect(ctrlChar("~")).toBe("~");
  expect(ctrlChar("{")).toBe("{");
  expect(applyTypedModifiers("d", ctrl)).toBe("\x04");
  expect(applyTypedModifiers("ls", ctrl)).toBe("\x0cs");
  expect(applyTypedModifiers("b", alt)).toBe("\x1bb");
  expect(applyTypedModifiers("😀x", ctrl)).toBe("😀x");
  expect(applyTypedModifiers("ls", NO_MODIFIERS)).toBe("ls");
});

it("converts pasted line breaks to Enter and brackets them only when the program asked", () => {
  expect(pastePayload("a\nb\r\nc", false)).toBe("a\rb\rc");
  expect(pastePayload("a\nb", true)).toBe("\x1b[200~a\rb\x1b[201~");
  expect(pastePayload("x\x1b[201~echo injected\n", true)).toBe("\x1b[200~x␛[201~echo injected\r\x1b[201~");
  expect(pastePayload("x\x9b201~", true)).toBe("\x1b[200~x␛[201~\x1b[201~");
});

it("base64-encodes UTF-8 input larger than one conversion chunk", () => {
  const text = "中".repeat(8192);
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(encodeBase64(text)), c => c.charCodeAt(0)));
  expect(decoded).toBe(text);
  expect(encodeBase64("\x1b[D")).toBe(btoa("\x1b[D"));
});

it("offers shell editing combos and hard-to-reach symbols on the scrolling strip", () => {
  const all = [...KEY_ROWS.flat(), ...KEY_STRIP];
  expect(new Set(all.map(def => def.id)).size).toBe(all.length);
  const strip = (id: string) => keySequence(KEY_STRIP.find(def => def.id === id)!, NO_MODIFIERS, false);
  expect(["ctrl-r", "ctrl-a", "ctrl-e", "ctrl-w", "ctrl-u", "ctrl-k", "ctrl-z", "ctrl-d"].map(strip)).toEqual(["\x12", "\x01", "\x05", "\x17", "\x15", "\x0b", "\x1a", "\x04"]);
  expect(strip("backspace")).toBe("\x7f");
  expect(["tilde", "dash", "slash", "star", "gt", "amp", "dollar", "backslash", "backtick", "dquote", "squote"].map(strip).join("")).toBe("~-/*>&$\\`\"'");
  expect(keySequence(KEY_STRIP.find(def => def.id === "dash")!, alt, false)).toBe("\x1b-");
});
