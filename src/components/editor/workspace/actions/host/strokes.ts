import { type ActionResult, type WorkspaceActionDefinition } from "../types";
import { type KeyboardEventLike, eventLogicalKey, parseKeybinding } from "../../workspaceCommands";
import { type Shortcut, type ShortcutStroke, strokeFromKeyboardEvent } from "../../workspaceKeymapScheme";
import { detectKeymapPlatform, selectPlatformBindings, type KeymapPlatform } from "../../workspaceKeymapPlatform";
import { type ActionKeybindingHostPort, type PreparedActionEvaluation } from "./types";

/** Accept KeyboardEventLike whose optional `code` falls back to `key`. */
export function strokeFromEvent(event: Omit<KeyboardEventLike, "preventDefault" | "stopPropagation">): ShortcutStroke {
  // jsdom/fireEvent produce `code: ""` (not undefined) for unspecified codes;
  // map `key` to its physical code fallback so matching against definition strokes succeeds.
  const rawCode = event.code && event.code.length > 0 ? event.code : undefined;
  const code = rawCode ?? (event.key ? logicalKeyToCode(event.key) ?? event.key : "");
  return strokeFromKeyboardEvent({
    code,
    key: event.key,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  });
}

/**
 * True when an `Unidentified` event still carries a physical `code` that maps
 * to a concrete logical key. Linux WebKitGTK emits `key="Unidentified"` for
 * real chords (notably Alt+Enter); treating those as IME composition dropped
 * the action. Genuine composition remains gated by `composing`/`isComposing`/
 * `key === "Process"`.
 */
export function hasPhysicalKeyIdentity(event: KeyboardEventLike): boolean {
  if (!event.code) return false;
  return eventLogicalKey({ key: "Unidentified", code: event.code }) !== "unidentified";
}

/**
 * Matching identity of a stroke: canonical physical code + modifiers, display
 * key dropped. Both definition-derived and event-derived strokes funnel
 * through this so non-US layouts and missing `event.code` resolve alike
 * ("f4"/"F4"/"End"-style inputs converge on one identity).
 */
export function normalize(stroke: ShortcutStroke): ShortcutStroke {
  return { ...stroke, key: undefined, code: logicalKeyToCode(stroke.code) ?? stroke.code };
}

/**
 * Definition binding strings that apply on `platform` (ED-PARITY-013
 * DEC-013-01). A platform-specific `keybinding.{macos,windows,linux}` replaces
 * `keybinding.default`; `platformKeybindings[platform]` replaces the whole set;
 * Windows/Linux never keep Meta (Super/Win) bindings, macOS lists Cmd first.
 */
export function actionKeybindings(
  action: Pick<WorkspaceActionDefinition, "keybinding" | "secondaryKeybindings" | "platformKeybindings">,
  platform: KeymapPlatform = detectKeymapPlatform(),
): string[] {
  const keybinding = action.keybinding;
  const primary = typeof keybinding === "string"
    ? [keybinding]
    : keybinding
      ? [
        (platform === "mac"
          ? keybinding.macos
          : platform === "windows"
            ? keybinding.windows
            : keybinding.linux) ?? keybinding.default,
      ]
      : [];
  return selectPlatformBindings(
    [...primary, ...(action.secondaryKeybindings ?? [])].filter((binding): binding is string => Boolean(binding)),
    action.platformKeybindings,
    platform,
  );
}

/**
 * Parsed default shortcuts per registered definition object. Keyboard
 * dispatch and every rendered shortcut label resolve through here, so the
 * string parsing must not rerun per keystroke or per render.
 */
export const definitionShortcutCache = new WeakMap<
  WorkspaceActionDefinition,
  { platform: KeymapPlatform; shortcuts: readonly Shortcut[]; }
>();

/** Parse an action's built-in default keybinding strings into physical strokes. */
export function parseDefinitionKeybindings(action: WorkspaceActionDefinition): readonly Shortcut[] {
  const platform = detectKeymapPlatform();
  const cached = definitionShortcutCache.get(action);
  if (cached && cached.platform === platform) return cached.shortcuts;
  // Command adapters are recreated whenever the workspace re-registers its
  // commands; their binding strings rarely change, so reuse the parse.
  const signature = definitionBindingSignature(action, platform);
  let shortcuts = definitionShortcutsBySignature.get(signature);
  if (!shortcuts) {
    shortcuts = parseDefinitionKeybindingsUncached(action, platform);
    if (definitionShortcutsBySignature.size >= 4096) definitionShortcutsBySignature.clear();
    definitionShortcutsBySignature.set(signature, shortcuts);
  }
  definitionShortcutCache.set(action, { platform, shortcuts });
  return shortcuts;
}

