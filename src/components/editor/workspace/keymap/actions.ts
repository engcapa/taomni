import {
  copyLineDown,
  cursorCharLeft,
  cursorCharRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  deleteCharBackward,
  deleteCharForward,
  deleteLine,
  insertNewlineAndIndent,
  moveLineDown,
  moveLineUp,
  redo,
  selectCharLeft,
  selectCharRight,
  selectLineBoundaryForward,
  toggleBlockComment,
  toggleComment,
  undo,
} from "@codemirror/commands";
import { findNext, findPrevious, gotoLine, openSearchPanel, selectSelectionMatches } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { type ActionResult, type ActionState, type WorkspaceActionContext } from "../workspaceActionRegistry";
import { completeCurrentStatement, expandSyntaxSelection, joinLines, shrinkSyntaxSelection, tabJumpOut, toggleCase, unselectOccurrence } from "../workspaceEditorCommands";
import {
  virtualBackspaceCommand,
  virtualDeleteCommand,
  virtualEnterCommand,
  virtualHomeCommand,
  virtualLineEndCommand,
  virtualMoveLeftCommand,
  virtualMoveRightCommand,
  virtualTabCommand,
  virtualVerticalMoveCommand,
} from "../workspaceVirtualSpace";
import { type EditorHostActionHandlers } from "./model";

/** A CodeMirror command adapted into an ActionResult (§8.19.2). */
export function commandResult(handled: boolean): ActionResult {
  return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
}

/**
 * Run a CodeMirror `Command` through the registering host mount's live view.
 * Handlers close over the mounted EditorView (same lifecycle as
 * registerActions), so no global context plumbing can go stale across
 * split-view remounts (§8.19.2).
 */
export function runViaHandlers(
  handlers: EditorHostActionHandlers,
  command: (view: EditorView) => boolean,
): ActionResult {
  return commandResult(handlers.runEditorCommand(command));
}

export function virtualOrFallback(
  virtualCommand: (view: EditorView) => boolean,
  fallbackCommand: (view: EditorView) => boolean,
): (view: EditorView) => boolean {
  return (view) => virtualCommand(view) || fallbackCommand(view);
}

export function runSharedHistoryOrLocal(
  handlers: EditorHostActionHandlers,
  shared: (() => boolean | undefined) | undefined,
  local: (view: EditorView) => boolean,
): ActionResult {
  const handled = shared?.();
  return handled === undefined
    ? runViaHandlers(handlers, local)
    : commandResult(handled);
}

export function editorAction(input: {
  id: string;
  title: string;
  category: "Edit" | "View" | "File";
  defaultKeybinding: string;
  secondary?: readonly string[];
  keywords?: readonly string[];
  requiresEditor: boolean;
  getState?: (context: WorkspaceActionContext) => ActionState;
  run: (context: WorkspaceActionContext) => Promise<ActionResult>;
}) {
  return {
    id: input.id,
    title: input.title,
    category: input.category,
    keybinding: input.defaultKeybinding,
    ...(input.secondary ? { secondaryKeybindings: [...input.secondary] } : {}),
    ...(input.keywords ? { keywords: [...input.keywords] } : {}),
    provenance: "local" as const,
    ...(input.getState ? { getState: input.getState } : {}),
    when: input.requiresEditor
      ? (context: WorkspaceActionContext) => context.focus === "editor" && !!context.hasActiveFile
      : undefined,
    run: input.run,
  };
}

export function editorGeometryActionState(
  handlers: EditorHostActionHandlers,
  context: WorkspaceActionContext,
): ActionState {
  const hasEditorOwner = context.focus === "editor" && !!context.hasActiveFile;
  const geometryReady = handlers.isEditorGeometryReady?.() ?? true;
  const available = hasEditorOwner && geometryReady;
  return {
    availability: available ? "available" : "disabled",
    disabledReason: available
      ? undefined
      : (hasEditorOwner ? "geometryUnavailable" : "noEditor"),
    source: "local",
    scope: "editor",
    freshness: "current",
    completeness: geometryReady ? "complete" : "unavailable",
  };
}

/**
 * Create the editor.* action definitions bound to the live CodeMirrorHost
 * handlers. Registration goes through the normal host channel so lifecycle,
 * conflicts and disabled reasons are uniform.
 */
