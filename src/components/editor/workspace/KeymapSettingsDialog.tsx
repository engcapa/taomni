import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Keyboard, X } from "lucide-react";
import type { ActionSnapshotItem } from "./workspaceActionHost";
import { ShortcutKeyCaps } from "./ShortcutKeyCaps";
import { useFocusReturn } from "./useFocusReturn";
import { formatShortcutLabel } from "./workspaceKeymapPlatform";
import {
  createKeymapScheme,
  deriveEditableScheme,
  displaceStroke,
  effectiveSchemeBindings,
  findStrokeConflicts,
  formatShortcut,
  isReservedStroke,
  setActionBindings,
  setActionDisabled,
  shortcutIdentity,
  strokeFromKeyboardEvent,
  type KeymapBaseSchemeId,
  type KeymapBindingSource,
  type KeymapSchemeV3,
  type Shortcut,
  type ShortcutStroke,
} from "./workspaceKeymapScheme";
import { disabledReasonLabel } from "./workspaceCodeMirrorKeymap";

interface KeymapSettingsDialogProps {
  open: boolean;
  /** Instance-scoped snapshot: rows and their effective state (§8.18.2). */
  snapshot: readonly ActionSnapshotItem[];
  schemes: readonly KeymapSchemeV3[];
  activeSchemeId: string | null;
  defaultSchemeName: string;
  corruptDiagnostic?: string | null;
  onActiveSchemeChange: (schemeId: string | null) => void;
  onSchemesChange: (schemes: readonly KeymapSchemeV3[]) => void;
  /**
   * Persist + apply one scheme mutation to the live host. ED-PARITY-004
   * DEC-03: this fires ONLY from Apply/OK. `null` means "fall back to the
   * built-in defaults" (the user deleted the active scheme).
   */
  onApplyScheme: (scheme: KeymapSchemeV3 | null) => void;
  onClose: () => void;
  /** Read-only built-in schemes (e.g. Taomni Classic) listed after the default. */
  presets?: readonly KeymapSchemeV3[];
  /** Open straight into the recorder for this action (Find Action → Assign Shortcut). */
  assignActionId?: string | null;
  /** DEC-ALIGN-11: where focus goes when the opener no longer exists. */
  restoreFocusFallback?: () => void;
}

type CaptureTarget = { actionId: string; replaceIndex: number | null };
type MouseCaptureTarget = { actionId: string };
type RowMenuState = { actionId: string; x: number; y: number };

/** Group order mirrors IDEA's Keymap tree: editing first, tooling after. */
const GROUP_ORDER = [
  "Edit", "Code", "Navigation", "Navigate", "Search", "Refactor", "Build", "Run",
  "Debug", "Analyze", "View", "Git", "File", "AI", "Preferences", "Help",
];

function groupRank(category: string): number {
  const index = GROUP_ORDER.indexOf(category);
  return index < 0 ? GROUP_ORDER.length : index;
}

function strokeMatches(left: ShortcutStroke, right: ShortcutStroke): boolean {
  return left.code === right.code
    && left.ctrl === right.ctrl
    && left.alt === right.alt
    && left.shift === right.shift
    && left.meta === right.meta;
}

/** Find-by-shortcut predicate: first stroke must match; a second, when given, too. */
function shortcutMatchesFilter(shortcut: Shortcut, filter: readonly ShortcutStroke[]): boolean {
  if (shortcut.kind !== "keyboard" || filter.length === 0) return false;
  if (!strokeMatches(shortcut.strokes[0], filter[0])) return false;
  if (filter.length === 1) return true;
  return shortcut.strokes.length === 2 && strokeMatches(shortcut.strokes[1], filter[1]);
}

interface RowBinding {
  shortcuts: readonly Shortcut[];
  source: KeymapBindingSource;
  /** Every other action whose effective bindings share one of these strokes. */
  conflictsWith: { actionId: string; title: string; source: KeymapBindingSource }[];
}

function toShortcut(strokes: readonly ShortcutStroke[]): Shortcut {
  return {
    kind: "keyboard",
    strokes: strokes.length === 2
      ? ([strokes[0], strokes[1]] as [ShortcutStroke, ShortcutStroke])
      : [strokes[0]],
  };
}

function upsertScheme(
  schemes: readonly KeymapSchemeV3[],
  scheme: KeymapSchemeV3,
): KeymapSchemeV3[] {
  return schemes.some((entry) => entry.id === scheme.id)
    ? schemes.map((entry) => (entry.id === scheme.id ? scheme : entry))
    : [...schemes, scheme];
}

/**
 * IDEA-like Keymap settings surface (§8.18.2, ED-PARITY-004): scheme
 * copy/rename/reset/delete, action search, per-action shortcut swatches with
 * add (keystroke recording) / remove / enable-disable, and an INLINE live
 * conflict warning inside the recorder.
 *
 * ED-PARITY-004 DEC-02..04: conflicts are advisory (never blocking) and are
 * computed on the same physical stroke identity the dispatcher matches on, so
 * `Ctrl+F` (base) and `Ctrl+f` (recorded) are ONE conflict, not two strings.
 * DEC-03: every edit lands in a local draft; Apply/OK is the only edge that
 * touches storage and the live host. The Cheat Sheet stays the read-only
 * projection of the same data.
 */
