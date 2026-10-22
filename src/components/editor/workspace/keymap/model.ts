import type { EditorView } from "@codemirror/view";
import { type WorkspaceActionContext } from "../workspaceActionRegistry";

/** Options for the editor-scoped adapter. */
export interface CodeMirrorActionKeymapOptions {
  /** Only these action ids are dispatched inside the editor surface. */
  actionIds: readonly string[];
  /**
   * Fresh editor context for prepare-time evaluation (focus=editor plus
   * selection/read-only facts); invoked per event, never cached.
   */
  editorContextProvider: () => Partial<WorkspaceActionContext>;
}

/**
 * Register the editor-host business actions that previously lived as inline
 * `{key, run}` entries inside CodeMirrorHost's spread keymap. Every entry is
 * an explicit `editor.*` action so it appears in the conflict graph, Search
 * Everywhere and the Keymap settings surface (§8.18.2 单一 catalog).
 */
export interface EditorHostActionHandlers {
  openReplacePanel(): boolean;
  expandSemanticSelection(): boolean;
  /**
   * Explicit Basic Completion (§8.19.4): opens the popup, or — when one is
   * already open at this caret — restarts the query so the repeated call
   * reaches the provider adapter as ordinal ≥ 2 / expanded scope.
   */
  startBasicCompletion(): boolean;
  /** Escape stack: snippet tabstop cancel → selection collapse → signature hide. */
  escapeStack(): boolean;
  /**
   * Run a CodeMirror command against this mount's live view (§8.19.2
   * migration channel for the previously inline keymap business bindings).
   */
  runEditorCommand(command: (view: EditorView) => boolean): boolean;
  /** Open the IDEA Go to Line:Column dialog (ED-PARITY-012). */
  openGoToLine?(): boolean;
  /** Live display geometry gate used before consuming PageUp/PageDown. */
  isEditorGeometryReady?(): boolean;
  /** Shared document history owner; undefined keeps standalone CM history. */
  undo?(): boolean | undefined;
  redo?(): boolean | undefined;
}

// ---------------------------------------------------------------------------
// §8.19.2 retained-binding allowlist. With an ActionHost present the CM spread
// keeps ONLY these primitives; every user-visible business binding lives in
// buildEditorHostActions above and resolves through the host dispatcher.
// Each entry explains why it cannot be a configurable action binding.
// ---------------------------------------------------------------------------

export interface RetainedBindingAllowlistEntry {
  /** CodeMirror key pattern (as written in keymap.of entries). */
  pattern: string;
  reason: string;
}
