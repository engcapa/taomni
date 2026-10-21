import type { ActionSnapshotItem } from "../workspaceActionHost";
import { type KeymapBindingSource, type KeymapSchemeV3, type Shortcut } from "../workspaceKeymapScheme";

export interface KeymapSettingsDialogProps {
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

export type CaptureTarget = { actionId: string; replaceIndex: number | null; };

export type MouseCaptureTarget = { actionId: string; };

export type RowMenuState = { actionId: string; x: number; y: number; };

export interface RowBinding {
  shortcuts: readonly Shortcut[];
  source: KeymapBindingSource;
  /** Every other action whose effective bindings share one of these strokes. */
  conflictsWith: { actionId: string; title: string; source: KeymapBindingSource; }[];
}
