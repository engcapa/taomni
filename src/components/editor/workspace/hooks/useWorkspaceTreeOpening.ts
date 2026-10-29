import { useCallback, useEffect, useRef } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef } from "../../../../types";
import { fileKey } from "../codeWorkspaceModel";
import { type TreeOpenIntent } from "../controller/mutationTypes";
import { useWorkspaceBufferStore } from "./useWorkspaceBufferStore";
import { useWorkspaceEditorCommands } from "./useWorkspaceEditorCommands";
import { useWorkspaceTreeFocusState } from "./useWorkspaceTreeFocusState";


export interface UseWorkspaceTreeOpeningContext {
  treeFocus: ReturnType<typeof useWorkspaceTreeFocusState>;
  workspaceInstanceId: string;
  editorCommands: ReturnType<typeof useWorkspaceEditorCommands>;
  buffers: ReturnType<typeof useWorkspaceBufferStore>;
  splitLayoutLeaf: ReturnType<typeof useCodeWorkspaceStore.getState>["splitLayoutLeaf"];
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
}

export function useWorkspaceTreeOpening(context: UseWorkspaceTreeOpeningContext) {
  const { treeFocus, workspaceInstanceId, editorCommands, buffers, splitLayoutLeaf, openFile } = context;
  const pendingFocusFrame = useRef<{ id: number; requestId: number; key: string } | null>(null);
  const readScopeRef = useRef<object | null>(null);

  useEffect(() => {
    readScopeRef.current = {};
    return () => { readScopeRef.current = null; };
  }, [workspaceInstanceId]);

  const grantTreeFocus = useCallback((intent: TreeOpenIntent, canonicalKey: string): boolean => {
    if (intent.canonicalFileKey !== canonicalKey) return false;
    if (treeFocus.pendingTreeOpenIntentRef.current?.requestId !== intent.requestId) {
      return false;
    }
    if (treeFocus.treeInteractionEpochRef.current !== intent.interactionEpoch) {
      treeFocus.pendingTreeOpenIntentRef.current = null;
      return false;
    }
    const store = useCodeWorkspaceStore.getState();
    const currentUi = selectCodeWorkspaceUi(store, workspaceInstanceId);
    if (currentUi.activeEditorGroupId !== intent.groupId) {
      return false;
    }
    if (currentUi.editorGroups[intent.groupId]?.activeKey !== canonicalKey) {
      return false;
    }
    const active = document.activeElement;
    if (active && active instanceof HTMLElement) {
      if (active.matches("input, textarea, select, [contenteditable='true']") && !active.closest(".cm-editor")) {
        treeFocus.pendingTreeOpenIntentRef.current = null;
        return false;
      }
    }
    const owner = editorCommands.editorCommandOwnerFor(intent.groupId, canonicalKey);
    if (owner && owner.fileKey === canonicalKey && owner.port.focus) {
      const focused = owner.port.focus({ preventScroll: true });
      if (focused) {
        treeFocus.pendingTreeOpenIntentRef.current = null;
        return true;
      }
    }
    return false;
  }, [workspaceInstanceId]);

  const tryGrantTreeFocus = useCallback((intent: TreeOpenIntent, canonicalKey: string): boolean => {
    // A loading editor can register a port before its disk read completes.
    // Only the completed open establishes the canonical document to focus.
    if (intent.canonicalFileKey !== canonicalKey) return false;
    if (treeFocus.pendingTreeOpenIntentRef.current?.requestId !== intent.requestId) return false;
    const pending = pendingFocusFrame.current;
    if (pending?.requestId === intent.requestId && pending.key === canonicalKey) return false;
    if (pending) window.cancelAnimationFrame(pending.id);
    // Port registration runs with React's mount effects. Let CodeMirror's
    // already queued measurement run first, instead of forcing layout of an
    // unfinished editor and its ancestors inside that same interaction task.
    const id = window.requestAnimationFrame(() => {
      pendingFocusFrame.current = null;
      grantTreeFocus(intent, canonicalKey);
    });
    pendingFocusFrame.current = { id, requestId: intent.requestId, key: canonicalKey };
    return false;
  }, [grantTreeFocus]);

  useEffect(() => {
    treeFocus.tryGrantTreeFocusRef.current = tryGrantTreeFocus;
    return () => {
      if (pendingFocusFrame.current) window.cancelAnimationFrame(pendingFocusFrame.current.id);
      pendingFocusFrame.current = null;
    };
  }, [tryGrantTreeFocus]);

  const requestTreeOpen = useCallback(async (
    ref: CodeWorkspaceFileRef,
    options: {
      targetGroupId?: EditorGroupId;
      split?: boolean;
      preview?: boolean;
    } = {},
  ) => {
    buffers.flushPendingEditorText();
    treeFocus.treeInteractionEpochRef.current += 1;
    const epoch = treeFocus.treeInteractionEpochRef.current;
    const requestId = ++treeFocus.treeOpenRequestIdRef.current;
    const readScope = readScopeRef.current;

    const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    let targetGroupId = options.targetGroupId ?? currentUi.activeEditorGroupId;

    if (options.split) {
      splitLayoutLeaf(workspaceInstanceId, currentUi.activeEditorGroupId, "vertical");
      const nextUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      targetGroupId = nextUi.activeEditorGroupId !== currentUi.activeEditorGroupId
        ? nextUi.activeEditorGroupId
        : currentUi.activeEditorGroupId;
    }

    const reqKey = fileKey(ref);
    const intent: TreeOpenIntent = {
      workspaceInstanceId,
      groupId: targetGroupId,
      requestedFileKey: reqKey,
      interactionEpoch: epoch,
      requestId,
    };
    treeFocus.pendingTreeOpenIntentRef.current = intent;

    const result = await openFile(ref, {
      groupId: targetGroupId,
      preview: options.preview ?? false,
      // Relinquishing focus (for example, to a search input) must not discard
      // a successful read and strand its published loading buffer.
      isCurrent: () => readScope !== null && readScopeRef.current === readScope
        && treeFocus.treeOpenRequestIdRef.current === requestId,
    });

    if (treeFocus.pendingTreeOpenIntentRef.current?.requestId !== requestId) {
      return;
    }
    if (!result || result.error) {
      treeFocus.pendingTreeOpenIntentRef.current = null;
      return;
    }

    intent.canonicalFileKey = result.canonicalFileKey;
    tryGrantTreeFocus(intent, result.canonicalFileKey);
  }, [buffers.flushPendingEditorText, openFile, splitLayoutLeaf, tryGrantTreeFocus, workspaceInstanceId]);
  return { requestTreeOpen };
}
