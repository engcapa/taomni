import { parseSessionOptions } from "./terminalProfile";

export interface SessionBookmark {
  customIcon: string;
  bgImage: string;
  bgOpacity: string;
  autoConnect: boolean;
  openNewWindow: boolean;
  reconnect: boolean;
  shortcut: string;
}

export function readSessionBookmark(optionsJson?: string | null): SessionBookmark {
  const options = parseSessionOptions(optionsJson);
  const text = (key: string, fallback = "") => typeof options[key] === "string" ? options[key] as string : fallback;
  return {
    customIcon: text("customIcon"),
    bgImage: text("bgImage"), bgOpacity: text("bgOpacity", "35%"),
    autoConnect: options.autoConnect === true,
    openNewWindow: options.openNewWindow === true,
    reconnect: options.reconnect === true,
    shortcut: text("shortcut"),
  };
}

export function bookmarkOpacity(value: string): number {
  if (!value.trim()) return 0.35;
  const parsed = Number(value.trim().replace(/%$/, ""));
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) / 100 : 0.35;
}

export function shortcutMatches(shortcut: string, event: KeyboardEvent, mac: boolean): boolean {
  const parts = shortcut.toLowerCase().split("+").map((s) => s.trim());
  const key = parts.pop();
  if (!key || !parts.length || !parts.every((p) => ["ctrl", "control", "alt", "shift", "meta", "cmd", "mod"].includes(p))) return false;
  const ctrl = parts.includes("ctrl") || parts.includes("control") || (parts.includes("mod") && !mac);
  const meta = parts.includes("meta") || parts.includes("cmd") || (parts.includes("mod") && mac);
  return event.key.toLowerCase() === key && event.ctrlKey === ctrl && event.metaKey === meta
    && event.altKey === parts.includes("alt") && event.shiftKey === parts.includes("shift");
}
