import { useLayoutEffect } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { WorkspaceDocumentTransactionOwner } from "../workspaceDocumentTransactionOwner";

/** Open buffers outlive their views when switching files or rebuilding splits. */
export function useWorkspaceDocumentLifetime(workspaceInstanceId: string, owner: WorkspaceDocumentTransactionOwner) {
  useLayoutEffect(() => {
    let retained = new Set<string>();
    const reconcile = () => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      const next = new Set(Object.keys(ui.openFiles));
      for (const key of next) if (!retained.has(key)) owner.retainDocument(key);
      for (const key of retained) if (!next.has(key)) owner.releaseDocument(key);
      retained = next;
    };
    reconcile();
    // Subscribe at the buffer boundary, before React unmounts a former active
    // view. View leases and their observation counts remain actual views.
    const unsubscribe = useCodeWorkspaceStore.subscribe(reconcile);
    return () => {
      unsubscribe();
      for (const key of retained) owner.releaseDocument(key);
    };
  }, [workspaceInstanceId, owner]);
}
