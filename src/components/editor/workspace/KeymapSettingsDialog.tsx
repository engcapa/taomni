import { useEffect, useMemo, useRef, useState } from "react";
import { groupRank, guessBase, sameSchemes, shortcutMatchesFilter, toShortcut, upsertScheme } from "./keymapSettings/bindings";
import { KeymapSettingsView } from "./keymapSettings/KeymapSettingsView";
import { type CaptureTarget, type KeymapSettingsDialogProps, type MouseCaptureTarget, type RowBinding, type RowMenuState } from "./keymapSettings/model";
import { useKeymapRecorder } from "./keymapSettings/useKeymapRecorder";
import { ShortcutKeyCaps } from "./ShortcutKeyCaps";
import { useFocusReturn } from "./useFocusReturn";
import type { ActionSnapshotItem } from "./workspaceActionHost";
import { disabledReasonLabel } from "./workspaceCodeMirrorKeymap";
import {
  effectiveSchemeBindings,
  findStrokeConflicts,
  formatShortcut,
  setActionBindings,
  setActionDisabled,
  shortcutIdentity,
  strokeFromKeyboardEvent,
  type KeymapBindingSource,
  type KeymapSchemeV3,
  type Shortcut,
  type ShortcutStroke,
} from "./workspaceKeymapScheme";

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
    const byIdentity = new Map<string, { actionId: string; title: string; source: KeymapBindingSource; }[]>();
    const resolved = new Map<string, { shortcuts: readonly Shortcut[]; source: KeymapBindingSource; }>();
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
  const recorder = useKeymapRecorder({
    setCapture,
    setCapturedStrokes,
    setSecondStrokeEnabled,
    capture,
    recorderFieldRef,
    onSchemesChange,
    draftSchemes,
    onActiveSchemeChange,
    draftActiveId,
    onApplyScheme,
    draftScheme,
    onClose,
    defaultSchemeName,
    setDraftSchemes,
    setDraftActiveId,
    baseBindings,
    open,
    captureRef,
    overlayStateRef,
    shortcutFilterFieldRef,
    setRowMenu,
    setMouseCapture,
    capturedStrokesRef,
    secondStrokeEnabledRef,
  });

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
    const scheme = recorder.ensureMutableDraft();
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
    const scheme = recorder.ensureMutableDraft();
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
                const scheme = recorder.ensureMutableDraft();
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

  return <KeymapSettingsView
    onClose={onClose}
    draftActiveId={draftActiveId}
    setDraftActiveId={setDraftActiveId}
    defaultSchemeName={defaultSchemeName}
    allSchemes={allSchemes}
    draftScheme={draftScheme}
    setDraftSchemes={setDraftSchemes}
    draftSchemes={draftSchemes}
    corruptDiagnostic={corruptDiagnostic}
    shortcutFilter={shortcutFilter}
    shortcutFilterFieldRef={shortcutFilterFieldRef}
    overlayStateRef={overlayStateRef}
    handleShortcutFilterKeyDown={handleShortcutFilterKeyDown}
    filter={filter}
    setFilter={setFilter}
    shortcutFilterSecond={shortcutFilterSecond}
    setShortcutFilterSecond={setShortcutFilterSecond}
    toggleShortcutFilter={toggleShortcutFilter}
    groups={groups}
    searching={searching}
    expandedGroups={expandedGroups}
    toggleGroup={toggleGroup}
    renderRow={renderRow}
    filteredActions={filteredActions}
    rowMenu={rowMenu}
    snapshot={snapshot}
    rowBindings={rowBindings}
    setRowMenu={setRowMenu}
    startKeyboardCapture={startKeyboardCapture}
    startMouseCapture={startMouseCapture}
    removeShortcut={removeShortcut}
    resetActionShortcuts={resetActionShortcuts}
    mouseCapture={mouseCapture}
    setMouseHint={setMouseHint}
    setMouseShortcut={setMouseShortcut}
    mouseShortcut={mouseShortcut}
    mouseHint={mouseHint}
    mouseConflicts={mouseConflicts}
    recorder={recorder}
    setMouseCapture={setMouseCapture}
    capture={capture}
    recorderFieldRef={recorderFieldRef}
    capturedStrokes={capturedStrokes}
    secondStrokeEnabled={secondStrokeEnabled}
    setSecondStrokeEnabled={setSecondStrokeEnabled}
    setCapturedStrokes={setCapturedStrokes}
    captureConflicts={captureConflicts}
    dirty={dirty}
  />;
}