export function buildEditorHostActions(handlers: EditorHostActionHandlers) {
  return [
    editorAction({
      id: "editor.replace",
      title: "Replace in File",
      category: "Edit",
      defaultKeybinding: "Ctrl+r",
      secondary: ["Meta+r"],
      keywords: ["search", "replace"],
      requiresEditor: true,
      run: async () => {
        const handled = handlers.openReplacePanel();
        return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
      },
    }),
    // Parameter Info intentionally NOT duplicated here: the workspace-level
    // `workspace.parameterInfo` command (Ctrl+P) owns it and drives the
    // editor through parameterInfoRequestNonce (§8.18.2 单一 catalog).
    editorAction({
      id: "editor.expandSelection",
      title: "Extend Selection",
      category: "Edit",
      defaultKeybinding: "Ctrl+w",
      secondary: ["Meta+w"],
      keywords: ["select", "word", "semantic"],
      requiresEditor: true,
      run: async () => {
        // LSP-aware semantic selection first; expandSemanticSelection itself
        // falls back to the Lezer syntax pass when no handler/range exists,
        // keeping this action the single Ctrl+W owner.
        if (handlers.expandSemanticSelection()) return { kind: "applied" };
        return commandResult(handlers.runEditorCommand(expandSyntaxSelection));
      },
    }),
    editorAction({
      id: "editor.shrinkSelection",
      title: "Shrink Selection",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+w",
      secondary: ["Meta+Shift+w"],
      keywords: ["select", "shrink", "syntax"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, shrinkSyntaxSelection),
    }),
    // No default keybinding: Escape remains an editor-local primitive (CM
    // default keymap + snippet/signature stack). The action exists so the
    // capability is discoverable and command-dispatchable.
    editorAction({
      id: "editor.escapeSelectionStack",
      title: "Escape Selection Stack",
      category: "Edit",
      defaultKeybinding: "",
      keywords: ["cancel", "collapse", "deselect"],
      requiresEditor: true,
      run: async () => {
        const handled = handlers.escapeStack();
        return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
      },
    }),

    // ---- §8.19.2 migration: business bindings previously spread straight
    // into CodeMirror via workspaceEditorKeymap / searchKeymap / historyKeymap.
    // Each visible command below is now an action so scheme editing, conflict
    // detection and every consumer surface share one runtime truth.
    editorAction({
      id: "editor.toggleLineComment",
      title: "Toggle Line Comment",
      category: "Edit",
      defaultKeybinding: "Ctrl+/",
      secondary: ["Meta+/"],
      keywords: ["comment"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, toggleComment),
    }),
    editorAction({
      id: "editor.toggleBlockComment",
      title: "Toggle Block Comment",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+/",
      secondary: ["Meta+Shift+/"],
      keywords: ["comment", "block"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, toggleBlockComment),
    }),
    editorAction({
      id: "editor.copyLineDown",
      title: "Duplicate Line",
      category: "Edit",
      defaultKeybinding: "Ctrl+d",
      secondary: ["Meta+d"],
      keywords: ["copy", "line", "duplicate"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, copyLineDown),
    }),
    editorAction({
      id: "editor.deleteLine",
      title: "Delete Line",
      category: "Edit",
      defaultKeybinding: "Ctrl+y",
      secondary: ["Meta+y", "Ctrl+Shift+k", "Meta+Shift+k"],
      keywords: ["line", "delete"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, deleteLine),
    }),
    editorAction({
      id: "editor.moveLineUp",
      title: "Move Line Up",
      category: "Edit",
      defaultKeybinding: "Alt+Shift+ArrowUp",
      keywords: ["line", "move"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, moveLineUp),
    }),
    editorAction({
      id: "editor.moveLineDown",
      title: "Move Line Down",
      category: "Edit",
      defaultKeybinding: "Alt+Shift+ArrowDown",
      keywords: ["line", "move"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, moveLineDown),
    }),
    editorAction({
      id: "editor.gotoLine",
      title: "Go to Line",
      category: "Edit",
      defaultKeybinding: "Ctrl+g",
      secondary: ["Meta+g"],
      keywords: ["jump", "line"],
      requiresEditor: true,
      // ED-PARITY-012 DEC-012-06: IDEA "Go to Line:Column" dialog when the
      // host provides one; the CodeMirror panel is the unhosted fallback.
      run: async () => (handlers.openGoToLine
        ? commandResult(handlers.openGoToLine())
        : runViaHandlers(handlers, gotoLine)),
    }),
    editorAction({
      id: "editor.completeStatement",
      title: "Complete Current Statement",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+Enter",
      secondary: ["Meta+Shift+Enter"],
      keywords: ["complete", "statement", "heuristic"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, completeCurrentStatement),
    }),
    // §8.19.4 explicit Basic Completion (IDEA Ctrl+Space). While a popup is
    // already open the handler restarts the query at the same caret, which is
    // what makes the second call arrive as ordinal ≥ 2 / requestedScope
    // expanded instead of being swallowed by the active popup.
    editorAction({
      id: "editor.basicCompletion",
      title: "Basic Completion",
      category: "Edit",
      defaultKeybinding: "Ctrl+Space",
      secondary: ["Alt+/"],
      keywords: ["complete", "suggest", "popup", "intellisense"],
      requiresEditor: true,
      run: async () => {
        const handled = handlers.startBasicCompletion();
        return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
      },
    }),
    editorAction({
      id: "editor.joinLines",
      title: "Join Lines",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+j",
      secondary: ["Meta+Shift+j"],
      keywords: ["join", "lines"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, joinLines),
    }),
    editorAction({
      id: "editor.unselectLastOccurrence",
      title: "Unselect Occurrence",
      category: "Edit",
      defaultKeybinding: "Alt+Shift+j",
      keywords: ["occurrence", "selection"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, unselectOccurrence),
    }),
    editorAction({
      id: "editor.toggleCase",
      title: "Toggle Case",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+u",
      secondary: ["Meta+Shift+u"],
      keywords: ["case", "upper", "lower"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, toggleCase),
    }),
    // Tab is a reserved stroke (browser focus + completion/snippet precedence):
    // registered without a keybinding and dispatched through commands; the
    // retained CM Tab primitive owns the physical gesture (allowlist).
    editorAction({
      id: "editor.tabJumpOut",
      title: "Tab Jump Out",
      category: "Edit",
      defaultKeybinding: "",
      keywords: ["bracket", "jump", "tab"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, tabJumpOut),
    }),
    editorAction({
      id: "workspace.undo",
      title: "Undo",
      category: "Edit",
      defaultKeybinding: "Ctrl+z",
      secondary: ["Meta+z"],
      keywords: ["history", "undo"],
      requiresEditor: true,
      run: async () => runSharedHistoryOrLocal(handlers, handlers.undo, undo),
    }),
    editorAction({
      id: "workspace.redo",
      title: "Redo",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+z",
      secondary: ["Meta+Shift+z"],
      keywords: ["history", "redo"],
      requiresEditor: true,
      run: async () => runSharedHistoryOrLocal(handlers, handlers.redo, redo),
    }),
    editorAction({
      id: "editor.find",
      title: "Find in File",
      category: "Edit",
      defaultKeybinding: "Ctrl+f",
      secondary: ["Meta+f"],
      keywords: ["search", "find"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, openSearchPanel),
    }),
    editorAction({
      id: "editor.findNext",
      title: "Find Next Match",
      category: "Edit",
      defaultKeybinding: "F3",
      // IDEA FindNext secondary (ED-PARITY-013 DEC-013-05).
      secondary: ["Ctrl+l"],
      keywords: ["search", "next"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, findNext),
    }),
    editorAction({
      id: "editor.findPrevious",
      title: "Find Previous Match",
      category: "Edit",
      defaultKeybinding: "Shift+F3",
      secondary: ["Ctrl+Shift+l"],
      keywords: ["search", "previous"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, findPrevious),
    }),
    editorAction({
      id: "editor.selectSelectionMatches",
      title: "Select All Occurrences of Selection",
      category: "Edit",
      // ED-PARITY-013 DEC-013-05: Ctrl+Shift+L is IDEA Find Previous; IDEA's
      // Select All Occurrences is workspace.editor.selectAllOccurrences.
      defaultKeybinding: "",
      keywords: ["occurrence", "multi-caret", "selection"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, selectSelectionMatches),
    }),

    // ---- §ED-VSPACE-001: Unified Virtual Space & Movement actions ----
    editorAction({
      id: "editor.moveUp",
      title: "Up",
      category: "View",
      defaultKeybinding: "ArrowUp",
      keywords: ["up", "cursor", "line", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "up", false)),
    }),
    editorAction({
      id: "editor.moveDown",
      title: "Down",
      category: "View",
      defaultKeybinding: "ArrowDown",
      keywords: ["down", "cursor", "line", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "down", false)),
    }),
    editorAction({
      id: "editor.selectUp",
      title: "Select Up",
      category: "View",
      defaultKeybinding: "Shift+ArrowUp",
      keywords: ["up", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "up", true)),
    }),
    editorAction({
      id: "editor.selectDown",
      title: "Select Down",
      category: "View",
      defaultKeybinding: "Shift+ArrowDown",
      keywords: ["down", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "down", true)),
    }),
    editorAction({
      id: "editor.pageUp",
      title: "Page Up",
      category: "View",
      defaultKeybinding: "PageUp",
      keywords: ["page", "up", "scroll", "virtual space"],
      requiresEditor: true,
      getState: (context) => editorGeometryActionState(handlers, context),
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "pageUp", false)),
    }),
    editorAction({
      id: "editor.selectPageUp",
      title: "Select Page Up",
      category: "View",
      defaultKeybinding: "Shift+PageUp",
      keywords: ["page", "up", "select", "virtual space"],
      requiresEditor: true,
      getState: (context) => editorGeometryActionState(handlers, context),
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "pageUp", true)),
    }),
    editorAction({
      id: "editor.pageDown",
      title: "Page Down",
      category: "View",
      defaultKeybinding: "PageDown",
      keywords: ["page", "down", "scroll", "virtual space"],
      requiresEditor: true,
      getState: (context) => editorGeometryActionState(handlers, context),
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "pageDown", false)),
    }),
    editorAction({
      id: "editor.selectPageDown",
      title: "Select Page Down",
      category: "View",
      defaultKeybinding: "Shift+PageDown",
      keywords: ["page", "down", "select", "virtual space"],
      requiresEditor: true,
      getState: (context) => editorGeometryActionState(handlers, context),
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "pageDown", true)),
    }),
    editorAction({
      id: "editor.moveLeft",
      title: "Left",
      category: "View",
      defaultKeybinding: "ArrowLeft",
      keywords: ["left", "cursor", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        (view) => virtualMoveLeftCommand(view, false),
        cursorCharLeft,
      )),
    }),
    editorAction({
      id: "editor.selectLeft",
      title: "Select Left",
      category: "View",
      defaultKeybinding: "Shift+ArrowLeft",
      keywords: ["left", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        (view) => virtualMoveLeftCommand(view, true),
        selectCharLeft,
      )),
    }),
    editorAction({
      id: "editor.moveRight",
      title: "Right",
      category: "View",
      defaultKeybinding: "ArrowRight",
      keywords: ["right", "cursor", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        (view) => virtualMoveRightCommand(view, false),
        cursorCharRight,
      )),
    }),
    editorAction({
      id: "editor.selectRight",
      title: "Select Right",
      category: "View",
      defaultKeybinding: "Shift+ArrowRight",
      keywords: ["right", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        (view) => virtualMoveRightCommand(view, true),
        selectCharRight,
      )),
    }),
    editorAction({
      id: "editor.moveToLineStart",
      title: "Move to Line Start",
      category: "View",
      defaultKeybinding: "Home",
      keywords: ["home", "start", "line"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        virtualHomeCommand,
        cursorLineBoundaryBackward,
      )),
    }),
    editorAction({
      id: "editor.moveToLineEnd",
      title: "Move to Line End",
      category: "View",
      defaultKeybinding: "End",
      keywords: ["end", "line", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        (view) => virtualLineEndCommand(view, false),
        cursorLineBoundaryForward,
      )),
    }),
    editorAction({
      id: "editor.selectToLineEnd",
      title: "Select to Line End",
      category: "View",
      defaultKeybinding: "Shift+End",
      keywords: ["end", "line", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        (view) => virtualLineEndCommand(view, true),
        selectLineBoundaryForward,
      )),
    }),
    editorAction({
      id: "editor.deleteBackward",
      title: "Delete Backward",
      category: "Edit",
      defaultKeybinding: "Backspace",
      keywords: ["backspace", "delete", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        virtualBackspaceCommand,
        deleteCharBackward,
      )),
    }),
    editorAction({
      id: "editor.deleteForward",
      title: "Delete Forward",
      category: "Edit",
      defaultKeybinding: "Delete",
      keywords: ["delete", "forward", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        virtualDeleteCommand,
        deleteCharForward,
      )),
    }),
    editorAction({
      id: "editor.insertNewline",
      title: "Insert Newline",
      category: "Edit",
      defaultKeybinding: "Enter",
      keywords: ["enter", "newline", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualOrFallback(
        virtualEnterCommand,
        insertNewlineAndIndent,
      )),
    }),
    editorAction({
      id: "editor.insertTab",
      title: "Insert Tab",
      category: "Edit",
      defaultKeybinding: "Tab",
      keywords: ["tab", "indent", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualTabCommand),
    }),
  ];
}
