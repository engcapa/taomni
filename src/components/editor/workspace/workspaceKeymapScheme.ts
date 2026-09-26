/**
 * Editable workspace Keymap scheme model (§8.18.2 P0-C1).
 *
 * A `KeymapSchemeV3` is the single user-visible source of shortcut bindings:
 * it records a base platform layout plus the user's delta (bindings and
 * disabled action ids), so upgrading the built-in defaults only replays the
 * delta. Matching is physical-key based (`KeyboardEvent.code`) with explicit
 * AltGr/dead-key/IME normalization so non-US layouts resolve identically.
 */

export type KeymapBaseSchemeId = "idea-windows-linux" | "idea-macos";

/** Physical stroke: KeyboardEvent.code identity plus modifier state. */
export interface ShortcutStroke {
  code: string;
  /** Display/diagnostic only; never used for matching. */
  key?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export type Shortcut =
  | { kind: "keyboard"; strokes: readonly [ShortcutStroke] | readonly [ShortcutStroke, ShortcutStroke] }
  | { kind: "mouse"; button: number; clickCount: 1 | 2; modifiers: Omit<ShortcutStroke, "code" | "key"> };

export interface KeymapSchemeV3 {
  schemaVersion: 3;
  id: string;
  name: string;
  base: KeymapBaseSchemeId | null;
  readOnly: boolean;
  /** actionId -> shortcuts (user delta over the base scheme). */
  bindings: Record<string, readonly Shortcut[]>;
  disabledActionIds: readonly string[];
  updatedAt: number;
}

export const KEYMAP_SCHEME_STORAGE_PREFIX = "taomni.codeWorkspace.keymap.v3";
/** Per app profile, not per workspace path (§8.18.2 persistence). */
export const KEYMAP_SCHEMES_INDEX_KEY = `${KEYMAP_SCHEME_STORAGE_PREFIX}:index`;
export const KEYMAP_ACTIVE_SCHEME_KEY = `${KEYMAP_SCHEME_STORAGE_PREFIX}:active`;

/** OS-reserved / browser-reserved strokes that cannot be bound cleanly. */
const RESERVED_STROKE_CODES = new Set([
  "F5", // reload
  "F11", // fullscreen
  "F12", // devtools
  "Tab",
  "Space",
]);

export function strokeFromKeyboardEvent(event: {
  code: string;
  key?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): ShortcutStroke {
  return {
    code: event.code,
    ...(event.key !== undefined ? { key: event.key } : {}),
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

/**
 * Normalize platform quirks before matching (§8.18.2 裁决):
 * - AltGr reports as ctrl+alt on Windows/Linux; keep both modifiers so the
 *   physical code still matches across layouts.
 * - Dead keys and IME composition surface as `key === "Dead"` or
 *   `isComposing`; callers must not dispatch during composition — matching
 *   here stays purely on `code`.
 */
export function normalizeStrokeForMatch(stroke: ShortcutStroke): ShortcutStroke {
  return { ...stroke, key: undefined };
}

function modifiersEqual(a: Omit<ShortcutStroke, "code" | "key">, b: Omit<ShortcutStroke, "code" | "key">): boolean {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;
}

export function strokesEqual(a: ShortcutStroke, b: ShortcutStroke): boolean {
  return a.code === b.code && modifiersEqual(a, b);
}

export function shortcutsEqual(a: Shortcut, b: Shortcut): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "mouse" && b.kind === "mouse") {
    return a.button === b.button
      && a.clickCount === b.clickCount
      && modifiersEqual(a.modifiers as Omit<ShortcutStroke, "code" | "key">, b.modifiers as Omit<ShortcutStroke, "code" | "key">);
  }
  if (a.kind !== "keyboard" || b.kind !== "keyboard") return false;
  const left = a.strokes.map(normalizeStrokeForMatch);
  const right = b.strokes.map(normalizeStrokeForMatch);
  return left.length === right.length && left.every((stroke, i) => strokesEqual(stroke, right[i]));
}

/** Human-readable label, e.g. Ctrl+Shift+F / ⌘⇧F. */
export function formatShortcut(shortcut: Shortcut, platform: "mac" | "pc" = "pc"): string {
  const modOrder = (s: ShortcutStroke) => [
    s.ctrl && (platform === "mac" ? "Ctrl" : "Ctrl"),
    s.alt && (platform === "mac" ? "Option" : "Alt"),
    s.shift && "Shift",
    s.meta && (platform === "mac" ? "Cmd" : "Meta"),
  ].filter(Boolean) as string[];
  if (shortcut.kind === "mouse") {
    const mods = modOrder({ ...(shortcut.modifiers), code: "", } as ShortcutStroke);
    return [...mods, `Mouse${shortcut.button}${shortcut.clickCount > 1 ? `×${shortcut.clickCount}` : ""}`].join("+");
  }
  const parts = shortcut.strokes.map((stroke) => [...modOrder(stroke), stroke.key?.toUpperCase() ?? stroke.code].join("+"));
  return parts.join(" ");
}

/**
 * True when this first keyboard stroke could still grow into a registered
 * chord (a second stroke pending).
 */
export function strokeStartsRegisteredChord(
  stroke: ShortcutStroke,
  shortcuts: readonly Shortcut[],
): boolean {
  return shortcuts.some((shortcut) =>
    shortcut.kind === "keyboard"
    && shortcut.strokes.length === 2
    && strokesEqual(normalizeStrokeForMatch(stroke), normalizeStrokeForMatch(shortcut.strokes[0])));
}

export function isReservedStroke(stroke: ShortcutStroke): boolean {
  const bare = !stroke.ctrl && !stroke.alt && !stroke.shift && !stroke.meta;
  return RESERVED_STROKE_CODES.has(stroke.code) && bare;
}

// ---------------------------------------------------------------------------
// Conflict identity + displacement (ED-PARITY-004 DEC-06 / DEC-04)
// ---------------------------------------------------------------------------

/**
 * Canonical physical identity of one stroke: `code` plus the modifier bits,
 * with the display-only `key` dropped. This is deliberately the SAME identity
 * `strokesEqual` matches on, so a definition-derived `Ctrl+F` and a
 * user-recorded `Ctrl+f` converge instead of forking the conflict graph (D1).
 */
export function strokeIdentity(stroke: ShortcutStroke): string {
  const mods = [
    stroke.ctrl && "ctrl",
    stroke.alt && "alt",
    stroke.shift && "shift",
    stroke.meta && "meta",
  ].filter(Boolean).join("+");
  return mods ? `${mods}+${stroke.code}` : stroke.code;
}

/** Physical identity of a whole shortcut (two-stroke chords stay ordered). */
export function shortcutIdentity(shortcut: Shortcut): string {
  if (shortcut.kind === "mouse") {
    const mods = [
      shortcut.modifiers.ctrl && "ctrl",
      shortcut.modifiers.alt && "alt",
      shortcut.modifiers.shift && "shift",
      shortcut.modifiers.meta && "meta",
    ].filter(Boolean).join("+");
    const base = `mouse:${shortcut.button}x${shortcut.clickCount}`;
    return mods ? `${base}+${mods}` : base;
  }
  return shortcut.strokes.map(strokeIdentity).join(" ");
}

/** Where a resolved shortcut set came from, mirroring the host vocabulary. */
export type KeymapBindingSource = "user" | "base";

export interface StrokeConflictEntry {
  actionId: string;
  /** Where the holding binding came from. */
  source: KeymapBindingSource;
}

/**
 * Effective bindings for one action: the scheme delta wins whenever the entry
 * is PRESENT — including an explicit empty array, which means "this action has
 * no shortcuts" and must not fall back to the base default (DEC-04).
 */
export function effectiveSchemeBindings(
  scheme: KeymapSchemeV3 | null,
  baseBindings: ReadonlyMap<string, readonly Shortcut[]>,
  actionId: string,
): { shortcuts: readonly Shortcut[]; source: KeymapBindingSource } {
  const delta = scheme?.bindings[actionId];
  if (delta) return { shortcuts: delta, source: "user" };
  return { shortcuts: baseBindings.get(actionId) ?? [], source: "base" };
}

/**
 * Every action whose EFFECTIVE bindings already contain `candidate`, keyed by
 * the physical identity dispatch uses. `baseBindings` must cover every action
 * the caller knows about; entries the scheme overrides resolve through the
 * delta, the rest through the built-in defaults.
 *
 * User-disabled actions are excluded by default: they cannot execute, so they
 * are not a routing conflict — the same availability rule `prepareBinding`
 * applies when it refuses to pick a winner.
 */
export function findStrokeConflicts(
  scheme: KeymapSchemeV3 | null,
  baseBindings: ReadonlyMap<string, readonly Shortcut[]>,
  candidate: Shortcut,
  options: { targetActionId?: string; includeDisabled?: boolean } = {},
): readonly StrokeConflictEntry[] {
  const identity = shortcutIdentity(candidate);
  const disabled = new Set(scheme?.disabledActionIds ?? []);
  const holders: StrokeConflictEntry[] = [];
  for (const actionId of baseBindings.keys()) {
    if (actionId === options.targetActionId) continue;
    if (!options.includeDisabled && disabled.has(actionId)) continue;
    const { shortcuts, source } = effectiveSchemeBindings(scheme, baseBindings, actionId);
    if (shortcuts.some((shortcut) => shortcutIdentity(shortcut) === identity)) {
      holders.push({ actionId, source });
    }
  }
  return holders;
}

/**
 * DEC-04: once the user confirms a colliding chord, the previous holder loses
 * EXACTLY that stroke so the chord has a single owner. Every other binding of
 * the holder is preserved, and a holder left with none receives an explicit
 * empty array so its base default is not resurrected. No-op when the chord is
 * unheld.
 */
export function displaceStroke(
  scheme: KeymapSchemeV3,
  baseBindings: ReadonlyMap<string, readonly Shortcut[]>,
  keepActionId: string,
  candidate: Shortcut,
): KeymapSchemeV3 {
  const identity = shortcutIdentity(candidate);
  const disabled = new Set(scheme.disabledActionIds);
  const bindings: Record<string, readonly Shortcut[]> = { ...scheme.bindings };
  let changed = false;
  for (const actionId of baseBindings.keys()) {
    if (actionId === keepActionId || disabled.has(actionId)) continue;
    const effective = bindings[actionId] ?? baseBindings.get(actionId) ?? [];
    if (!effective.some((shortcut) => shortcutIdentity(shortcut) === identity)) continue;
    bindings[actionId] = effective.filter((shortcut) => shortcutIdentity(shortcut) !== identity);
    changed = true;
  }
  return changed ? { ...scheme, bindings, updatedAt: Date.now() } : scheme;
}

/** Empty user scheme over a platform base. */
export function createKeymapScheme(input: {
  id: string;
  name: string;
  base: KeymapBaseSchemeId;
  now?: number;
}): KeymapSchemeV3 {
  return {
    schemaVersion: 3,
    id: input.id,
    name: input.name,
    base: input.base,
    readOnly: false,
    bindings: {},
    disabledActionIds: [],
    updatedAt: input.now ?? Date.now(),
  };
}

/** Add/remove one binding for an action in a mutable draft. */
export function setActionBindings(
  scheme: KeymapSchemeV3,
  actionId: string,
  shortcuts: readonly Shortcut[],
): KeymapSchemeV3 {
  const next: Record<string, readonly Shortcut[]> = { ...scheme.bindings };
  if (shortcuts.length === 0) delete next[actionId];
  else next[actionId] = shortcuts;
  return { ...scheme, bindings: next, updatedAt: Date.now() };
}

export function setActionDisabled(
  scheme: KeymapSchemeV3,
  actionId: string,
  disabled: boolean,
): KeymapSchemeV3 {
  const set = new Set(scheme.disabledActionIds);
  if (disabled) set.add(actionId);
  else set.delete(actionId);
  return { ...scheme, disabledActionIds: [...set], updatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Persistence (per app profile; corrupted schemes quarantine + fallback)
// ---------------------------------------------------------------------------

interface StoredSchemeBlob {
  schemes?: unknown;
  activeId?: unknown;
}

function sanitizeScheme(value: unknown): KeymapSchemeV3 | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 3) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const bindings: Record<string, readonly Shortcut[]> = {};
  if (raw.bindings && typeof raw.bindings === "object") {
    for (const [actionId, shortcuts] of Object.entries(raw.bindings as Record<string, unknown>)) {
      if (!Array.isArray(shortcuts)) continue;
      // An empty array is meaningful and must survive the round trip: it is the
      // explicit "this action has no shortcuts" override `displaceStroke`
      // writes for the previous holder of a reassigned chord (DEC-04).
      bindings[actionId] = shortcuts.filter((shortcut): shortcut is Shortcut =>
        !!shortcut && typeof shortcut === "object"
        && ((shortcut as Shortcut).kind === "keyboard" || (shortcut as Shortcut).kind === "mouse"));
    }
  }
  return {
    schemaVersion: 3,
    id: raw.id,
    name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
    base: raw.base === "idea-macos" ? "idea-macos" : raw.base === "idea-windows-linux" ? "idea-windows-linux" : null,
    readOnly: raw.readOnly === true,
    bindings,
    disabledActionIds: Array.isArray(raw.disabledActionIds)
      ? raw.disabledActionIds.filter((id): id is string => typeof id === "string")
      : [],
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

export interface KeymapStoreReadResult {
  schemes: KeymapSchemeV3[];
  activeId: string | null;
  /** Set when stored bytes were corrupt and quarantined to a backup key. */
  recoveredFromCorrupt: boolean;
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Persistence must never break editing.
  }
}

export function readKeymapSchemes(): KeymapStoreReadResult {
  if (typeof window === "undefined") {
    return { schemes: [], activeId: null, recoveredFromCorrupt: false };
  }
  let recoveredFromCorrupt = false;
  const schemes: KeymapSchemeV3[] = [];
  const rawIndex = storageGet(KEYMAP_SCHEMES_INDEX_KEY);
  if (rawIndex) {
    try {
      const parsed: unknown = JSON.parse(rawIndex);
      const list = Array.isArray(parsed) ? parsed : (parsed as StoredSchemeBlob)?.schemes;
      if (Array.isArray(list)) {
        for (const value of list) {
          const scheme = sanitizeScheme(value);
          if (scheme) schemes.push(scheme);
          else recoveredFromCorrupt = true;
        }
      } else {
        recoveredFromCorrupt = true;
      }
    } catch {
      // Quarantine the unreadable payload so diagnostics can show it.
      try {
        window.localStorage.setItem(
          `${KEYMAP_SCHEME_STORAGE_PREFIX}:corrupt-backup`,
          rawIndex,
        );
      } catch {
        /* ignore */
      }
      recoveredFromCorrupt = true;
    }
  }
  const activeRaw = storageGet(KEYMAP_ACTIVE_SCHEME_KEY);
  return {
    schemes,
    activeId: typeof activeRaw === "string" && activeRaw ? activeRaw : null,
    recoveredFromCorrupt,
  };
}

export function writeKeymapSchemes(schemes: readonly KeymapSchemeV3[], activeId: string | null): void {
  if (typeof window === "undefined") return;
  storageSet(KEYMAP_SCHEMES_INDEX_KEY, JSON.stringify(schemes));
  if (activeId) storageSet(KEYMAP_ACTIVE_SCHEME_KEY, activeId);
  else storageSet(KEYMAP_ACTIVE_SCHEME_KEY, "");
}
