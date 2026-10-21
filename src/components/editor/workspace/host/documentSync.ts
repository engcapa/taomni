import { ChangeSet, Transaction, type TransactionSpec } from "@codemirror/state";
import { remoteTransactionAnnotation, type DocumentChangeDelta, type DocumentTransaction } from "../workspaceDocumentTransactionOwner";
import { EditorView } from "@codemirror/view";


export function documentReplacementChange(currentText: string, nextText: string): DocumentChangeDelta | null {
  if (currentText === nextText) return null;

  let prefix = 0;
  const maxPrefix = Math.min(currentText.length, nextText.length);
  while (prefix < maxPrefix && currentText[prefix] === nextText[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(currentText.length - prefix, nextText.length - prefix);
  while (
    suffix < maxSuffix
    && currentText[currentText.length - suffix - 1] === nextText[nextText.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const deleted = currentText.slice(prefix, currentText.length - suffix);
  return {
    from: prefix,
    to: currentText.length - suffix,
    insert: nextText.slice(prefix, nextText.length - suffix),
    ...(deleted ? { deleted } : {}),
  };
}


export function applySharedTransactionToView(view: EditorView, transaction: DocumentTransaction): boolean {
  if (transaction.changes.length === 0) return false;
  const changes = transaction.changes.map(({ from, to, insert }) => ({ from, to, insert }));
  let changeSet: ChangeSet;
  try {
    changeSet = ChangeSet.of(changes, view.state.doc.length);
  } catch {
    return false;
  }
  view.dispatch({
    changes,
    selection: transaction.restoreSelection
      && transaction.restoreSelection.anchor >= 0
      && transaction.restoreSelection.head >= 0
      && transaction.restoreSelection.anchor <= changeSet.newLength
      && transaction.restoreSelection.head <= changeSet.newLength
      ? transaction.restoreSelection
      : view.state.selection.map(changeSet),
    scrollIntoView: false,
    annotations: [
      remoteTransactionAnnotation.of(true),
      Transaction.addToHistory.of(false),
    ],
    // ED-AUDIT-002: replayed undo/redo transactions carry the matching
    // userEvent so the virtual-space overflow field can restore the virtual
    // caret on undo and drop it on redo.
    ...(transaction.origin === "undo" || transaction.origin === "redo"
      ? { userEvent: transaction.origin }
      : {}),
  });
  return true;
}


export function applyDocumentSnapshotToView(view: EditorView, nextText: string): boolean {
  const change = documentReplacementChange(view.state.doc.toString(), nextText);
  if (!change) return false;
  const changes = [{ from: change.from, to: change.to, insert: change.insert }];
  let changeSet: ChangeSet;
  try {
    changeSet = ChangeSet.of(changes, view.state.doc.length);
  } catch {
    return false;
  }
  view.dispatch({
    changes,
    selection: view.state.selection.map(changeSet),
    scrollIntoView: false,
    annotations: [
      remoteTransactionAnnotation.of(true),
      Transaction.addToHistory.of(false),
    ],
  } satisfies TransactionSpec);
  return true;
}
