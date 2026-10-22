import { type KeymapBaseSchemeId, type KeymapSchemeV3, type Shortcut, type ShortcutStroke } from "../workspaceKeymapScheme";

/** Group order mirrors IDEA's Keymap tree: editing first, tooling after. */
export const GROUP_ORDER = [
  "Edit", "Code", "Navigation", "Navigate", "Search", "Refactor", "Build", "Run",
  "Debug", "Analyze", "View", "Git", "File", "AI", "Preferences", "Help",
];

export function groupRank(category: string): number {
  const index = GROUP_ORDER.indexOf(category);
  return index < 0 ? GROUP_ORDER.length : index;
}

export function strokeMatches(left: ShortcutStroke, right: ShortcutStroke): boolean {
  return left.code === right.code
    && left.ctrl === right.ctrl
    && left.alt === right.alt
    && left.shift === right.shift
    && left.meta === right.meta;
}

/** Find-by-shortcut predicate: first stroke must match; a second, when given, too. */
export function shortcutMatchesFilter(shortcut: Shortcut, filter: readonly ShortcutStroke[]): boolean {
  if (shortcut.kind !== "keyboard" || filter.length === 0) return false;
  if (!strokeMatches(shortcut.strokes[0], filter[0])) return false;
  if (filter.length === 1) return true;
  return shortcut.strokes.length === 2 && strokeMatches(shortcut.strokes[1], filter[1]);
}

export function toShortcut(strokes: readonly ShortcutStroke[]): Shortcut {
  return {
    kind: "keyboard",
    strokes: strokes.length === 2
      ? ([strokes[0], strokes[1]] as [ShortcutStroke, ShortcutStroke])
      : [strokes[0]],
  };
}

export function upsertScheme(
  schemes: readonly KeymapSchemeV3[],
  scheme: KeymapSchemeV3,
): KeymapSchemeV3[] {
  return schemes.some((entry) => entry.id === scheme.id)
    ? schemes.map((entry) => (entry.id === scheme.id ? scheme : entry))
    : [...schemes, scheme];
}

/** Draft identity: value equality over the persisted shape, order-sensitive. */
export function sameSchemes(
  a: readonly KeymapSchemeV3[],
  b: readonly KeymapSchemeV3[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return right
      && left.id === right.id
      && left.name === right.name
      && left.base === right.base
      && left.readOnly === right.readOnly
      && left.updatedAt === right.updatedAt
      && JSON.stringify(left.bindings) === JSON.stringify(right.bindings)
      && JSON.stringify(left.disabledActionIds) === JSON.stringify(right.disabledActionIds);
  });
}

export function guessBase(): KeymapBaseSchemeId {
  return navigator.platform.toLowerCase().includes("mac") ? "idea-macos" : "idea-windows-linux";
}

/** Honest layout label for the recorder: platform family, not a layout claim. */
export function layoutLabel(): string {
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";
  return platform.toLowerCase().includes("mac") ? "layout: mac" : "layout: pc";
}
