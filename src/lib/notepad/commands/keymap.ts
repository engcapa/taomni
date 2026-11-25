import { contentZoomShortcut } from "../../contentZoomShortcut";
import { create } from "zustand";
import { NOTEPAD_COMMAND_BY_ID, NOTEPAD_COMMAND_CATALOG } from "./catalog";
import type { ShortcutConflict } from "./types";

export const KEYMAP_STORAGE_KEY = "taomni.notepad.keymap.v1";

export function detectMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
}

export function normalizeShortcut(raw: string, isMac = detectMacPlatform()): string {
  const tokens = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length === 0) return "";
  const mods = new Set<string>();
  let key = "";
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "mod") mods.add(isMac ? "Meta" : "Control");
    else if (lower === "ctrl" || lower === "control") mods.add("Control");
    else if (lower === "cmd" || lower === "meta" || lower === "super") mods.add("Meta");
    else if (lower === "alt" || lower === "option") mods.add("Alt");
    else if (lower === "shift") mods.add("Shift");
    else key = normalizeKeyName(token);
  }
  const ordered: string[] = [];
  if (mods.has("Control")) ordered.push("Control");
  if (mods.has("Meta")) ordered.push("Meta");
  if (mods.has("Alt")) ordered.push("Alt");
  if (mods.has("Shift")) ordered.push("Shift");
  if (key) ordered.push(key);
  return ordered.join("+");
}

function normalizeKeyName(token: string): string {
  const lower = token.toLowerCase();
  if (lower === "arrowup" || lower === "up") return "ArrowUp";
  if (lower === "arrowdown" || lower === "down") return "ArrowDown";
  if (lower === "arrowleft" || lower === "left") return "ArrowLeft";
  if (lower === "arrowright" || lower === "right") return "ArrowRight";
  if (lower === "insert" || lower === "ins") return "Insert";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "enter" || lower === "return") return "Enter";
  if (/^f\d{1,2}$/i.test(token)) return token.toUpperCase();
  if (token.length === 1) return token.toUpperCase();
  return token;
}

export function formatShortcutDisplay(shortcut: string, isMac = detectMacPlatform()): string {
  const norm = normalizeShortcut(shortcut, isMac);
  if (!norm) return "";
  if (!isMac) return norm.replace(/Control\+/g, "Ctrl+");
  return norm
    .replace(/Meta\+/g, "⌘")
    .replace(/Control\+/g, "⌃")
    .replace(/Alt\+/g, "⌥")
    .replace(/Shift\+/g, "⇧");
}

export function isImeComposing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229;
}

export function keyboardEventToShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">,
): string {
  if (isImeComposing(event)) return "";
  if (["Control", "Meta", "Alt", "Shift", "Dead", "Process", "Unidentified"].includes(event.key)) {
    return "";
  }
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.metaKey) parts.push("Meta");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(normalizeKeyName(event.key));
  return parts.join("+");
}

export function defaultShortcutFor(commandId: string, isMac = detectMacPlatform()): string {
  const def = NOTEPAD_COMMAND_BY_ID.get(commandId);
  if (!def) return "";
  const raw = (isMac && def.macosShortcut) || def.defaultShortcut || "";
  return raw ? normalizeShortcut(raw, isMac) : "";
}

function loadOverrides(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEYMAP_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function saveOverrides(overrides: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // ignore
  }
}

export function computeEffectiveBindings(
  overrides: Record<string, string>,
  isMac = detectMacPlatform(),
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const cmd of NOTEPAD_COMMAND_CATALOG) {
    if (Object.prototype.hasOwnProperty.call(overrides, cmd.id)) {
      result[cmd.id] = overrides[cmd.id] ? normalizeShortcut(overrides[cmd.id], isMac) : "";
    } else {
      result[cmd.id] = defaultShortcutFor(cmd.id, isMac);
    }
  }
  return result;
}

export function detectConflicts(
  overrides: Record<string, string>,
  isMac = detectMacPlatform(),
): ShortcutConflict[] {
  const bindings = computeEffectiveBindings(overrides, isMac);
  const byShortcut = new Map<string, string[]>();
  for (const [commandId, shortcut] of Object.entries(bindings)) {
    if (!shortcut) continue;
    const list = byShortcut.get(shortcut) ?? [];
    list.push(commandId);
    byShortcut.set(shortcut, list);
  }
  const conflicts: ShortcutConflict[] = [];
  for (const [shortcut, commandIds] of byShortcut.entries()) {
    if (commandIds.length > 1) {
      conflicts.push({ shortcut, commandIds });
    }
  }
  return conflicts;
}

export interface NotepadKeymapState {
  overrides: Record<string, string>;
  setBinding: (commandId: string, shortcut: string) => void;
  clearBinding: (commandId: string) => void;
  resetBinding: (commandId: string) => void;
  resetAll: () => void;
  resolveShortcut: (commandId: string, isMac?: boolean) => string;
  findCommandByEvent: (
    event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">,
    isMac?: boolean,
  ) => string | null;
  getConflicts: (isMac?: boolean) => ShortcutConflict[];
}

export const useNotepadKeymap = create<NotepadKeymapState>((set, get) => ({
  overrides: loadOverrides(),

  setBinding: (commandId, shortcut) => {
    if (!NOTEPAD_COMMAND_BY_ID.has(commandId)) return;
    const normalized = normalizeShortcut(shortcut);
    set((state) => {
      const next = { ...state.overrides, [commandId]: normalized };
      saveOverrides(next);
      return { overrides: next };
    });
  },

  clearBinding: (commandId) => {
    set((state) => {
      const next = { ...state.overrides, [commandId]: "" };
      saveOverrides(next);
      return { overrides: next };
    });
  },

  resetBinding: (commandId) => {
    set((state) => {
      const next = { ...state.overrides };
      delete next[commandId];
      saveOverrides(next);
      return { overrides: next };
    });
  },

  resetAll: () => {
    saveOverrides({});
    set({ overrides: {} });
  },

  resolveShortcut: (commandId, isMac = detectMacPlatform()) => {
    const { overrides } = get();
    if (Object.prototype.hasOwnProperty.call(overrides, commandId)) {
      return overrides[commandId] ? normalizeShortcut(overrides[commandId], isMac) : "";
    }
    return defaultShortcutFor(commandId, isMac);
  },

  findCommandByEvent: (event, isMac = detectMacPlatform()) => {
    const pressed = keyboardEventToShortcut(event);
    if (!pressed) return null;
    const bindings = computeEffectiveBindings(get().overrides, isMac);
    for (const [commandId, shortcut] of Object.entries(bindings)) {
      if (shortcut === pressed) return commandId;
    }
    // Accept the layout-specific plus sign as an alias for the default '='
    // binding. Explicit bindings above, including an unbound zoom, take priority.
    if (contentZoomShortcut(event, isMac) === "in" && event.key === "+"
      && bindings["view.zoomIn"] === defaultShortcutFor("view.zoomIn", isMac)) return "view.zoomIn";
    return null;
  },

  getConflicts: (isMac = detectMacPlatform()) => detectConflicts(get().overrides, isMac),
}));
