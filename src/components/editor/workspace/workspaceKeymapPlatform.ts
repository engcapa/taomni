/**
 * Platform-aware keymap resolution and the single shortcut label formatter
 * (ED-PARITY-013 DEC-013-01/02).
 *
 * IDEA's Windows/Linux keymaps ("$default" / "Default for XWin") carry no
 * Meta (Super/Win) bindings, so on those platforms any definition binding that
 * needs Meta is dropped for BOTH display and dispatch. macOS keeps the Ctrl
 * primary bindings plus their Cmd aliases, with the Cmd variants listed first.
 * Every surface that shows a shortcut goes through `formatShortcutLabel` so the
 * Keymap dialog, Search Everywhere, the Cheat Sheet and menus cannot disagree.
 */

import { getLocale } from "../../../lib/i18n";
import type { Shortcut, ShortcutStroke } from "./workspaceKeymapScheme";

export type KeymapPlatform = "windows" | "linux" | "mac";

/** Per-platform replacement binding sets (strings in the catalog syntax). */
export interface PlatformKeybindingOverrides {
  windows?: readonly string[];
  linux?: readonly string[];
  mac?: readonly string[];
}

let platformOverride: KeymapPlatform | null = null;

/** Test hook: pin the detected platform (null restores detection). */
export function setKeymapPlatformOverride(platform: KeymapPlatform | null): void {
  platformOverride = platform;
}

export function detectKeymapPlatform(): KeymapPlatform {
  if (platformOverride) return platformOverride;
  if (typeof navigator === "undefined") return "linux";
  const fingerprint = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (/mac|iphone|ipad/.test(navigator.platform?.toLowerCase() ?? "")) return "mac";
  if (/win/.test(navigator.platform?.toLowerCase() ?? "")) return "windows";
  if (/windows/.test(fingerprint)) return "windows";
  if (/macintosh|mac os x/.test(fingerprint)) return "mac";
  return "linux";
}

export function isMacKeymapPlatform(platform: KeymapPlatform = detectKeymapPlatform()): boolean {
  return platform === "mac";
}

function bindingUsesMeta(binding: string): boolean {
  return binding
    .split(/\s+/)
    .some((stroke) => stroke.split("+").slice(0, -1).some((part) => {
      const mod = part.trim().toLowerCase();
      return mod === "meta" || mod === "cmd";
    }));
}

/**
 * Choose the binding strings that apply on one platform. An explicit override
 * list REPLACES the default set; otherwise Win/Linux drop Meta bindings and
 * macOS keeps everything with Cmd variants first.
 */
export function selectPlatformBindings(
  bindings: readonly string[],
  overrides: PlatformKeybindingOverrides | undefined,
  platform: KeymapPlatform = detectKeymapPlatform(),
): string[] {
  const explicit = overrides?.[platform];
  const source = explicit ? [...explicit] : [...bindings];
  const unique = Array.from(new Set(source.map((binding) => binding.trim()).filter(Boolean)));
  if (platform !== "mac") return unique.filter((binding) => !bindingUsesMeta(binding));
  return [
    ...unique.filter((binding) => bindingUsesMeta(binding)),
    ...unique.filter((binding) => !bindingUsesMeta(binding)),
  ];
}

const ENGLISH_KEY_LABELS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Space: "Space",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
  Tab: "Tab",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  NumpadSubtract: "NumPad -",
  NumpadAdd: "NumPad +",
  NumpadMultiply: "NumPad *",
  NumpadDivide: "NumPad /",
  ContextMenu: "Context Menu",
};

const ZH_CN_KEY_LABELS: Record<string, string> = {
  ArrowLeft: "向左箭头",
  ArrowRight: "向右箭头",
  ArrowUp: "向上箭头",
  ArrowDown: "向下箭头",
};

