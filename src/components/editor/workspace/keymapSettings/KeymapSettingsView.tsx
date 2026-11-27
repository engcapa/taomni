import { ContextMenu } from "../../../ContextMenu";
import { ModalSurface } from "../../../ui/ModalSurface";
import { t } from "../../../../lib/i18n";
import { promptAppDialog } from "../../../../lib/appDialogs";
import { ChevronDown, ChevronRight, Keyboard, X } from "lucide-react";
import { ShortcutKeyCaps } from "../ShortcutKeyCaps";
import type { ActionSnapshotItem } from "../workspaceActionHost";
import { formatShortcutLabel } from "../workspaceKeymapPlatform";
import { createKeymapScheme, type KeymapBaseSchemeId, type KeymapBindingSource, type KeymapSchemeV3, type Shortcut, type ShortcutStroke } from "../workspaceKeymapScheme";
import { guessBase, layoutLabel, toShortcut, upsertScheme } from "./bindings";
import { type CaptureTarget, type MouseCaptureTarget, type RowBinding, type RowMenuState } from "./model";
import { useKeymapRecorder } from "./useKeymapRecorder";

export interface KeymapSettingsViewProps {
  onClose: () => void;
  draftActiveId: string | null;
  setDraftActiveId: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  defaultSchemeName: string;
  allSchemes: KeymapSchemeV3[];
  draftScheme: KeymapSchemeV3 | null;
  setDraftSchemes: import("react").Dispatch<import("react").SetStateAction<readonly KeymapSchemeV3[]>>;
  draftSchemes: readonly KeymapSchemeV3[];
  corruptDiagnostic: string | null | undefined;
  shortcutFilter: ShortcutStroke[] | null;
  shortcutFilterFieldRef: import("react").RefObject<HTMLDivElement | null>;
  handleShortcutFilterKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  filter: string;
  setFilter: import("react").Dispatch<import("react").SetStateAction<string>>;
  shortcutFilterSecond: boolean;
  setShortcutFilterSecond: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  toggleShortcutFilter: () => void;
  groups: [string, ActionSnapshotItem[]][];
  searching: boolean;
  expandedGroups: ReadonlySet<string>;
  toggleGroup: (category: string) => void;
  renderRow: (item: ActionSnapshotItem) => import("react").JSX.Element;
  filteredActions: ActionSnapshotItem[];
  rowMenu: RowMenuState | null;
  snapshot: readonly ActionSnapshotItem[];
  rowBindings: Map<string, RowBinding>;
  setRowMenu: import("react").Dispatch<import("react").SetStateAction<RowMenuState | null>>;
  startKeyboardCapture: (actionId: string, replaceIndex: number | null) => void;
  startMouseCapture: (actionId: string) => void;
  removeShortcut: (actionId: string, index: number) => void;
  resetActionShortcuts: (actionId: string) => void;
  mouseCapture: MouseCaptureTarget | null;
  setMouseHint: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setMouseShortcut: import("react").Dispatch<import("react").SetStateAction<Shortcut | null>>;
  mouseShortcut: Shortcut | null;
  mouseHint: string | null;
  mouseConflicts: { title: string; actionId: string; source: KeymapBindingSource; }[];
  recorder: ReturnType<typeof useKeymapRecorder>;
  setMouseCapture: import("react").Dispatch<import("react").SetStateAction<MouseCaptureTarget | null>>;
  capture: CaptureTarget | null;
  recorderFieldRef: import("react").RefObject<HTMLDivElement | null>;
  capturedStrokes: ShortcutStroke[];
  secondStrokeEnabled: boolean;
  setSecondStrokeEnabled: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setCapturedStrokes: import("react").Dispatch<import("react").SetStateAction<ShortcutStroke[]>>;
  captureConflicts: { title: string; actionId: string; source: KeymapBindingSource; }[];
  dirty: boolean;
}

