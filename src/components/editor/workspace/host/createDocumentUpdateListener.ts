import { remoteTransactionAnnotation, type DocumentChangeDelta } from "../workspaceDocumentTransactionOwner";
import { EditorView } from "@codemirror/view";
import { foldEffect, unfoldEffect } from "@codemirror/language";
import { searchPanelOpen } from "@codemirror/search";
import { lspPositionFromOffset } from "../lspPositions";
import { type CompositionSession } from "./types";
import { applyDocumentSnapshotToView } from "./documentSync";


export interface CreateDocumentUpdateListenerContext {
  applyingExternalDocRef: import("react").RefObject<boolean>;
  lastDocumentTextRef: import("react").RefObject<string>;
  transactionOwnerRef: import("react").RefObject<import("../workspaceDocumentTransactionOwner").WorkspaceDocumentTransactionOwner | null>;
  fileKeyRef: import("react").RefObject<string>;
  viewIdRef: import("react").RefObject<string>;
  currentCompositionSessionRef: import("react").RefObject<CompositionSession | null>;
  compositionActiveRef: import("react").RefObject<boolean>;
  viewRef: import("react").RefObject<EditorView | null>;
  rememberLocalDocumentEcho: (text: string) => void;
  onChangeRef: import("react").RefObject<(doc: string, caret: import("../../../../lib/editor/lsp").LspPosition, caretOffset: number) => void>;
  signatureTriggersRef: import("react").RefObject<string[]>;
  emitParameterTrigger: (view: EditorView, triggerCharacter: string | null, origin: "explicit" | "typing") => boolean;
  onParameterInvalidateRef: import("react").RefObject<((reason: "doc-changed" | "caret-moved" | "closing-char") => void) | undefined>;
  scheduleSelectionEmit: (view: EditorView, delay?: number) => void;
  scheduleViewportEmit: (view: EditorView, defer: boolean) => void;
  viewportEmitTimerRef: import("react").RefObject<number | null>;
  restoringInitialViewStateRef: import("react").RefObject<boolean>;
  userInteractedSinceMountRef: import("react").RefObject<boolean>;
  pendingDeferredScrollRef: import("react").RefObject<{ scrollTop: number; scrollLeft: number; } | null>;
  scheduleViewStateEmit: (view: EditorView, delay?: number) => void;
}

