import { EditorView } from "@codemirror/view";
import { closeCompletion, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { gotoLine } from "@codemirror/search";
import { cancelLspSnippetSession } from "../lspCompletion";
import { lspPositionFromOffset } from "../lspPositions";
import { escapeEditorSelections } from "../workspaceEditorCommands";
import { buildEditorHostActions } from "../workspaceCodeMirrorKeymap";
import { measuredEditorActionGeometryReady } from "./editorActionGeometry";
import { applySharedTransactionToView } from "./documentSync";


export interface CreateMountedEditorActionsContext {
  openReplacePanel: (view: EditorView) => boolean;
  view: EditorView;
  onGoToLineRequestRef: import("react").RefObject<((request: import("./types").GoToLineRequest) => void) | undefined>;
  expandSemanticSelection: (view: EditorView) => boolean;
  viewRef: import("react").RefObject<EditorView | null>;
  pendingCompletionAcceptanceRef: import("react").RefObject<(() => void) | null>;
  setResolveGateUi: import("react").Dispatch<import("react").SetStateAction<{ id: number; label: string; message: string; failed: boolean; retrying: boolean; top: number; left: number; retry: () => Promise<"committed" | "unavailable">; insertWithoutImport: () => boolean; dismiss: () => void; } | null>>;
  basicCompletionReopenRef: import("react").RefObject<boolean>;
  onParameterEscapeRef: import("react").RefObject<(() => boolean) | undefined>;
  workspaceHistoryClaimRef: import("react").RefObject<((action: "undo" | "redo") => boolean | undefined) | undefined>;
  transactionOwnerRef: import("react").RefObject<import("../workspaceDocumentTransactionOwner").WorkspaceDocumentTransactionOwner | null>;
  fileKeyRef: import("react").RefObject<string>;
  viewIdRef: import("react").RefObject<string>;
  rememberLocalDocumentEcho: (text: string) => void;
  onChangeRef: import("react").RefObject<(doc: string, caret: import("../../../../lib/editor/lsp").LspPosition, caretOffset: number) => void>;
}

export function createMountedEditorActions(context: CreateMountedEditorActionsContext) {
  const {
    openReplacePanel,
    view,
    onGoToLineRequestRef,
    expandSemanticSelection,
    viewRef,
    pendingCompletionAcceptanceRef,
    setResolveGateUi,
    basicCompletionReopenRef,
    onParameterEscapeRef,
    workspaceHistoryClaimRef,
    transactionOwnerRef,
    fileKeyRef,
    viewIdRef,
    rememberLocalDocumentEcho,
    onChangeRef,
  } = context;
  return buildEditorHostActions({
    openReplacePanel: () => openReplacePanel(view),
    // ED-PARITY-012 DEC-012-06: IDEA "Go to Line:Column" dialog.
    openGoToLine: () => {
      const request = onGoToLineRequestRef.current;
      if (!request) return gotoLine(view);
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      request({
        current: { line: line.number, column: head - line.from + 1 },
        lineCount: view.state.doc.lines,
        apply: (target) => {
          const targetLine = view.state.doc.line(Math.min(target.line, view.state.doc.lines));
          const pos = Math.min(targetLine.from + target.column - 1, targetLine.to);
          view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: "select" });
          view.focus();
        },
        cancel: () => view.focus(),
      });
      return true;
    },
    expandSemanticSelection: () => expandSemanticSelection(view),
    // §8.19.4 explicit Basic Completion. With a popup already open at
    // this caret, close + restart so the second explicit call re-runs the
    // source (ordinal ≥ 2 → requestedScope expanded); the reopen flag
    // stops the popup-close listener from resetting the ordinal between
    // the two halves of the toggle.
    startBasicCompletion: () => {
      if (!viewRef.current) return false;
      pendingCompletionAcceptanceRef.current?.();
      setResolveGateUi(null);
      if (completionStatus(view.state) === null) {
        startCompletion(view);
        return true;
      }
      basicCompletionReopenRef.current = true;
      try {
        closeCompletion(view);
        startCompletion(view);
      } finally {
        basicCompletionReopenRef.current = false;
      }
      return true;
    },
    escapeStack: () =>
      cancelLspSnippetSession(view)
      || escapeEditorSelections(view)
      || (onParameterEscapeRef.current?.() ?? false),
    isEditorGeometryReady: () => measuredEditorActionGeometryReady(view),
    runEditorCommand: (command) => command(view),
    undo: () => {
      // ED-AUDIT-008: the workspace-edit journal is the newest
      // user-visible history owner; when it can serve this stroke the
      // document ledger must not act on it.
      const claimed = workspaceHistoryClaimRef.current?.("undo");
      if (claimed !== undefined) return claimed;
      const currentOwner = transactionOwnerRef.current;
      if (!currentOwner) return undefined;
      if (view.state.readOnly || view.composing) return false;
      if (currentOwner.getDocument(fileKeyRef.current) !== view.state.doc.toString()) return false;
      const transaction = currentOwner.undo(fileKeyRef.current, viewIdRef.current);
      if (!transaction || !applySharedTransactionToView(view, transaction)) return false;
      rememberLocalDocumentEcho(view.state.doc.toString());
      onChangeRef.current(
        view.state.doc.toString(),
        lspPositionFromOffset(view.state.doc, view.state.selection.main.head),
        view.state.selection.main.head,
      );
      return true;
    },
    redo: () => {
      const claimed = workspaceHistoryClaimRef.current?.("redo");
      if (claimed !== undefined) return claimed;
      const currentOwner = transactionOwnerRef.current;
      if (!currentOwner) return undefined;
      if (view.state.readOnly || view.composing) return false;
      if (currentOwner.getDocument(fileKeyRef.current) !== view.state.doc.toString()) return false;
      const transaction = currentOwner.redo(fileKeyRef.current, viewIdRef.current);
      if (!transaction || !applySharedTransactionToView(view, transaction)) return false;
      rememberLocalDocumentEcho(view.state.doc.toString());
      onChangeRef.current(
        view.state.doc.toString(),
        lspPositionFromOffset(view.state.doc, view.state.selection.main.head),
        view.state.selection.main.head,
      );
      return true;
    },
  });
}
