import { buildWorkspaceClipboardSnapshot, slotStatesByWorkspace } from "./clipboardSession/lifetime";
import { type WorkspaceClipboardSnapshot } from "./clipboardSession/model";

if (typeof window !== "undefined") {
  (window as unknown as { __taomniClipboardObserve?: (workspaceInstanceId?: string) => unknown; }).__taomniClipboardObserve = (
    workspaceInstanceId?: string,
  ) => {
    if (!workspaceInstanceId) {
      const all: Record<string, WorkspaceClipboardSnapshot> = {};
      for (const [id, slot] of slotStatesByWorkspace) {
        all[id] = buildWorkspaceClipboardSnapshot(slot);
      }
      return all;
    }
    const slot = slotStatesByWorkspace.get(workspaceInstanceId);
    return slot ? buildWorkspaceClipboardSnapshot(slot) : null;
  };
}

export {
  type ClipboardClearReason,
  type ClipboardConsumerLease,
  type ClipboardHistoryExclusion,
  type ClipboardPermissionAdapter,
  type ClipboardPermissionState,
  type EditorClipboardSession,
  type GuardedClipboardIO,
  type GuardedSystemEffect,
  type GuardedSystemReadResult,
  type GuardedSystemWriteResult,
  type NativeClipboardPermissionAdapterOptions,
  type PastePlan,
  type WorkspaceClipboardHandle,
  type WorkspaceClipboardSnapshot,
  type WorkspaceClipboardSnapshotV3,
} from "./clipboardSession/model";

export {
  CLIPBOARD_HISTORY_MAX_ITEM_BYTES,
  CLIPBOARD_HISTORY_MAX_ITEMS,
  CLIPBOARD_HISTORY_MAX_TOTAL_BYTES,
  detectSensitiveClipboardText,
  planPaste,
  WorkspaceClipboardStore,
} from "./clipboardSession/store";

export { createDefaultClipboardPermissionAdapter, createNativeClipboardPermissionAdapter, createWebClipboardPermissionAdapter } from "./clipboardSession/permissions";

export { useWorkspaceClipboardSession, WorkspaceClipboardSessionContext } from "./clipboardSession/context";

export { acquireClipboardStore, clipboardStoreForWorkspace, resetWorkspaceClipboardStores } from "./clipboardSession/lifetime";