export function KeymapSettingsDialog({
  open,
  snapshot,
  schemes,
  activeSchemeId,
  defaultSchemeName,
  corruptDiagnostic,
  onActiveSchemeChange,
  onSchemesChange,
  onApplyScheme,
  onClose,
  presets = [],
  assignActionId = null,
  restoreFocusFallback,
}: KeymapSettingsDialogProps) {
  // DEC-ALIGN-11 / DEC-013-10: every close path hands focus back.
  useFocusReturn(open, restoreFocusFallback);
  // ED-PARITY-004 DEC-03: the whole surface edits a draft. Nothing below calls
  // onSchemesChange / onActiveSchemeChange / onApplyScheme until Apply.
  const [draftSchemes, setDraftSchemes] = useState<readonly KeymapSchemeV3[]>(schemes);
  const [draftActiveId, setDraftActiveId] = useState<string | null>(activeSchemeId);
  const [filter, setFilter] = useState(() => (
    assignActionId ? snapshot.find((item) => item.id === assignActionId)?.title ?? "" : ""
  ));
  const [capture, setCapture] = useState<CaptureTarget | null>(
    () => (assignActionId ? { actionId: assignActionId, replaceIndex: null } : null),
  );
  /** §8.19.2: strokes recorded so far (one or two) in the active capture. */
  const [capturedStrokes, setCapturedStrokes] = useState<ShortcutStroke[]>([]);
  /** DEC-013-08: the second stroke is recorded only while this is checked. */
  const [secondStrokeEnabled, setSecondStrokeEnabled] = useState(false);
  const [mouseCapture, setMouseCapture] = useState<MouseCaptureTarget | null>(null);
  const [mouseShortcut, setMouseShortcut] = useState<Shortcut | null>(null);
  const [mouseHint, setMouseHint] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  /** Find Actions by Shortcut (DEC-013-08): null = name filtering. */
  const [shortcutFilter, setShortcutFilter] = useState<ShortcutStroke[] | null>(null);
  const [shortcutFilterSecond, setShortcutFilterSecond] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const captureRef = useRef<CaptureTarget | null>(null);
  captureRef.current = capture;
  const capturedStrokesRef = useRef<ShortcutStroke[]>([]);
  capturedStrokesRef.current = capturedStrokes;
  const secondStrokeEnabledRef = useRef(false);
  secondStrokeEnabledRef.current = secondStrokeEnabled;
  const overlayStateRef = useRef({ mouse: false, menu: false, findField: false });
  overlayStateRef.current.mouse = mouseCapture !== null;
  overlayStateRef.current.menu = rowMenu !== null;
  const recorderFieldRef = useRef<HTMLDivElement | null>(null);
  const shortcutFilterFieldRef = useRef<HTMLDivElement | null>(null);

  // Re-entering the dialog always starts from the committed state.
  useEffect(() => {
    if (!open) return;
    setDraftSchemes(schemes);
    setDraftActiveId(activeSchemeId);
    setCapture(assignActionId ? { actionId: assignActionId, replaceIndex: null } : null);
    setCapturedStrokes([]);
    setSecondStrokeEnabled(false);
    setMouseCapture(null);
    setRowMenu(null);
    setShortcutFilter(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const allSchemes = useMemo(
    () => [...draftSchemes, ...presets.filter((preset) => !draftSchemes.some((scheme) => scheme.id === preset.id))],
    [draftSchemes, presets],
  );
  const draftScheme = useMemo(
    () => allSchemes.find((scheme) => scheme.id === draftActiveId) ?? null,
    [allSchemes, draftActiveId],
  );

  /**
   * Built-in defaults per action, taken from the host snapshot. Displacement
   * and conflict detection both resolve through this map, exactly like
   * `effectiveShortcuts` does on the live side.
   */
  const baseBindings = useMemo(() => {
    const map = new Map<string, readonly Shortcut[]>();
    for (const item of snapshot) map.set(item.id, item.baseShortcuts ?? []);
    return map;
  }, [snapshot]);

  /** Draft-effective binding + conflict list per action, physical identity. */
  const rowBindings = useMemo(() => {
    const byIdentity = new Map<string, { actionId: string; title: string; source: KeymapBindingSource }[]>();
    const resolved = new Map<string, { shortcuts: readonly Shortcut[]; source: KeymapBindingSource }>();
    for (const item of snapshot) {
      const effective = effectiveSchemeBindings(draftScheme, baseBindings, item.id);
      resolved.set(item.id, effective);
      // DEC-06: the row badge is the "is this scheme internally consistent"
      // view, so it uses the SAME availability rule as dispatch and
      // `getBindingDiagnostics`. An action that cannot execute right now (no
      // bookmark, no editor, read-only) is not a routing conflict and must not
      // raise a false ⚠. The recorder warning below is intentionally broader:
      // like IDEA it names every declared holder.
      if (item.state.availability !== "available") continue;
      for (const shortcut of effective.shortcuts) {
        const identity = shortcutIdentity(shortcut);
        const list = byIdentity.get(identity) ?? [];
        list.push({ actionId: item.id, title: item.title, source: effective.source });
        byIdentity.set(identity, list);
      }
    }
    const rows = new Map<string, RowBinding>();
    for (const item of snapshot) {
      const effective = resolved.get(item.id) ?? { shortcuts: [], source: "base" as const };
      const seen = new Set<string>();
      const conflictsWith: RowBinding["conflictsWith"] = [];
      for (const shortcut of effective.shortcuts) {
        for (const holder of byIdentity.get(shortcutIdentity(shortcut)) ?? []) {
          if (holder.actionId === item.id || seen.has(holder.actionId)) continue;
          seen.add(holder.actionId);
          conflictsWith.push(holder);
        }
      }
      rows.set(item.id, { shortcuts: effective.shortcuts, source: effective.source, conflictsWith });
    }
    return rows;
  }, [snapshot, draftScheme, baseBindings]);

  const displayPlatform: "mac" | "pc" = (draftScheme?.base ?? guessBase()) === "idea-macos" ? "mac" : "pc";

  const closeRecorder = () => {
    setCapture(null);
    setCapturedStrokes([]);
    setSecondStrokeEnabled(false);
  };

  // The Keyboard Shortcut dialog's stroke field owns focus while recording.
  useEffect(() => {
    if (capture) recorderFieldRef.current?.focus({ preventScroll: true });
  }, [capture]);

  const applyDraft = (close: boolean) => {
    onSchemesChange(draftSchemes);
    onActiveSchemeChange(draftActiveId);
    onApplyScheme(draftScheme);
    if (close) onClose();
  };

  /**
   * DEC-013-08: the default and built-in schemes are editable in place like
   * IDEA's; the first modification derives "<name> (copy)" carrying the
   * parent's delta, so nothing the user was looking at changes underneath.
   */
  function ensureMutableDraft(): KeymapSchemeV3 | null {
    if (draftScheme && !draftScheme.readOnly) return draftScheme;
    const forked = deriveEditableScheme({
      source: draftScheme,
      defaultName: defaultSchemeName,
      base: (draftScheme?.base ?? guessBase()) as KeymapBaseSchemeId,
      id: `keymap-user-${Date.now().toString(36)}`,
    });
    setDraftSchemes((current) => [...current, forked]);
    setDraftActiveId(forked.id);
    return forked;
  }

  /** Commit one shortcut into the draft for `actionId` (displacing holders). */
  function commitShortcut(actionId: string, replaceIndex: number | null, shortcut: Shortcut): void {
    const scheme = ensureMutableDraft();
    if (!scheme) return;
    // DEC-04: the previous holder loses exactly this stroke, so the chord
    // ends with one owner instead of a dispatch-time dead key.
    const displaced = displaceStroke(scheme, baseBindings, actionId, shortcut);
    const current = [...effectiveSchemeBindings(displaced, baseBindings, actionId).shortcuts];
    const next: readonly Shortcut[] = replaceIndex !== null
      ? current.map((binding, index) => (index === replaceIndex ? shortcut : binding))
      : [...current, shortcut];
    setDraftSchemes((schemesNow) => upsertScheme(schemesNow, setActionBindings(displaced, actionId, next)));
  }

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      const target = captureRef.current;
      const overlays = overlayStateRef.current;
      if (!target) {
        if (event.key !== "Escape") return;
        // Esc peels one layer at a time: row menu → mouse recorder →
        // find-by-shortcut field (owns its Esc) → the dialog itself.
        const eventTarget = event.target instanceof Node ? event.target : null;
        if (overlays.findField || (eventTarget && shortcutFilterFieldRef.current?.contains(eventTarget))) return;
        event.preventDefault();
        event.stopPropagation();
        if (overlays.menu) {
          setRowMenu(null);
          return;
        }
        if (overlays.mouse) {
          setMouseCapture(null);
          return;
        }
        // DEC-03: discarding the draft is the Cancel path — zero writes.
        onClose();
        return;
      }
      // Bare Tab/Space stay navigation keys so the Keyboard Shortcut dialog
      // (Second stroke checkbox, OK, Cancel) is reachable without a mouse.
      const bare = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      if (bare && (event.key === "Tab" || event.key === " ")) return;
      // §8.19.2 keystroke recording: Backspace removes the last stroke, Esc
      // cancels the capture, Enter confirms; modifier-only presses wait.
      event.preventDefault();
      event.stopPropagation();

      // ED-PARITY-004 A3.3: IME composition and AltGr must not be recorded.
      // `key === "Dead"` is a dead-key wait, not a stroke.
      if (event.isComposing || event.key === "Process" || event.key === "Dead") return;
      if (event.getModifierState?.("AltGraph")) return;

      if (event.key === "Escape") {
        closeRecorder();
        return;
      }
      if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;

      if (event.key === "Backspace") {
        setCapturedStrokes((strokes) => strokes.slice(0, -1));
        return;
      }
      if (event.key === "Enter") {
        const strokes = capturedStrokesRef.current;
        if (strokes.length === 0) return;
        commitShortcut(target.actionId, target.replaceIndex, toShortcut(strokes));
        closeRecorder();
        return;
      }

      const stroke = strokeFromKeyboardEvent(event);
      // Reserved strokes cannot be bound at all.
      if (isReservedStroke(stroke)) return;
      // DEC-013-08: without "Second stroke" a new key replaces the first
      // stroke (IDEA's field shows the last keystroke); with it, the next key
      // fills (or replaces) the second stroke.
      setCapturedStrokes((strokes) => {
        if (!secondStrokeEnabledRef.current) return [stroke];
        if (strokes.length === 0) return [stroke];
        return [strokes[0], stroke];
      });
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftSchemes, draftActiveId]);

  /** Live DEC-02 warning for the strokes recorded so far. */
  const captureShortcuts = useMemo(
    () => (capturedStrokes.length > 0 ? toShortcut(capturedStrokes) : null),
    [capturedStrokes],
  );
  // DEC-02: every holder is named with its title AND its id, because Taomni
  // has no menu-path hierarchy to disambiguate with.
  const conflictsFor = (shortcut: Shortcut | null, targetActionId: string | undefined) => {
    if (!shortcut) return [];
    return findStrokeConflicts(draftScheme, baseBindings, shortcut, targetActionId ? { targetActionId } : {})
      .map((holder) => ({
        ...holder,
        title: snapshot.find((item) => item.id === holder.actionId)?.title ?? holder.actionId,
      }));
  };
  const captureConflicts = conflictsFor(captureShortcuts, capture?.actionId);
  const mouseConflicts = conflictsFor(mouseShortcut, mouseCapture?.actionId);

  const dirty = useMemo(
    () => draftActiveId !== activeSchemeId || !sameSchemes(draftSchemes, schemes),
    [draftSchemes, draftActiveId, schemes, activeSchemeId],
  );

  const query = filter.trim().toLowerCase();
  const filteredActions = snapshot.filter((item) => {
    if (shortcutFilter) {
      return shortcutFilter.length > 0
        && (rowBindings.get(item.id)?.shortcuts ?? []).some((shortcut) => shortcutMatchesFilter(shortcut, shortcutFilter));
    }
    return !query
      || item.title.toLowerCase().includes(query)
      || item.id.toLowerCase().includes(query)
      || (item.category ?? "").toLowerCase().includes(query);
  });
  /** DEC-013-08 grouped tree: collapsed by default, expanded while filtering. */
  const searching = !!query || !!shortcutFilter;
  const groups = useMemo(() => {
    const byCategory = new Map<string, ActionSnapshotItem[]>();
    for (const item of filteredActions) {
      const category = item.category || "Other";
      byCategory.set(category, [...(byCategory.get(category) ?? []), item]);
    }
    return Array.from(byCategory.entries())
      .sort(([left], [right]) => groupRank(left) - groupRank(right) || left.localeCompare(right));
  }, [filteredActions]);
  const toggleGroup = (category: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    return next;
  });

  const toggleShortcutFilter = () => {
    if (shortcutFilter) {
      setShortcutFilter(null);
      overlayStateRef.current.findField = false;
      return;
    }
    setShortcutFilter([]);
    setShortcutFilterSecond(false);
    requestAnimationFrame(() => shortcutFilterFieldRef.current?.focus({ preventScroll: true }));
  };

  const removeShortcut = (actionId: string, index: number) => {
    const scheme = ensureMutableDraft();
    if (!scheme) return;
    const current = effectiveSchemeBindings(scheme, baseBindings, actionId).shortcuts;
    // An explicit empty override keeps a now-shortcutless action from
    // resurrecting its base default (DEC-04 semantics).
    const next = current.filter((_, i) => i !== index);
    setDraftSchemes((schemesNow) => upsertScheme(schemesNow, {
      ...scheme,
      bindings: { ...scheme.bindings, [actionId]: next },
      updatedAt: Date.now(),
    }));
  };

  const resetActionShortcuts = (actionId: string) => {
    const scheme = ensureMutableDraft();
    if (!scheme) return;
    setDraftSchemes((schemesNow) => upsertScheme(schemesNow, setActionBindings(scheme, actionId, [])));
  };

  const startKeyboardCapture = (actionId: string, replaceIndex: number | null) => {
    setRowMenu(null);
    setCapturedStrokes([]);
    setSecondStrokeEnabled(false);
    setCapture({ actionId, replaceIndex });
  };

  const startMouseCapture = (actionId: string) => {
    setRowMenu(null);
    setMouseShortcut(null);
    setMouseHint(null);
    setMouseCapture({ actionId });
  };

  /** Find Actions by Shortcut field: records a stroke (or two) as the filter. */
  const handleShortcutFilterKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const native = event.nativeEvent;
    const bare = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    if (native.isComposing || event.key === "Process" || event.key === "Dead") return;
    if (bare && event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (bare && event.key === "Escape") {
      toggleShortcutFilter();
      return;
    }
    if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
    if (bare && event.key === "Backspace") {
      setShortcutFilter((strokes) => (strokes ?? []).slice(0, -1));
      return;
    }
    const stroke = strokeFromKeyboardEvent(native);
    setShortcutFilter((current) => (
      !current || current.length === 0 || !shortcutFilterSecond ? [stroke] : [current[0], stroke]
    ));
  };

  const renderRow = (item: ActionSnapshotItem) => {
    const row = rowBindings.get(item.id);
    const shortcuts = row?.shortcuts ?? [];
    // DEC-03: the row renders the DRAFT, not the live host. Reading
    // `item.state.disabledReason` here would show the pre-Apply value
    // and make the enable/disable checkbox appear inert until Apply.
    const disabled = draftScheme?.disabledActionIds.includes(item.id) ?? false;
    const conflicts = row?.conflictsWith ?? [];
    const capturing = capture?.actionId === item.id;
    return (
      <div
        key={item.id}
        role="treeitem"
        aria-level={2}
        aria-selected={rowMenu?.actionId === item.id}
        data-testid={`keymap-row-${item.id}`}
        className="flex items-center gap-2 border-b border-[var(--taomni-code-border)] py-1.5 pl-5 last:border-b-0"
        onContextMenu={(event) => {
          event.preventDefault();
          setRowMenu({ actionId: item.id, x: event.clientX, y: event.clientY });
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{item.title}</div>
          <div className="truncate text-[11px] opacity-60">
            {item.category} · {item.id}
            {row?.source === "user" ? " · modified" : ""}
            {item.state.availability !== "available" && !disabled
              ? ` · ${disabledReasonLabel(item.state.disabledReason) ?? "Unavailable here"}`
              : ""}
            {disabled ? " · Disabled in Keymap" : ""}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {shortcuts.length === 0 && (
            <span data-testid={`keymap-no-shortcut-${item.id}`} className="text-[11px] opacity-50">no shortcut</span>
          )}
          {shortcuts.map((shortcut, index) => renderChip(item, shortcut, index, conflicts, capturing))}
          <button
            type="button"
            data-testid={`keymap-add-${item.id}`}
            aria-label={capturing ? `Recording shortcut for ${item.title}` : `Add shortcut to ${item.title}`}
            className="inline-flex items-center gap-1 rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[11px] hover:bg-[var(--taomni-code-hover)]"
            onClick={() => startKeyboardCapture(item.id, null)}
          >
            {capturing ? "recording…" : "+ Add"}
          </button>
          <label className="ml-1 flex items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              aria-label={`Action ${item.title} enabled`}
              checked={!disabled}
              onChange={(event) => {
                const scheme = ensureMutableDraft();
                if (!scheme) return;
                setDraftSchemes((schemesNow) => upsertScheme(
                  schemesNow,
                  setActionDisabled(scheme, item.id, !event.target.checked),
                ));
              }}
            />
            on
          </label>
        </div>
      </div>
    );
  };

  function renderChip(
    item: ActionSnapshotItem,
    shortcut: Shortcut,
    index: number,
    conflicts: RowBinding["conflictsWith"],
    capturing: boolean,
  ) {
    const label = formatShortcut(shortcut, displayPlatform);
    return (
      <span
        key={`${item.id}-${label}-${index}`}
        className="inline-flex items-center gap-1 rounded border border-[var(--taomni-code-border)] px-1 py-0.5 text-[11px]"
        title={conflicts.length
          ? `Also used by: ${conflicts.map((entry) => `${entry.title} (${entry.actionId})`).join(", ")}`
          : undefined}
        {...(!capturing
          ? {
              role: "button",
              tabIndex: 0,
              "aria-label": `Replace shortcut ${label} on ${item.title}`,
              "data-testid": `keymap-replace-${item.id}-${index}`,
              onClick: () => startKeyboardCapture(item.id, index),
            }
          : {})}
      >
        <ShortcutKeyCaps shortcut={shortcut} platform={displayPlatform === "mac" ? "mac" : undefined} />
        {conflicts.length ? <span aria-label="conflict" className="text-amber-500">⚠</span> : null}
        <button
          type="button"
          aria-label={`Remove shortcut ${label} from ${item.title}`}
          data-testid={`keymap-remove-${item.id}-${index}`}
          className="opacity-60 hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            removeShortcut(item.id, index);
          }}
        >
          ×
        </button>
      </span>
    );
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        // DEC-03: overlay click is a Cancel path — discards the draft.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace keymap settings"
        data-testid="workspace-keymap-settings-dialog"
        className="relative flex max-h-[80vh] w-[720px] max-w-[calc(100vw-32px)] flex-col rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <span className="font-medium">Keymap</span>
          <select
            aria-label="Keymap scheme"
            data-testid="keymap-scheme-select"
            className="ml-auto rounded border border-[var(--taomni-code-border)] bg-transparent px-1 py-0.5 text-xs"
            value={draftActiveId ?? ""}
            onChange={(event) => setDraftActiveId(event.target.value || null)}
          >
            <option value="">{defaultSchemeName} (default)</option>
            {allSchemes.map((scheme) => (
              <option key={scheme.id} value={scheme.id}>{scheme.name}</option>
            ))}
          </select>
          <button
            type="button"
            data-testid="keymap-scheme-copy"
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-hover)]"
            onClick={() => {
              const source = draftScheme;
              const copy = createKeymapScheme({
                id: `keymap-copy-${Date.now().toString(36)}`,
                name: `${source?.name ?? defaultSchemeName} copy`,
                base: (source?.base ?? guessBase()) as KeymapBaseSchemeId,
              });
              if (source) {
                copy.bindings = { ...source.bindings };
                copy.disabledActionIds = [...source.disabledActionIds];
              }
              setDraftSchemes([...draftSchemes, copy]);
              setDraftActiveId(copy.id);
            }}
          >
            Copy
          </button>
          <button
            type="button"
            data-testid="keymap-scheme-rename"
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
            disabled={!draftScheme || draftScheme.readOnly}
            onClick={() => {
              if (!draftScheme) return;
              const name = window.prompt("Scheme name", draftScheme.name);
              if (!name) return;
              const renamed = { ...draftScheme, name, updatedAt: Date.now() };
              setDraftSchemes(draftSchemes.map((scheme) => (scheme.id === renamed.id ? renamed : scheme)));
            }}
          >
            Rename
          </button>
          <button
            type="button"
            data-testid="keymap-scheme-reset"
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
            disabled={!draftScheme || draftScheme.readOnly}
            onClick={() => {
              if (!draftScheme) return;
              // Reset = restore built-in defaults: drop user delta bindings.
              setDraftSchemes(upsertScheme(draftSchemes, {
                ...draftScheme,
                bindings: {},
                disabledActionIds: [],
                updatedAt: Date.now(),
              }));
            }}
          >
            Reset
          </button>
          <button
            type="button"
            data-testid="keymap-scheme-delete"
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
            disabled={!draftScheme || draftScheme.readOnly}
            onClick={() => {
              if (!draftScheme) return;
              setDraftSchemes(draftSchemes.filter((scheme) => scheme.id !== draftScheme.id));
              setDraftActiveId(null);
            }}
          >
            Delete
          </button>
          <button
            type="button"
            aria-label="Close keymap settings"
            data-testid="keymap-settings-close"
            className="ml-1 rounded p-1 hover:bg-[var(--taomni-code-hover)]"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        {(corruptDiagnostic || draftScheme?.readOnly) && (
          <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-1.5 text-xs text-amber-500" role="status">
            {corruptDiagnostic
              ? "Stored keymap was corrupted; a backup was kept and defaults are active."
              : "Built-in scheme — the first change creates an editable copy."}
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
          {shortcutFilter ? (
            <div
              ref={shortcutFilterFieldRef}
              role="textbox"
              tabIndex={0}
              aria-label="Find actions by shortcut"
              data-testid="keymap-shortcut-filter"
              className="min-w-0 flex-1 rounded border border-[var(--taomni-code-accent,#4b9edd)] px-2 py-1 text-sm outline-none"
              onFocus={() => { overlayStateRef.current.findField = true; }}
              onBlur={() => { overlayStateRef.current.findField = false; }}
              onKeyDown={handleShortcutFilterKeyDown}
            >
              {shortcutFilter.length === 0
                ? <span className="opacity-50">Press a shortcut…</span>
                : <ShortcutKeyCaps shortcut={toShortcut(shortcutFilter)} />}
            </div>
          ) : (
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find actions by name…"
              aria-label="Find actions"
              data-testid="keymap-action-filter"
              className="min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-transparent px-2 py-1 text-sm outline-none focus:border-[var(--taomni-code-accent, #4b9edd)]"
            />
          )}
          {shortcutFilter && (
            <label className="flex shrink-0 items-center gap-1 text-[11px]">
              <input
                type="checkbox"
                data-testid="keymap-shortcut-filter-second"
                checked={shortcutFilterSecond}
                onChange={(event) => setShortcutFilterSecond(event.target.checked)}
              />
              Second stroke
            </label>
          )}
          <button
            type="button"
            aria-pressed={!!shortcutFilter}
            aria-label="Find actions by shortcut"
            title="Find Actions by Shortcut"
            data-testid="keymap-find-by-shortcut"
            className="shrink-0 rounded border border-[var(--taomni-code-border)] p-1 hover:bg-[var(--taomni-code-hover)] aria-pressed:bg-[var(--taomni-code-selection-match-bg)]"
            onClick={() => toggleShortcutFilter()}
          >
            <Keyboard size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" role="tree" aria-label="Keymap actions">
          {groups.map(([category, items]) => {
            const expanded = searching || expandedGroups.has(category);
            return (
              <div key={category} role="group" aria-label={category}>
                <button
                  type="button"
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={expanded}
                  aria-selected={false}
                  data-testid={`keymap-group-${category}`}
                  className="flex w-full items-center gap-1 py-1 text-left text-[12px] font-medium hover:bg-[var(--taomni-code-hover)]"
                  onClick={() => toggleGroup(category)}
                >
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>{category}</span>
                  <span className="ml-1 text-[10px] font-normal opacity-50">{items.length}</span>
                </button>
                {expanded && items.map(renderRow)}
              </div>
            );
          })}
          {filteredActions.length === 0 && (
            <div className="py-6 text-center text-xs opacity-60">
              {shortcutFilter
                ? shortcutFilter.length === 0 ? "Press a shortcut to find its actions." : "No actions use this shortcut."
                : "No matching actions."}
            </div>
          )}
        </div>
        {rowMenu && (() => {
          const item = snapshot.find((entry) => entry.id === rowMenu.actionId);
          const row = rowBindings.get(rowMenu.actionId);
          if (!item) return null;
          const menuItemClass = "block w-full px-3 py-1 text-left hover:bg-[var(--taomni-code-hover)] disabled:opacity-40";
          return (
            <>
              <div className="fixed inset-0 z-20" onMouseDown={() => setRowMenu(null)} />
              <div
                role="menu"
                aria-label={`${item.title} shortcuts`}
                data-testid="keymap-row-menu"
                className="fixed z-30 min-w-[220px] rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] py-1 text-[12px] shadow-lg"
                style={{
                  left: Math.min(rowMenu.x, (typeof window === "undefined" ? 1200 : window.innerWidth) - 240),
                  top: Math.min(rowMenu.y, (typeof window === "undefined" ? 800 : window.innerHeight) - 160),
                }}
              >
                <button type="button" role="menuitem" data-testid="keymap-row-menu-add-keyboard" className={menuItemClass}
                  onClick={() => startKeyboardCapture(item.id, null)}>
                  Add Keyboard Shortcut
                </button>
                <button type="button" role="menuitem" data-testid="keymap-row-menu-add-mouse" className={menuItemClass}
                  onClick={() => startMouseCapture(item.id)}>
                  Add Mouse Shortcut
                </button>
                {(row?.shortcuts ?? []).length > 0 && <div role="separator" className="my-1 border-t border-[var(--taomni-code-border)]" />}
                {(row?.shortcuts ?? []).map((shortcut, index) => (
                  <button key={index} type="button" role="menuitem" data-testid={`keymap-row-menu-remove-${index}`} className={menuItemClass}
                    onClick={() => {
                      setRowMenu(null);
                      removeShortcut(item.id, index);
                    }}>
                    Remove {formatShortcutLabel(shortcut)}
                  </button>
                ))}
                <div role="separator" className="my-1 border-t border-[var(--taomni-code-border)]" />
                <button type="button" role="menuitem" data-testid="keymap-row-menu-reset" className={menuItemClass}
                  disabled={row?.source !== "user"}
                  onClick={() => {
                    setRowMenu(null);
                    resetActionShortcuts(item.id);
                  }}>
                  Reset Shortcuts
                </button>
              </div>
            </>
          );
        })()}
        {mouseCapture && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/20">
            <div role="dialog" aria-modal="true" aria-label="Mouse Shortcut" data-testid="keymap-mouse-recorder"
              className="w-[400px] max-w-[calc(100%-32px)] rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-3 text-[11px] shadow-xl">
              <div className="mb-2 text-[12px] font-medium">
                Mouse Shortcut · {snapshot.find((item) => item.id === mouseCapture.actionId)?.title ?? mouseCapture.actionId}
              </div>
              <div
                data-testid="keymap-mouse-recorder-pad"
                data-mouse-shortcut-capture="true"
                className="flex h-16 select-none items-center justify-center rounded border border-dashed border-[var(--taomni-code-border)]"
                onMouseDown={(event) => {
                  event.preventDefault();
                  const modifiers = { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
                  // DEC-013-09: only left click/double-click with a modifier is dispatchable.
                  if (event.button !== 0) {
                    setMouseHint("Only the left mouse button can be assigned.");
                    return;
                  }
                  if (!modifiers.ctrl && !modifiers.alt && !modifiers.shift && !modifiers.meta) {
                    setMouseHint("Hold Ctrl, Alt or Shift while clicking; a plain click is reserved.");
                    return;
                  }
                  setMouseHint(null);
                  setMouseShortcut({ kind: "mouse", button: 0, clickCount: event.detail >= 2 ? 2 : 1, modifiers });
                }}
              >
                {mouseShortcut
                  ? <span data-testid="keymap-mouse-recorder-value"><ShortcutKeyCaps shortcut={mouseShortcut} /></span>
                  : <span className="opacity-60">Click here with modifier keys</span>}
              </div>
              {mouseHint && <div data-testid="keymap-mouse-recorder-hint" role="alert" className="mt-1.5 text-amber-500">{mouseHint}</div>}
              {mouseConflicts.length > 0 && (
                <div data-testid="keymap-mouse-recorder-conflicts" role="status" className="mt-1.5 text-amber-500">
                  ⚠ Already assigned to: {mouseConflicts.map((holder) => `${holder.title} (${holder.actionId})`).join(", ")}
                </div>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" data-testid="keymap-mouse-recorder-ok" disabled={!mouseShortcut}
                  className="rounded border border-[var(--taomni-code-accent,#4b9edd)] px-3 py-0.5 hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
                  onClick={() => {
                    if (!mouseShortcut) return;
                    commitShortcut(mouseCapture.actionId, null, mouseShortcut);
                    setMouseCapture(null);
                  }}>
                  OK
                </button>
                <button type="button" data-testid="keymap-mouse-recorder-cancel" onClick={() => setMouseCapture(null)}
                  className="rounded border border-[var(--taomni-code-border)] px-3 py-0.5 hover:bg-[var(--taomni-code-hover)]">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/*
          DEC-013-08: IDEA "Keyboard Shortcut" sub-dialog. The conflict warning
          stays ADVISORY (ED-PARITY-004 DEC-02) — OK remains enabled — and
          names EVERY action holding the stroke.
        */}
        {capture && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/20">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Keyboard Shortcut"
              data-testid="keymap-recorder"
              className="w-[440px] max-w-[calc(100%-32px)] rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-3 text-[11px] shadow-xl"
            >
              <div className="mb-2 text-[12px] font-medium">
                Keyboard Shortcut · {snapshot.find((item) => item.id === capture.actionId)?.title ?? capture.actionId}
              </div>
              <div className="mb-1 opacity-70">First stroke</div>
              <div
                ref={recorderFieldRef}
                role="textbox"
                tabIndex={0}
                aria-label="Press shortcut keys"
                aria-readonly="true"
                className="flex min-h-7 items-center gap-2 rounded border border-[var(--taomni-code-accent,#4b9edd)] px-2 py-1 outline-none"
              >
                <span data-testid="keymap-recorder-strokes" className="font-mono">
                  {capturedStrokes.length > 0
                    ? `[${capturedStrokes.map((stroke) => stroke.code).join(", ")}]`
                    : "press keys…"}
                </span>
                {capturedStrokes.length > 0 && <ShortcutKeyCaps shortcut={toShortcut(capturedStrokes)} />}
                <span className="ml-auto opacity-60">
                  {capturedStrokes.length > 0 ? layoutLabel() : "Enter confirms · Esc cancels"}
                </span>
              </div>
              <label className="mt-2 flex items-center gap-1.5">
                <input
                  type="checkbox"
                  data-testid="keymap-recorder-second-stroke"
                  checked={secondStrokeEnabled}
                  onChange={(event) => {
                    setSecondStrokeEnabled(event.target.checked);
                    if (!event.target.checked) setCapturedStrokes((strokes) => strokes.slice(0, 1));
                    recorderFieldRef.current?.focus({ preventScroll: true });
                  }}
                />
                Second stroke
              </label>
              <div
                data-testid="keymap-capture-conflicts"
                className="mt-2 max-h-24 min-h-0 overflow-y-auto rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-500"
                role="status"
                aria-live="polite"
              >
                <div className="flex items-center gap-1 font-medium">
                  <span aria-hidden="true">⚠</span>
                  <span>Already assigned to:</span>
                </div>
                {captureConflicts.length === 0 ? (
                  <div data-testid="keymap-capture-conflict-empty" className="opacity-70">
                    No other action uses this shortcut.
                  </div>
                ) : (
                  <ul className="mt-0.5 list-disc pl-4">
                    {captureConflicts.map((holder) => (
                      <li key={holder.actionId} data-testid={`keymap-capture-conflict-${holder.actionId}`}>
                        {holder.title} <span className="opacity-70">({holder.actionId})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="keymap-recorder-ok"
                  className="rounded border border-[var(--taomni-code-accent,#4b9edd)] px-3 py-0.5 hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
                  disabled={capturedStrokes.length === 0}
                  onClick={() => {
                    if (capturedStrokes.length === 0) return;
                    commitShortcut(capture.actionId, capture.replaceIndex, toShortcut(capturedStrokes));
                    closeRecorder();
                  }}
                >
                  OK
                </button>
                <button
                  type="button"
                  data-testid="keymap-recorder-cancel"
                  className="rounded border border-[var(--taomni-code-border)] px-3 py-0.5 hover:bg-[var(--taomni-code-hover)]"
                  onClick={closeRecorder}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* DEC-03: Apply/OK is the only commit edge; both discard-free closes do nothing. */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
          <button
            type="button"
            data-testid="keymap-settings-ok"
            className="rounded border border-[var(--taomni-code-border)] px-3 py-1 text-xs hover:bg-[var(--taomni-code-hover)]"
            onClick={() => applyDraft(true)}
          >
            OK
          </button>
          <button
            type="button"
            data-testid="keymap-settings-cancel"
            className="rounded border border-[var(--taomni-code-border)] px-3 py-1 text-xs hover:bg-[var(--taomni-code-hover)]"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="keymap-settings-apply"
            className="rounded border border-[var(--taomni-code-accent, #4b9edd)] px-3 py-1 text-xs hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
            disabled={!dirty}
            onClick={() => applyDraft(false)}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/** Draft identity: value equality over the persisted shape, order-sensitive. */
function sameSchemes(
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

function guessBase(): KeymapBaseSchemeId {
  return navigator.platform.toLowerCase().includes("mac") ? "idea-macos" : "idea-windows-linux";
}

/** Honest layout label for the recorder: platform family, not a layout claim. */
function layoutLabel(): string {
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";
  return platform.toLowerCase().includes("mac") ? "layout: mac" : "layout: pc";
}