/** Normalize a stored `code` (or legacy logical key) to a KeyboardEvent.code. */
function canonicalCode(code: string): string {
  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^F\d{1,2}$/.test(code)) return code;
  const lower = code.toLowerCase();
  if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`;
  if (/^[0-9]$/.test(lower)) return `Digit${lower}`;
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  const named: Record<string, string> = {
    arrowleft: "ArrowLeft", left: "ArrowLeft",
    arrowright: "ArrowRight", right: "ArrowRight",
    arrowup: "ArrowUp", up: "ArrowUp",
    arrowdown: "ArrowDown", down: "ArrowDown",
    enter: "Enter", numpadenter: "NumpadEnter",
    escape: "Escape", esc: "Escape",
    space: "Space", " ": "Space",
    backspace: "Backspace", delete: "Delete", insert: "Insert",
    home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", tab: "Tab",
    period: "Period", comma: "Comma", slash: "Slash",
    ",": "Comma", ".": "Period", "/": "Slash", "\\": "Backslash",
    ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight",
    "-": "Minus", "=": "Equal", "`": "Backquote",
  };
  return named[lower] ?? code;
}

/** Display name of one physical key, localized where IDEA localizes it. */
export function keyDisplayLabel(code: string, locale: string = getLocale()): string {
  const canonical = canonicalCode(code);
  if (locale === "zh-CN" && ZH_CN_KEY_LABELS[canonical]) return ZH_CN_KEY_LABELS[canonical];
  if (ENGLISH_KEY_LABELS[canonical]) return ENGLISH_KEY_LABELS[canonical];
  if (/^Key[A-Z]$/.test(canonical)) return canonical.slice(3);
  if (/^Digit[0-9]$/.test(canonical)) return canonical.slice(5);
  if (/^Numpad[0-9]$/.test(canonical)) return `NumPad ${canonical.slice(6)}`;
  return canonical;
}

type ModifierState = Pick<ShortcutStroke, "ctrl" | "alt" | "shift" | "meta">;

/** Ordered modifier labels (IDEA order: Ctrl, Alt, Shift, then Cmd on mac). */
export function modifierLabels(stroke: ModifierState, platform: KeymapPlatform = detectKeymapPlatform()): string[] {
  const mac = platform === "mac";
  return [
    stroke.ctrl && "Ctrl",
    stroke.alt && (mac ? "Option" : "Alt"),
    stroke.shift && "Shift",
    stroke.meta && (mac ? "Cmd" : "Meta"),
  ].filter((label): label is string => !!label);
}

/** Key caps of one stroke, e.g. ["Ctrl", "Shift", "N"]. */
export function strokeKeyCaps(
  stroke: ShortcutStroke,
  platform: KeymapPlatform = detectKeymapPlatform(),
  locale: string = getLocale(),
): string[] {
  return [...modifierLabels(stroke, platform), keyDisplayLabel(stroke.code || stroke.key || "", locale)];
}

/** Key caps per stroke of one shortcut; mouse shortcuts yield one group. */
export function shortcutKeyCaps(
  shortcut: Shortcut,
  platform: KeymapPlatform = detectKeymapPlatform(),
  locale: string = getLocale(),
): string[][] {
  if (shortcut.kind === "mouse") {
    const button = shortcut.button === 0 ? "Click" : shortcut.button === 1 ? "Middle Click" : `Button ${shortcut.button + 1} Click`;
    const clicks = shortcut.clickCount === 2 ? `Double ${button}` : button;
    return [[...modifierLabels(shortcut.modifiers, platform), clicks]];
  }
  return shortcut.strokes.map((stroke) => strokeKeyCaps(stroke, platform, locale));
}

/** The single display label, e.g. `Ctrl+Shift+N`, `Ctrl+K Ctrl+S`, `Ctrl+Click`. */
export function formatShortcutLabel(
  shortcut: Shortcut,
  platform: KeymapPlatform = detectKeymapPlatform(),
  locale: string = getLocale(),
): string {
  return shortcutKeyCaps(shortcut, platform, locale).map((caps) => caps.join("+")).join(" ");
}