export function KeymapSettingsView(inputs: KeymapSettingsViewProps) {
  const {
    onClose,
    draftActiveId,
    setDraftActiveId,
    defaultSchemeName,
    allSchemes,
    draftScheme,
    setDraftSchemes,
    draftSchemes,
    corruptDiagnostic,
    shortcutFilter,
    shortcutFilterFieldRef,
    handleShortcutFilterKeyDown,
    filter,
    setFilter,
    shortcutFilterSecond,
    setShortcutFilterSecond,
    toggleShortcutFilter,
    groups,
    searching,
    expandedGroups,
    toggleGroup,
    renderRow,
    filteredActions,
    rowMenu,
    snapshot,
    rowBindings,
    setRowMenu,
    startKeyboardCapture,
    startMouseCapture,
    removeShortcut,
    resetActionShortcuts,
    mouseCapture,
    setMouseHint,
    setMouseShortcut,
    mouseShortcut,
    mouseHint,
    mouseConflicts,
    recorder,
    setMouseCapture,
    capture,
    recorderFieldRef,
    capturedStrokes,
    secondStrokeEnabled,
    setSecondStrokeEnabled,
    setCapturedStrokes,
    captureConflicts,
    dirty,
  } = inputs;
  const returnToAction = (actionId: string) =>
    document.querySelector<HTMLElement>(`[data-testid="workspace-keymap-settings-dialog"][open] [data-testid="keymap-add-${CSS.escape(actionId)}"]`);
  return ((
    <ModalSurface data-testid="workspace-keymap-settings-dialog"
      initialFocus='[data-testid="keymap-action-filter"]' onCancel={onClose}
      aria-labelledby="workspace-keymap-settings-title"
      className="taomni-modal taomni-workspace-modal" data-bleed="true"
      style={{ width: "min(720px, calc(100vw - 32px))", height: "min(80vh, 680px)" }}
    >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <h2 id="workspace-keymap-settings-title" className="font-medium">Keymap</h2>
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
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-active-line-bg)]"
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
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
            disabled={!draftScheme || draftScheme.readOnly}
            onClick={async () => {
              if (!draftScheme) return;
              const name = await promptAppDialog({ title: t("uiDecision.schemeName"), initialValue: draftScheme.name });
              if (!name) return;
              setDraftSchemes((schemes) => schemes.map((scheme) =>
                scheme.id === draftScheme.id ? { ...scheme, name, updatedAt: Date.now() } : scheme));
            }}
          >
            Rename
          </button>
          <button
            type="button"
            data-testid="keymap-scheme-reset"
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
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
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
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
            className="ml-1 rounded p-1 hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        {(corruptDiagnostic || draftScheme?.readOnly) && (
          <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-1.5 text-xs text-ui-warning" role="status">
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
              className="min-w-0 flex-1 rounded border border-[var(--taomni-code-accent,#4b9edd)] px-2 py-1 text-sm focus-visible:keyboard-outline"
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
              className="min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-transparent px-2 py-1 text-sm focus-visible:keyboard-outline focus:border-[var(--taomni-code-accent, #4b9edd)]"
            />
          )}
          {shortcutFilter && (
            <label className="flex shrink-0 items-center gap-1 text-ui-small">
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
            className="shrink-0 rounded border border-[var(--taomni-code-border)] p-1 hover:bg-[var(--taomni-code-active-line-bg)] aria-pressed:bg-[var(--taomni-code-selection-match-bg)]"
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
                  className="flex w-full items-center gap-1 py-1 text-left text-ui-body font-medium hover:bg-[var(--taomni-code-active-line-bg)]"
                  onClick={() => toggleGroup(category)}
                >
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>{category}</span>
                  <span className="ml-1 text-ui-caption font-normal opacity-50">{items.length}</span>
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
          return <ContextMenu x={rowMenu.x} y={rowMenu.y}
            ariaLabel={`${item.title} shortcuts`} testId="keymap-row-menu" closeOnTab
            onClose={() => setRowMenu(null)} items={[
              { label: "Add Keyboard Shortcut", testId: "keymap-row-menu-add-keyboard",
                onClick: () => startKeyboardCapture(item.id, null) },
              { label: "Add Mouse Shortcut", testId: "keymap-row-menu-add-mouse",
                onClick: () => startMouseCapture(item.id) },
              ...(row?.shortcuts.length ? [{ label: "", separator: true }] : []),
              ...(row?.shortcuts ?? []).map((shortcut, index) => ({
                label: `Remove ${formatShortcutLabel(shortcut)}`,
                testId: `keymap-row-menu-remove-${index}`,
                onClick: () => removeShortcut(item.id, index),
              })),
              { label: "", separator: true },
              { label: "Reset Shortcuts", testId: "keymap-row-menu-reset",
                disabled: row?.source !== "user", disabledReason: "No custom shortcuts to reset",
                onClick: () => resetActionShortcuts(item.id) },
            ]} />;
        })()}
        {mouseCapture && (
          <ModalSurface data-testid="keymap-mouse-recorder" aria-labelledby="keymap-mouse-recorder-title"
            initialFocus='[data-testid="keymap-mouse-recorder-cancel"]' returnFocus={returnToAction(mouseCapture.actionId)} onCancel={() => setMouseCapture(null)}
            className="taomni-modal taomni-workspace-modal">
              <div className="mb-2 text-ui-body font-medium">
                <span id="keymap-mouse-recorder-title">Mouse Shortcut</span> · {snapshot.find((item) => item.id === mouseCapture.actionId)?.title ?? mouseCapture.actionId}
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
              {mouseHint && <div data-testid="keymap-mouse-recorder-hint" role="alert" className="mt-1.5 text-ui-warning">{mouseHint}</div>}
              {mouseConflicts.length > 0 && (
                <div data-testid="keymap-mouse-recorder-conflicts" role="status" className="mt-1.5 text-ui-warning">
                  ⚠ Already assigned to: {mouseConflicts.map((holder) => `${holder.title} (${holder.actionId})`).join(", ")}
                </div>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" data-testid="keymap-mouse-recorder-ok" disabled={!mouseShortcut}
                  className="rounded border border-[var(--taomni-code-accent,#4b9edd)] px-3 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
                  onClick={() => {
                    if (!mouseShortcut) return;
                    recorder.commitShortcut(mouseCapture.actionId, null, mouseShortcut);
                    setMouseCapture(null);
                  }}>
                  OK
                </button>
                <button type="button" data-testid="keymap-mouse-recorder-cancel" onClick={() => setMouseCapture(null)}
                  className="rounded border border-[var(--taomni-code-border)] px-3 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)]">
                  Cancel
                </button>
              </div>
          </ModalSurface>
        )}

        {/*
          DEC-013-08: IDEA "Keyboard Shortcut" sub-dialog. The conflict warning
          stays ADVISORY (ED-PARITY-004 DEC-02) — OK remains enabled — and
          names EVERY action holding the stroke.
        */}
        {capture && (
          <ModalSurface data-testid="keymap-recorder" aria-labelledby="keymap-recorder-title"
            initialFocus='[aria-label="Press shortcut keys"]' returnFocus={returnToAction(capture.actionId)} onCancel={recorder.closeRecorder}
            className="taomni-modal taomni-workspace-modal">
              <div className="mb-2 text-ui-body font-medium">
                <span id="keymap-recorder-title">Keyboard Shortcut</span> · {snapshot.find((item) => item.id === capture.actionId)?.title ?? capture.actionId}
              </div>
              <div className="mb-1 opacity-70">First stroke</div>
              <div
                ref={recorderFieldRef}
                role="textbox"
                tabIndex={0}
                aria-label="Press shortcut keys"
                aria-readonly="true"
                className="flex min-h-7 items-center gap-2 rounded border border-[var(--taomni-code-accent,#4b9edd)] px-2 py-1 focus-visible:keyboard-outline"
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
                className="mt-2 max-h-24 min-h-0 overflow-y-auto rounded border border-ui-warning-border bg-ui-warning-surface px-2 py-1 text-ui-warning"
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
                  className="rounded border border-[var(--taomni-code-accent,#4b9edd)] px-3 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
                  disabled={capturedStrokes.length === 0}
                  onClick={() => {
                    if (capturedStrokes.length === 0) return;
                    recorder.commitShortcut(capture.actionId, capture.replaceIndex, toShortcut(capturedStrokes));
                    recorder.closeRecorder();
                  }}
                >
                  OK
                </button>
                <button
                  type="button"
                  data-testid="keymap-recorder-cancel"
                  className="rounded border border-[var(--taomni-code-border)] px-3 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)]"
                  onClick={recorder.closeRecorder}
                >
                  Cancel
                </button>
              </div>
          </ModalSurface>
        )}

        {/* DEC-03: Apply/OK is the only commit edge; both discard-free closes do nothing. */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
          <button
            type="button"
            data-testid="keymap-settings-ok"
            className="rounded border border-[var(--taomni-code-border)] px-3 py-1 text-xs hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={() => recorder.applyDraft(true)}
          >
            OK
          </button>
          <button
            type="button"
            data-testid="keymap-settings-cancel"
            className="rounded border border-[var(--taomni-code-border)] px-3 py-1 text-xs hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="keymap-settings-apply"
            className="rounded border border-[var(--taomni-code-accent, #4b9edd)] px-3 py-1 text-xs hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
            disabled={!dirty}
            onClick={() => recorder.applyDraft(false)}
          >
            Apply
          </button>
        </div>
    </ModalSurface>
  ));
}
