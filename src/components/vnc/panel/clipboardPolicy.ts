import { getAppPlatform, isTauriRuntime } from "../../../lib/runtime";
import { readText as readClipboardText, readNativeTextResult } from "../../../lib/clipboard";


export const PASTE_KEY_DELAY_MS = 120;

/** Upper bound a middle click waits for an in-flight clipboard sync (X11 paste). */
export const MIDDLE_CLICK_CLIPBOARD_WAIT_MS = 150;

export const CLIPBOARD_SYNC_MIN_INTERVAL_MS = 250;

/** RealVNC `ServerClipboardGraceTime`: ignore local changes right after a server paste. */
export const SERVER_CLIPBOARD_GRACE_MS = 1000;

/** "Send clipboard as keystrokes" limit and pacing. */
export const CLIPBOARD_KEYSTROKE_LIMIT = 4096;

export const CLIPBOARD_KEYSTROKE_BATCH = 64;


export function modifierKeysymFromKey(key: string): number | null {
  switch (key) {
    case "Shift":
      return 0xffe1;
    case "Control":
      return 0xffe3;
    case "Alt":
      return 0xffe9;
    case "Meta":
      return 0xffeb;
    default:
      return null;
  }
}


export function pasteModifierKeysyms(e: KeyboardEvent): Set<number> {
  const keysyms = new Set<number>();
  if (e.shiftKey) keysyms.add(0xffe1);
  if (e.ctrlKey) keysyms.add(0xffe3);
  if (e.altKey) keysyms.add(0xffe9);
  if (e.metaKey) keysyms.add(0xffeb);
  return keysyms;
}


export function isPasteShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V");
}


export function hasNonAsciiText(text: string): boolean {
  return /[^\x00-\x7f]/.test(text);
}


export async function readVncClipboardText(webText?: string): Promise<string> {
  const text = webText ?? await readClipboardText();
  // WebKitGTK can return an empty string after an external X11 owner replaces
  // the clipboard. Resolve that empty result through the native clipboard.
  if (!text && isTauriRuntime() && getAppPlatform() === "linux") {
    return (await readNativeTextResult()).text;
  }
  return text;
}
