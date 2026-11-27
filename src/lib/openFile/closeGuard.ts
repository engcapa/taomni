import { useDocumentStore, type ModuleDocumentDraft } from "../../stores/documentStore";
import { documentPathKey } from "./pathIdentity";

const dirtyCloseBypass = new Set<string>();

export function trackModuleDocumentDraft(draft: ModuleDocumentDraft): () => void {
  const key = documentPathKey(draft.path);
  useDocumentStore.setState((state) => ({ moduleDrafts: { ...state.moduleDrafts, [key]: draft } }));
  return () => useDocumentStore.setState((state) => {
    if (state.moduleDrafts[key] !== draft) return state;
    const moduleDrafts = { ...state.moduleDrafts };
    delete moduleDrafts[key];
    return { moduleDrafts };
  });
}

export function viewerHasChanges(path: string, state = useDocumentStore.getState()): boolean {
  const key = documentPathKey(path);
  return Boolean(state.moduleDrafts?.[key] || state.documents[key]?.dirty);
}

export async function saveViewerChanges(path: string): Promise<boolean> {
  const state = useDocumentStore.getState();
  const draft = state.moduleDrafts?.[documentPathKey(path)];
  if (draft) return draft.save();
  await state.save(path);
  return true;
}

export function discardViewerChanges(path: string) {
  const state = useDocumentStore.getState();
  const draft = state.moduleDrafts?.[documentPathKey(path)];
  if (draft) draft.discard();
  else state.discard(path);
}

/** Consume the one-shot bypass while a close action re-enters its store API. */
export function consumeDirtyCloseBypass(path: string): boolean {
  return dirtyCloseBypass.delete(documentPathKey(path));
}

/** Synchronous store removal APIs defer the actual mutation until the shared
 * document owner has explicitly saved or discarded every dirty document. */
export function guardViewerClose(paths: string[], proceed: () => void, cancel?: () => void): void {
  const store = useDocumentStore.getState();
  const dirty = [...new Set(paths)].filter((path) => {
    const key = documentPathKey(path);
    return !dirtyCloseBypass.has(key) && viewerHasChanges(path, store);
  });
  if (!dirty.length) { proceed(); return; }
  if (store.closeRequest) { cancel?.(); return; }
  // The selected close action has already resolved the dirty-document choice.
  // Keep the bypass scoped to the synchronous close callback so a retained
  // draft can close its tab without turning the dialog into a second prompt.
  const guardedProceed = () => {
    const keys = dirty.map(documentPathKey);
    keys.forEach((key) => dirtyCloseBypass.add(key));
    try { proceed(); } finally { keys.forEach((key) => dirtyCloseBypass.delete(key)); }
  };
  useDocumentStore.setState({ closeRequest: { paths: dirty, proceed: guardedProceed, cancel } });
}
export function confirmViewerExit(): Promise<boolean> {
  const store = useDocumentStore.getState();
  store.flushDrafts();
  return new Promise((resolve) => guardViewerClose([...Object.values(store.documents), ...Object.values(store.moduleDrafts ?? {})].map((document) => document.path),
    () => resolve(true), () => resolve(false)));
}
