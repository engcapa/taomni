import { trimPendingLocalDocumentEchoes } from "./reconciliation";
import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { applyDocumentSnapshotToView, applySharedTransactionToView } from "./documentSync";


export interface UseDocumentReconciliationContext {
  transactionOwner: import("../workspaceDocumentTransactionOwner").WorkspaceDocumentTransactionOwner | null;
  fileKey: string;
  editorViewId: string;
  viewRef: import("react").RefObject<EditorView | null>;
  doc: string;
  documentRevision: number;
  transactionOwnerRef: import("react").RefObject<import("../workspaceDocumentTransactionOwner").WorkspaceDocumentTransactionOwner | null>;
  fileKeyRef: import("react").RefObject<string>;
  viewIdRef: import("react").RefObject<string>;
  historyReplayRef: import("react").RefObject<boolean>;
}

export function useDocumentReconciliation(context: UseDocumentReconciliationContext) {
  const { transactionOwner, fileKey, editorViewId, viewRef, doc, documentRevision, transactionOwnerRef, fileKeyRef, viewIdRef, historyReplayRef } = context;

  const documentRevisionRef = useRef(documentRevision);
  documentRevisionRef.current = documentRevision;

  /** True while applying a prop-driven doc replace so it is not treated as a user edit. */
  const applyingExternalDocRef = useRef(false);
  /** Mirrors the last full text sent through onChange or applied from props. */
  const lastDocumentTextRef = useRef(doc);
  /** Last controlled prop snapshot; distinguishes stale lag from a real reload. */
  const lastPropDocumentTextRef = useRef(doc);
  /** Local snapshots awaiting a controlled-prop echo, oldest first. */
  const pendingLocalDocumentEchoesRef = useRef<Array<{
    text: string;
    expectedDocumentRevision: number;
  }>>([]);
  const lastLocalDocumentRevisionRef = useRef(documentRevision);
  const rememberLocalDocumentEcho = (text: string): void => {
    const expectedDocumentRevision = Math.max(
      documentRevisionRef.current,
      lastLocalDocumentRevisionRef.current,
    ) + 1;
    lastLocalDocumentRevisionRef.current = expectedDocumentRevision;
    const pendingEchoes = pendingLocalDocumentEchoesRef.current;
    const lastPendingEcho = pendingEchoes[pendingEchoes.length - 1];
    if (
      lastPendingEcho?.text !== text
      || lastPendingEcho.expectedDocumentRevision !== expectedDocumentRevision
    ) {
      pendingEchoes.push({ text, expectedDocumentRevision });
      trimPendingLocalDocumentEchoes(pendingEchoes);
    }
  };

  // Echo revisions and controlled snapshots belong to one document, even
  // when its pane reuses the same EditorView for the next tab.
  const previousFileKeyRef = useRef(fileKey);
  useEffect(() => {
    if (previousFileKeyRef.current === fileKey) return;
    previousFileKeyRef.current = fileKey;
    pendingLocalDocumentEchoesRef.current = [];
    lastLocalDocumentRevisionRef.current = documentRevision;
    lastPropDocumentTextRef.current = doc;
    lastDocumentTextRef.current = viewRef.current?.state.doc.toString() ?? doc;
  }, [fileKey]);


  useEffect(() => {
    const owner = transactionOwner;
    if (!owner || !fileKey) return;

    return owner.subscribe(fileKey, (transaction) => {
      if (transaction.sourceViewId === editorViewId) return;
      const currentView = viewRef.current;
      if (!currentView || !currentView.dom.isConnected) return;
      if (applySharedTransactionToView(currentView, transaction)) {
        lastDocumentTextRef.current = currentView.state.doc.toString();
      }
    });
  }, [transactionOwner, fileKey, editorViewId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previousPropDocument = lastPropDocumentTextRef.current;
    lastPropDocumentTextRef.current = doc;
    const pendingEchoes = pendingLocalDocumentEchoesRef.current;
    lastLocalDocumentRevisionRef.current = Math.max(
      lastLocalDocumentRevisionRef.current,
      documentRevision,
    );
    let localEchoIndex = -1;
    for (let index = pendingEchoes.length - 1;index >= 0;index -= 1) {
      const entry = pendingEchoes[index]!;
      if (
        entry.text === doc
        && entry.expectedDocumentRevision === documentRevision
      ) {
        localEchoIndex = index;
        break;
      }
    }
    if (localEchoIndex >= 0) {
      pendingEchoes.splice(0, localEchoIndex + 1);
      // A recognized echo acknowledges an earlier local transaction. During
      // native character-level input, both the view and shared owner may have
      // advanced again before React delivers this prop. Replacing the live
      // document here can corrupt an in-flight CodeMirror change set; a later
      // non-echo snapshot remains responsible for canonical reconciliation.
      lastDocumentTextRef.current = view.state.doc.toString();
      return;
    }
    while (
      pendingEchoes.length > 0
      && pendingEchoes[0]!.expectedDocumentRevision <= documentRevision
    ) {
      pendingEchoes.shift();
    }

    const owner = transactionOwnerRef.current;
    if (owner && fileKeyRef.current) {
      const canonical = owner.getDocument(fileKeyRef.current);
      if (canonical !== null) {
        const currentText = view.state.doc.toString();
        if (doc === canonical) {
          // The controlled snapshot caught up with the shared owner. If a
          // remote transaction raced this effect, repair only the changed
          // range and preserve the view's selection.
          if (currentText !== canonical) {
            applyingExternalDocRef.current = true;
            try {
              applyDocumentSnapshotToView(view, canonical);
            } finally {
              applyingExternalDocRef.current = false;
            }
          }
          lastDocumentTextRef.current = view.state.doc.toString();
          return;
        }
        if (previousPropDocument !== doc) {
          // A changed prop is an external/store snapshot. Make it one shared
          // transaction so every split sees the same replacement and history
          // remains owned by the canonical document. ED-AUDIT-008: a
          // workspace-history restore is journaled at transaction level, so
          // its reconciliation records no second document-ledger entry —
          // otherwise a follow-up Ctrl+Z would re-apply the undone change.
          const transaction = owner.replaceDocument(
            fileKeyRef.current,
            viewIdRef.current,
            doc,
            historyReplayRef.current ? "undo" : "external-disk",
          );
          if (transaction) {
            applySharedTransactionToView(view, transaction);
            lastDocumentTextRef.current = view.state.doc.toString();
            return;
          }
          // replaceDocument declined (no canonical record, or the record
          // already holds this text). Fall through to the direct snapshot
          // apply below so a programmatic store change still reaches this
          // view instead of being swallowed with a stale document.
        }
        if (currentText === canonical || lastDocumentTextRef.current === canonical) {
          // React may still expose the previous store value while a live
          // editor edit is buffered. The shared owner is authoritative.
          lastDocumentTextRef.current = currentText;
          return;
        }
      }
    }

    if (lastDocumentTextRef.current === doc) {
      return;
    }
    applyingExternalDocRef.current = true;
    try {
      applyDocumentSnapshotToView(view, doc);
      lastDocumentTextRef.current = view.state.doc.toString();
    } finally {
      applyingExternalDocRef.current = false;
    }
  }, [doc, documentRevision, fileKey]);
  return { applyingExternalDocRef, lastDocumentTextRef, rememberLocalDocumentEcho };
}
