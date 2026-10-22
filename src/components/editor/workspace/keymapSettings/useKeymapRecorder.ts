import { useEffect } from "react";
import {
  deriveEditableScheme,
  displaceStroke,
  effectiveSchemeBindings,
  isReservedStroke,
  setActionBindings,
  strokeFromKeyboardEvent,
  type KeymapBaseSchemeId,
  type KeymapSchemeV3,
  type Shortcut,
  type ShortcutStroke,
} from "../workspaceKeymapScheme";
import { guessBase, toShortcut, upsertScheme } from "./bindings";
import { type CaptureTarget, type MouseCaptureTarget, type RowMenuState } from "./model";

export interface UseKeymapRecorderContext {
  setCapture: import("react").Dispatch<import("react").SetStateAction<CaptureTarget | null>>;
  setCapturedStrokes: import("react").Dispatch<import("react").SetStateAction<ShortcutStroke[]>>;
  setSecondStrokeEnabled: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  capture: CaptureTarget | null;
  recorderFieldRef: import("react").RefObject<HTMLDivElement | null>;
  onSchemesChange: (schemes: readonly KeymapSchemeV3[]) => void;
  draftSchemes: readonly KeymapSchemeV3[];
  onActiveSchemeChange: (schemeId: string | null) => void;
  draftActiveId: string | null;
  onApplyScheme: (scheme: KeymapSchemeV3 | null) => void;
  draftScheme: KeymapSchemeV3 | null;
  onClose: () => void;
  defaultSchemeName: string;
  setDraftSchemes: import("react").Dispatch<import("react").SetStateAction<readonly KeymapSchemeV3[]>>;
  setDraftActiveId: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  baseBindings: Map<string, readonly Shortcut[]>;
  open: boolean;
  captureRef: import("react").RefObject<CaptureTarget | null>;
  overlayStateRef: import("react").RefObject<{ mouse: boolean; menu: boolean; findField: boolean; }>;
  shortcutFilterFieldRef: import("react").RefObject<HTMLDivElement | null>;
  setRowMenu: import("react").Dispatch<import("react").SetStateAction<RowMenuState | null>>;
  setMouseCapture: import("react").Dispatch<import("react").SetStateAction<MouseCaptureTarget | null>>;
  capturedStrokesRef: import("react").RefObject<ShortcutStroke[]>;
  secondStrokeEnabledRef: import("react").RefObject<boolean>;
}

export function useKeymapRecorder(context: UseKeymapRecorderContext) {
  const {
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
  } = context;

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
  return { ensureMutableDraft, commitShortcut, closeRecorder, applyDraft };
}
