import { EditorView } from "@codemirror/view";
import { type CompositionSession } from "./types";
import { isCompositionNavigationKey } from "./commands";


export interface CreateCompositionLifecycleContext {
  view: EditorView;
  compositionActiveRef: import("react").RefObject<boolean>;
  compositionEndFinalizeRef: import("react").RefObject<number | null>;
  currentCompositionSessionRef: import("react").RefObject<CompositionSession | null>;
  transactionOwnerRef: import("react").RefObject<import("../workspaceDocumentTransactionOwner").WorkspaceDocumentTransactionOwner | null>;
  fileKeyRef: import("react").RefObject<string>;
  compositionSessionSeqRef: import("react").RefObject<number>;
  viewIdRef: import("react").RefObject<string>;
  clipboardWorkspaceId: string | undefined;
}

export function createCompositionLifecycle(context: CreateCompositionLifecycleContext) {
  const {
    view,
    compositionActiveRef,
    compositionEndFinalizeRef,
    currentCompositionSessionRef,
    transactionOwnerRef,
    fileKeyRef,
    compositionSessionSeqRef,
    viewIdRef,
    clipboardWorkspaceId,
  } = context;
  const compositionNavigationGuard = (event: KeyboardEvent) => {
    if (
      (!view.composing && event.isComposing !== true && !compositionActiveRef.current)
      || !isCompositionNavigationKey(event.key)
    ) return;
    // CodeMirror intentionally ignores key handlers during composition, so
    // this capture listener also has to stop the contenteditable default
    // action from moving the caret before the composition is committed.
    event.preventDefault();
  };
  view.contentDOM.addEventListener("keydown", compositionNavigationGuard, true);
  const clearPendingCompositionFinalize = () => {
    if (compositionEndFinalizeRef.current === null) return;
    window.clearTimeout(compositionEndFinalizeRef.current);
    compositionEndFinalizeRef.current = null;
  };
  const finalizeSession = (session: CompositionSession) => {
    if (session.status === "finalized") return;
    session.status = "finalized";
    try {
      session.owner.finalizeComposition(session.fileKey, session.id);
    } catch {
      // ignore
    }
    if (currentCompositionSessionRef.current === session) {
      currentCompositionSessionRef.current = null;
      compositionActiveRef.current = false;
    }
  };
  const compositionStartGuard = () => {
    clearPendingCompositionFinalize();
    const previousSession = currentCompositionSessionRef.current;
    if (previousSession && previousSession.status !== "finalized") {
      finalizeSession(previousSession);
    }
    compositionActiveRef.current = true;
    const currentOwner = transactionOwnerRef.current;
    const currentFileKey = fileKeyRef.current;
    if (currentOwner && currentFileKey) {
      const nextId = `comp_${++compositionSessionSeqRef.current}_${Date.now()}`;
      const newSession: CompositionSession = {
        id: nextId,
        status: "active",
        owner: currentOwner,
        fileKey: currentFileKey,
        viewId: viewIdRef.current,
        workspaceId: clipboardWorkspaceId ?? null,
      };
      currentCompositionSessionRef.current = newSession;
    }
  };
  const compositionEndGuard = () => {
    compositionActiveRef.current = false;
    const session = currentCompositionSessionRef.current;
    if (!session || session.status === "finalized") {
      clearPendingCompositionFinalize();
      return;
    }
    session.status = "end_pending";
    clearPendingCompositionFinalize();
    // ED-MAIN-006 & ED-REPAIR-007:
    // CodeMirror dispatches the final composition change from
    // `Promise.resolve().then(flush)` after compositionend. Defer finalization
    // to the next macrotask so the flush extends this session's entry first.
    compositionEndFinalizeRef.current = window.setTimeout(() => {
      compositionEndFinalizeRef.current = null;
      if (session.status === "end_pending") {
        finalizeSession(session);
      }
    }, 0);
  };
  const compositionBlurGuard = () => {
    // Blur may precede CodeMirror's final microtask flush just like end.
    // Preserve this session until that flush has joined its undo entry.
    compositionEndGuard();
  };
  view.contentDOM.addEventListener("compositionstart", compositionStartGuard, true);
  view.contentDOM.addEventListener("compositionend", compositionEndGuard, true);
  view.contentDOM.addEventListener("blur", compositionBlurGuard, true);
  return () => {
    compositionActiveRef.current = false;
    clearPendingCompositionFinalize();
    if (currentCompositionSessionRef.current) {
      finalizeSession(currentCompositionSessionRef.current);
    } else if (transactionOwnerRef.current && fileKeyRef.current) {
      transactionOwnerRef.current.finalizeComposition(fileKeyRef.current);
    }
    view.contentDOM.removeEventListener("keydown", compositionNavigationGuard, true);
    view.contentDOM.removeEventListener("compositionstart", compositionStartGuard, true);
    view.contentDOM.removeEventListener("compositionend", compositionEndGuard, true);
    view.contentDOM.removeEventListener("blur", compositionBlurGuard, true);
  };
}