export const definitionShortcutsBySignature = new Map<string, readonly Shortcut[]>();

export function definitionBindingSignature(action: WorkspaceActionDefinition, platform: KeymapPlatform): string {
  const keybinding = action.keybinding;
  const primary = typeof keybinding === "string"
    ? keybinding
    : keybinding
      ? `${keybinding.default ?? ""}\u0002${keybinding.macos ?? ""}\u0002${keybinding.windows ?? ""}\u0002${keybinding.linux ?? ""}`
      : "";
  const overrides = action.platformKeybindings;
  return [
    platform,
    primary,
    (action.secondaryKeybindings ?? []).join("\u0002"),
    overrides ? `${overrides.windows?.join("\u0002") ?? "-"}\u0003${overrides.linux?.join("\u0002") ?? "-"}\u0003${overrides.mac?.join("\u0002") ?? "-"}` : "",
  ].join("\u0001");
}

export function parseDefinitionKeybindingsUncached(
  action: WorkspaceActionDefinition,
  platform: KeymapPlatform,
): readonly Shortcut[] {
  const out: Shortcut[] = [];
  for (const pattern of actionKeybindings(action, platform)) {
    const parts = pattern.trim().split(/\s+/);
    if (parts.length > 2) continue;
    const strokes: ShortcutStroke[] = [];
    for (const part of parts) {
      const parsed = parseKeybinding(part);
      if (!parsed) break;
      // Keep display identity for the UI while dispatch matches physical keys.
      const code = logicalKeyToCode(parsed.key);
      if (!code) break;
      strokes.push({
        code,
        key: parsed.key.toUpperCase(),
        ctrl: parsed.ctrl,
        alt: parsed.alt,
        shift: parsed.shift,
        meta: parsed.meta,
      });
    }
    if (strokes.length !== parts.length) continue;
    const [first, second] = strokes;
    if (first && strokes.length === 1) {
      out.push({ kind: "keyboard", strokes: [first] });
    } else if (first && second && strokes.length === 2) {
      out.push({ kind: "keyboard", strokes: [first, second] });
    }
  }
  return out;
}

export const LOGICAL_KEY_CODES: Readonly<Record<string, string>> = {
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  enter: "Enter",
  numpadenter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
  // Named spellings used by catalog strings ("Ctrl+Period", "Alt+Insert",
  // "Ctrl+Shift+NumpadSubtract") — previously dropped silently (ED-PARITY-013).
  period: "Period", comma: "Comma", slash: "Slash", backslash: "Backslash",
  minus: "Minus", equal: "Equal", insert: "Insert",
  numpadsubtract: "NumpadSubtract", numpadadd: "NumpadAdd",
  numpadmultiply: "NumpadMultiply", numpaddivide: "NumpadDivide",
  ",": "Comma", ".": "Period", "/": "Slash", "\\": "Backslash",
  ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight",
  "-": "Minus", "=": "Equal", "`": "Backquote",
};

/** Map a normalized logical key to the most common KeyboardEvent.code. */
export function logicalKeyToCode(logicalKey: string): string | null {
  const key = logicalKey.toLowerCase();
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return Object.prototype.hasOwnProperty.call(LOGICAL_KEY_CODES, key) ? LOGICAL_KEY_CODES[key]! : null;
}

/**
 * Exact identity of `strokesEqual` (code + modifiers compared with `===`), so a
 * map keyed by it returns precisely the strokes the linear scan matched.
 */
export function strokeMatchKey(stroke: ShortcutStroke): string {
  return `${stroke.code}\u0000${String(stroke.ctrl)}\u0000${String(stroke.alt)}\u0000${String(stroke.shift)}\u0000${String(stroke.meta)}`;
}

/** Default chord wait window before a pending first stroke expires. */
export const CHORD_TIMEOUT_MS = 1200;

/**
 * Synchronously consume a matched event (preventDefault/stopPropagation) and
 * run the prepared action. Execution is async; the event must be consumed in
 * the same tick the match was decided.
 */
export function executeConsuming(
  host: Pick<ActionKeybindingHostPort, "executePrepared">,
  evaluation: PreparedActionEvaluation,
  event: KeyboardEventLike,
): Promise<ActionResult> {
  event.preventDefault();
  event.stopPropagation();
  return host.executePrepared(evaluation);
}