export function createDocumentUpdateListener(context: CreateDocumentUpdateListenerContext) {
  const {
    applyingExternalDocRef,
    lastDocumentTextRef,
    transactionOwnerRef,
    fileKeyRef,
    viewIdRef,
    currentCompositionSessionRef,
    compositionActiveRef,
    viewRef,
    rememberLocalDocumentEcho,
    onChangeRef,
    signatureTriggersRef,
    emitParameterTrigger,
    onParameterInvalidateRef,
    scheduleSelectionEmit,
    scheduleViewportEmit,
    viewportEmitTimerRef,
    restoringInitialViewStateRef,
    userInteractedSinceMountRef,
    pendingDeferredScrollRef,
    scheduleViewStateEmit,
  } = context;
  return EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const isRemote = update.transactions.some((tr) => tr.annotation(remoteTransactionAnnotation));
      if (!applyingExternalDocRef.current && !isRemote) {
        // onChange currently carries a full string, so one conversion is
        // unavoidable. Remember it to avoid a second full conversion in
        // the controlled-doc effect after React reflects the change.
        const nextDoc = update.state.doc.toString();
        lastDocumentTextRef.current = nextDoc;
        if (transactionOwnerRef.current && fileKeyRef.current && viewIdRef.current) {
          const deltas: DocumentChangeDelta[] = [];
          update.changes.iterChanges((fromA, toA, _fromB, _toB, insertedText) => {
            const deleted = update.startState.doc.sliceString(fromA, toA);
            deltas.push({
              from: fromA,
              to: toA,
              insert: insertedText.toString(),
              ...(deleted ? { deleted } : {}),
            });
          });
          if (deltas.length > 0) {
            let currentSession = currentCompositionSessionRef.current;
            const compositionTransaction = update.transactions.some((tr) => tr.isUserEvent("input.type.compose"));
            if (currentSession?.status === "end_pending" && !compositionTransaction
              && !compositionActiveRef.current && !update.view.composing) {
              // Ordinary typing can arrive before the finalize timer.
              // Only CodeMirror's final compose flush extends the old session.
              currentSession.owner.finalizeComposition(currentSession.fileKey, currentSession.id);
              currentSession.status = "finalized";
              currentCompositionSessionRef.current = null;
              currentSession = null;
            }
            const isSessionComposing = currentSession !== null && (
              currentSession.status === "active" || currentSession.status === "end_pending"
            );
            const composingInput = isSessionComposing
              || compositionActiveRef.current
              || update.view.composing
              || compositionTransaction;
            const sessionId = isSessionComposing ? currentSession?.id : undefined;
            const isCompletionEdit = update.transactions.some((tr) => tr.isUserEvent("input.complete"));
            const sharedTransaction = transactionOwnerRef.current.dispatchTransaction(
              fileKeyRef.current,
              viewIdRef.current,
              deltas,
              composingInput ? "composition" : isCompletionEdit ? "completion" : "user-input",
              sessionId,
              isCompletionEdit && !composingInput
                ? {
                  before: {
                    anchor: update.startState.selection.main.anchor,
                    head: update.startState.selection.main.head,
                  },
                  after: {
                    anchor: update.state.selection.main.anchor,
                    head: update.state.selection.main.head,
                  },
                }
                : undefined,
            );
            if (!sharedTransaction) {
              const rejectedView = update.view;
              const rejectedText = nextDoc;
              queueMicrotask(() => {
                const currentView = viewRef.current;
                const currentOwner = transactionOwnerRef.current;
                const currentFileKey = fileKeyRef.current;
                if (
                  currentView !== rejectedView
                  || !currentOwner
                  || !currentFileKey
                  || currentView.state.doc.toString() !== rejectedText
                ) return;
                const canonical = currentOwner.getDocument(currentFileKey);
                if (canonical === null || canonical === rejectedText) return;
                applyingExternalDocRef.current = true;
                try {
                  applyDocumentSnapshotToView(currentView, canonical);
                  lastDocumentTextRef.current = currentView.state.doc.toString();
                } finally {
                  applyingExternalDocRef.current = false;
                }
              });
              return;
            }
          }
        }
        rememberLocalDocumentEcho(nextDoc);
        onChangeRef.current(
          nextDoc,
          lspPositionFromOffset(update.state.doc, update.state.selection.main.head),
          update.state.selection.main.head,
        );
      }
      let inserted = "";
      update.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
        inserted = text.toString();
      });
      const lastChar = inserted.slice(-1);
      if (
        !applyingExternalDocRef.current
        && !isRemote
        && lastChar
        && signatureTriggersRef.current.includes(lastChar)
      ) {
        emitParameterTrigger(update.view, lastChar, "typing");
      } else if (lastChar === ")" || inserted.includes("\n")) {
        onParameterInvalidateRef.current?.("closing-char");
      } else {
        // §8.20.2: a document change closes the OLD tooltip; the next
        // trigger character opens a fresh request through the session.
        onParameterInvalidateRef.current?.("doc-changed");
      }
    } else if (update.selectionSet) {
      // A cursor move without an edit (mouse click, jump) dismisses it.
      onParameterInvalidateRef.current?.("caret-moved");
    }
    if (update.selectionSet || update.docChanged || searchPanelOpen(update.startState) !== searchPanelOpen(update.state)) {
      // Cursor state fans out into workspace UI and LSP effects. During
      // a text burst, publish the final cursor after a short idle rather
      // than causing a React render for every keypress.
      scheduleSelectionEmit(update.view, update.docChanged ? 125 : 0);
    }
    // Viewport offsets move with the document even when no scrolling
    // occurs. Publishing them synchronously on each key bypasses the
    // text/caret batching and rerenders the entire workspace. Keep the
    // final live range (including a subsequent CodeMirror measure) for
    // inlay hints, while ordinary scrolling still publishes immediately.
    if (update.docChanged || update.viewportChanged) {
      scheduleViewportEmit(update.view, update.docChanged || viewportEmitTimerRef.current !== null);
    }
    if (!restoringInitialViewStateRef.current && (
      update.selectionSet
      || update.docChanged
      || update.transactions.some((tr) => tr.isUserEvent("select") || tr.isUserEvent("input"))
    )) {
      userInteractedSinceMountRef.current = true;
      pendingDeferredScrollRef.current = null;
    }
    if (
      pendingDeferredScrollRef.current
      && !userInteractedSinceMountRef.current
      && update.view.scrollDOM
    ) {
      const dom = update.view.scrollDOM;
      const target = pendingDeferredScrollRef.current;
      const canScrollVertically = target.scrollTop > 0 && dom.scrollHeight > dom.clientHeight;
      const canScrollHorizontally = target.scrollLeft > 0 && dom.scrollWidth > dom.clientWidth;
      if (canScrollVertically || canScrollHorizontally) {
        if (target.scrollTop > 0 && canScrollVertically) {
          const maxScrollTop = Math.max(0, dom.scrollHeight - dom.clientHeight);
          dom.scrollTop = Math.min(target.scrollTop, maxScrollTop);
          target.scrollTop = 0;
        }
        if (target.scrollLeft > 0 && canScrollHorizontally) {
          const maxScrollLeft = Math.max(0, dom.scrollWidth - dom.clientWidth);
          dom.scrollLeft = Math.min(target.scrollLeft, maxScrollLeft);
          target.scrollLeft = 0;
        }
        if (target.scrollTop === 0 && target.scrollLeft === 0) {
          pendingDeferredScrollRef.current = null;
        }
      }
    }
    // ED-IMPROVE-007: capture caret/selection/scroll/fold changes for
    // this leaf/file; persisted later with the layout snapshot.
    if (
      update.selectionSet
      || update.docChanged
      || update.viewportChanged
      || update.transactions.some((tr) => tr.effects.some(
        (effect) => effect.is(foldEffect) || effect.is(unfoldEffect),
      ))
    ) {
      scheduleViewStateEmit(update.view, update.docChanged ? 250 : 150);
    }
  });
}
