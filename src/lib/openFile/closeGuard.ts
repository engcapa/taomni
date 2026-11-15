import { useDocumentStore } from "../../stores/documentStore";
import { documentPathKey } from "./pathIdentity";

/** Synchronous store removal APIs defer the actual mutation until the shared
 * document owner has explicitly saved or discarded every dirty document. */
export function guardViewerClose(paths: string[], proceed: () => void, cancel?: () => void): void {
  const store = useDocumentStore.getState();
  const dirty = [...new Set(paths)].filter((path) => store.documents[documentPathKey(path)]?.dirty);
  if (!dirty.length) { proceed(); return; }
  if (store.closeRequest) { cancel?.(); return; }
  useDocumentStore.setState({ closeRequest: { paths: dirty, proceed, cancel } });
}
export function confirmViewerExit(): Promise<boolean> {
  const store = useDocumentStore.getState();
  store.flushDrafts();
  return new Promise((resolve) => guardViewerClose(Object.values(store.documents).filter((document) => document.dirty).map((document) => document.path),
    () => resolve(true), () => resolve(false)));
}
