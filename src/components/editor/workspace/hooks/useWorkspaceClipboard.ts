import { useEffect, useMemo, useSyncExternalStore } from "react";
import { acquireClipboardStore, createDefaultClipboardPermissionAdapter } from "../workspaceClipboardSession";
import { WorkspaceObservationBridge } from "../workspaceObservationBridge";


export interface UseWorkspaceClipboardContext {
  workspaceInstanceId: string;
  publishWorkspaceObservation: (update: (bridge: WorkspaceObservationBridge) => void) => void;
}

export function useWorkspaceClipboard(context: UseWorkspaceClipboardContext) {
  const { workspaceInstanceId, publishWorkspaceObservation } = context;

  // §8.26.2 AA1: Root workspace clipboard session handle with permission adapter (§8.27.2 BB1 / ED-CLIP-002)
  const clipboardHandle = useMemo(() => acquireClipboardStore(workspaceInstanceId), [workspaceInstanceId]);
  const clipboardSnapshot = useSyncExternalStore(
    clipboardHandle.subscribe,
    clipboardHandle.getSnapshot,
    clipboardHandle.getSnapshot,
  );
  useEffect(() => {
    const observeClipboard = (snapshot: typeof clipboardSnapshot) => {
      publishWorkspaceObservation((bridge) => {
        bridge.observeClipboardSession(snapshot.payloadRevision, snapshot.consumerCount);
      });
    };
    const unsubscribe = clipboardHandle.subscribe(observeClipboard);
    observeClipboard(clipboardHandle.getSnapshot());
    return unsubscribe;
  }, [clipboardHandle, publishWorkspaceObservation]);
  useEffect(() => {
    const detachAdapter = clipboardHandle.attachPermissionAdapter(createDefaultClipboardPermissionAdapter());
    return () => {
      detachAdapter();
      clipboardHandle.release();
    };
  }, [clipboardHandle]);
  return { clipboardHandle, clipboardSnapshot };
}
