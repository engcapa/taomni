import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ActionSnapshotItem } from "./workspaceActionHost";
import {
  createKeymapScheme,
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
}

type CaptureTarget = { actionId: string; replaceIndex: number | null };

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
}: KeymapSettingsDialogProps) {
  // ED-PARITY-004 DEC-03: the whole surface edits a draft. Nothing below calls
  // onSchemesChange / onActiveSchemeChange / onApplyScheme until Apply.
  const [draftSchemes, setDraftSchemes] = useState<readonly KeymapSchemeV3[]>(schemes);
  const [draftActiveId, setDraftActiveId] = useState<string | null>(activeSchemeId);
  const [filter, setFilter] = useState("");
  const [capture, setCapture] = useState<CaptureTarget | null>(null);
  /** §8.19.2: strokes recorded so far (one or two) in the active capture. */
  const [capturedStrokes, setCapturedStrokes] = useState<ShortcutStroke[]>([]);
  const captureRef = useRef<CaptureTarget | null>(null);
  captureRef.current = capture;
  const capturedStrokesRef = useRef<ShortcutStroke[]>([]);
  capturedStrokesRef.current = capturedStrokes;

  // Re-entering the dialog always starts from the committed state.
  useEffect(() => {
    if (!open) return;
    setDraftSchemes(schemes);
    setDraftActiveId(activeSchemeId);
    setCapture(null);
    setCapturedStrokes([]);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const draftScheme = useMemo(
    () => draftSchemes.find((scheme) => scheme.id === draftActiveId) ?? null,
    [draftSchemes, draftActiveId],
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
  };

  const applyDraft = (close: boolean) => {
    onSchemesChange(draftSchemes);
    onActiveSchemeChange(draftActiveId);
    onApplyScheme(draftScheme);
    if (close) onClose();
  };

  /** Implicitly fork a user scheme from the defaults on first draft edit. */
  function ensureMutableDraft(): KeymapSchemeV3 | null {
    if (draftScheme && !draftScheme.readOnly) return draftScheme;
    const forked = createKeymapScheme({
      id: `keymap-user-${Date.now().toString(36)}`,
      name: `${draftScheme?.name ?? defaultSchemeName} (copy)`,
      base: (draftScheme?.base ?? guessBase()) as KeymapBaseSchemeId,
    });
    setDraftSchemes((current) => [...current, forked]);
    setDraftActiveId(forked.id);
    return forked;
  }

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      const target = captureRef.current;
      if (!target) {
        if (event.key === "Escape") {
          // DEC-03: discarding the draft is the Cancel path — zero writes.
          event.preventDefault();
          onClose();
        }
        return;
      }
      // §8.19.2 keystroke recording: a full one- or two-stroke sequence.
      // Backspace removes the last stroke, Esc cancels the capture, Enter
      // confirms; modifier-only presses wait for the stroked key.
      event.preventDefault();
      event.stopPropagation();

      // ED-PARITY-004 A3.3: IME composition and AltGr must not be recorded.
      // `key === "Dead"` is a dead-key wait, not a stroke.
      if (event.isComposing || event.key === "Process" || event.key === "Dead") return;
      if (event.getModifierState?.("AltGraph")) return;

      const commitStrokes = (strokes: readonly ShortcutStroke[]) => {
        if (strokes.length === 0) return;
        const shortcut = toShortcut(strokes);
        const scheme = ensureMutableDraft();
        if (!scheme) return;
        // DEC-04: the previous holder loses exactly this stroke, so the chord
        // ends with one owner instead of a dispatch-time dead key.
        const displaced = displaceStroke(scheme, baseBindings, target.actionId, shortcut);
        const current = [...(displaced.bindings[target.actionId] ?? [])];
        const next: readonly Shortcut[] = target.replaceIndex !== null
          ? current.map((binding, index) => (index === target.replaceIndex ? shortcut : binding))
          : [...current, shortcut];
        setDraftSchemes((schemesNow) => upsertScheme(schemesNow, setActionBindings(displaced, target.actionId, next)));
        closeRecorder();
      };

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
        commitStrokes(capturedStrokesRef.current);
        return;
      }

      const stroke = strokeFromKeyboardEvent(event);
      // Reserved strokes cannot be bound at all.
      if (isReservedStroke(stroke)) return;
      setCapturedStrokes((strokes) => (strokes.length >= 2 ? strokes : [...strokes, stroke]));
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
  const captureConflicts = useMemo(() => {
    if (!captureShortcuts) return [];
    const holders = findStrokeConflicts(draftScheme, baseBindings, captureShortcuts, {
      ...(capture ? { targetActionId: capture.actionId } : {}),
    });
    // DEC-02: every holder is named with its title AND its id, because Taomni
    // has no menu-path hierarchy to disambiguate with.
    return holders.map((holder) => ({
      ...holder,
      title: snapshot.find((item) => item.id === holder.actionId)?.title ?? holder.actionId,
    }));
  }, [captureShortcuts, draftScheme, baseBindings, capture, snapshot]);

  const dirty = useMemo(
    () => draftActiveId !== activeSchemeId || !sameSchemes(draftSchemes, schemes),
    [draftSchemes, draftActiveId, schemes, activeSchemeId],
  );

  const filteredActions = snapshot.filter((item) =>
    !filter.trim()
    || item.title.toLowerCase().includes(filter.trim().toLowerCase())
    || item.id.toLowerCase().includes(filter.trim().toLowerCase())
    || (item.category ?? "").toLowerCase().includes(filter.trim().toLowerCase()));

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
        className="flex max-h-[80vh] w-[720px] max-w-[calc(100vw-32px)] flex-col rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-xl"
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
            {draftSchemes.map((scheme) => (
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
            disabled={!draftScheme}
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
              : "This scheme is read-only."}
          </div>
        )}

        <div className="shrink-0 px-3 pt-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find actions by name…"
            aria-label="Find actions"
            data-testid="keymap-action-filter"
            className="w-full rounded border border-[var(--taomni-code-border)] bg-transparent px-2 py-1 text-sm outline-none focus:border-[var(--taomni-code-accent, #4b9edd)]"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" role="list" aria-label="Keymap actions">
          {filteredActions.map((item) => {
            const row = rowBindings.get(item.id);
            const shortcuts = row?.shortcuts ?? [];
            // DEC-03: the row renders the DRAFT, not the live host. Reading
            // `item.state.disabledReason` here would show the pre-Apply value
            // and make the enable/disable checkbox appear inert until Apply.
            const disabled = draftScheme?.disabledActionIds.includes(item.id) ?? false;
            const conflicts = row?.conflictsWith ?? [];
            const mutable = !!draftScheme && !draftScheme.readOnly;
            const capturing = capture?.actionId === item.id;
            return (
              <div
                key={item.id}
                role="listitem"
                data-testid={`keymap-row-${item.id}`}
                className="flex items-center gap-2 border-b border-[var(--taomni-code-border)] py-1.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{item.title}</div>
                  <div className="truncate text-[11px] opacity-60">
                    {item.category} · {item.id}
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
                  {shortcuts.map((shortcut, index) => {
                    const label = formatShortcut(shortcut, displayPlatform);
                    return (
                      <span
                        key={`${item.id}-${label}-${index}`}
                        className="inline-flex items-center gap-1 rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 font-mono text-[11px]"
                        title={conflicts.length
                          ? `Also used by: ${conflicts.map((entry) => `${entry.title} (${entry.actionId})`).join(", ")}`
                          : undefined}
                        {...(mutable && !capturing
                          ? {
                              role: "button",
                              tabIndex: 0,
                              "aria-label": `Replace shortcut ${label} on ${item.title}`,
                              "data-testid": `keymap-replace-${item.id}-${index}`,
                              onClick: () => {
                                setCapturedStrokes([]);
                                setCapture({ actionId: item.id, replaceIndex: index });
                              },
                            }
                          : {})}
                      >
                        {label}
                        {conflicts.length ? (
                          <span aria-label="conflict" className="text-amber-500">⚠</span>
                        ) : null}
                        {mutable && (
                          <button
                            type="button"
                            aria-label={`Remove shortcut ${label} from ${item.title}`}
                            data-testid={`keymap-remove-${item.id}-${index}`}
                            className="opacity-60 hover:opacity-100"
                            onClick={() => {
                              const scheme = ensureMutableDraft();
                              if (!scheme) return;
                              const next = shortcuts.filter((_, i) => i !== index);
                              setDraftSchemes((schemesNow) => upsertScheme(
                                schemesNow,
                                setActionBindings(scheme, item.id, next),
                              ));
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {mutable && (
                    <button
                      type="button"
                      data-testid={`keymap-add-${item.id}`}
                      aria-label={capturing ? `Recording shortcut for ${item.title}` : `Add shortcut to ${item.title}`}
                      className="inline-flex items-center gap-1 rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[11px] hover:bg-[var(--taomni-code-hover)]"
                      onClick={() => {
                        setCapturedStrokes([]);
                        setCapture({ actionId: item.id, replaceIndex: null });
                      }}
                    >
                      {capturing ? "recording…" : "+ Add"}
                    </button>
                  )}
                  <label className="ml-1 flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      aria-label={`Action ${item.title} enabled`}
                      checked={!disabled}
                      disabled={!mutable}
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
          })}
          {filteredActions.length === 0 && (
            <div className="py-6 text-center text-xs opacity-60">No matching actions.</div>
          )}
        </div>

        {/*
          ED-PARITY-004 DEC-02: the recorder is inline and always present while
          recording (never a separate modal). The warning is ADVISORY — the OK
          button stays enabled — and lists EVERY action holding the stroke.
        */}
        {capture && (
          <div
            data-testid="keymap-recorder"
            className="shrink-0 border-t border-[var(--taomni-code-border)] px-3 py-2"
          >
            <div className="flex items-center gap-2 text-[11px]">
              <span data-testid="keymap-recorder-strokes" className="font-mono">
                {capturedStrokes.length > 0
                  ? `[${capturedStrokes.map((stroke) => stroke.code).join(", ")}]`
                  : "press keys…"}
              </span>
              <span className="opacity-60">
                {capturedStrokes.length > 0
                  ? `${capturedStrokes.map((stroke) => formatShortcut(toShortcut([stroke]), displayPlatform)).join(" ")} · ${layoutLabel()}`
                  : "1–2 keys · Enter confirms · Esc cancels"}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  data-testid="keymap-recorder-ok"
                  className="rounded border border-[var(--taomni-code-border)] px-2 py-0.5 hover:bg-[var(--taomni-code-hover)]"
                  onClick={() => {
                    if (capturedStrokes.length === 0) return;
                    const target = capture;
                    const shortcut = toShortcut(capturedStrokes);
                    const scheme = ensureMutableDraft();
                    if (!scheme) return;
                    const displaced = displaceStroke(scheme, baseBindings, target.actionId, shortcut);
                    const current = [...(displaced.bindings[target.actionId] ?? [])];
                    const next: readonly Shortcut[] = target.replaceIndex !== null
                      ? current.map((binding, index) => (index === target.replaceIndex ? shortcut : binding))
                      : [...current, shortcut];
                    setDraftSchemes((schemesNow) => upsertScheme(
                      schemesNow,
                      setActionBindings(displaced, target.actionId, next),
                    ));
                    closeRecorder();
                  }}
                >
                  OK
                </button>
                <button
                  type="button"
                  data-testid="keymap-recorder-cancel"
                  className="rounded border border-[var(--taomni-code-border)] px-2 py-0.5 hover:bg-[var(--taomni-code-hover)]"
                  onClick={closeRecorder}
                >
                  Cancel
                </button>
              </span>
            </div>
            <div
              data-testid="keymap-capture-conflicts"
              className="mt-1.5 max-h-24 min-h-0 overflow-y-auto rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-500"
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
