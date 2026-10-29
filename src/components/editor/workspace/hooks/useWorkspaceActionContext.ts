import { useCallback, useMemo } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { WorkspaceActionContext } from "../workspaceActionRegistry";
import type { useWorkspaceEditorCommands } from "./useWorkspaceEditorCommands";

interface Dependencies {
  workspaceInstanceId: string;
  activeKey: string | null;
  activeEditorGroupId: string;
  activeFilePath?: string;
  modalOpen: boolean;
  editorCommands: Pick<ReturnType<typeof useWorkspaceEditorCommands>, "activeEditorCommandState" | "subscribeEditorCommandContext">;
}

/** Dispatch reads the live editor; immutable menu snapshots update separately. */
export function useWorkspaceActionContext({
  workspaceInstanceId, activeKey, activeEditorGroupId, activeFilePath, modalOpen, editorCommands,
}: Dependencies) {
  const { activeEditorCommandState, subscribeEditorCommandContext } = editorCommands;
  const getContextData = useCallback((): Partial<WorkspaceActionContext> => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const editorState = activeEditorCommandState();
    return {
      activeFileKey: ui.activeKey ?? undefined,
      activeFilePath: ui.openFiles[ui.activeKey ?? ""]?.path,
      editorViewId: editorState ? ui.activeEditorGroupId : undefined,
      hasActiveFile: !!editorState,
      hasSelection: editorState?.hasSelection ?? false,
      readOnly: editorState?.readOnly ?? false,
      editorComposing: editorState?.composing ?? false,
      editorCaretCount: editorState?.caretCount ?? 0,
      editorOccurrenceSessionActive: editorState?.occurrenceSessionActive ?? false,
      ...(modalOpen ? { modalOpen: true } : {}),
    };
  }, [workspaceInstanceId, activeEditorCommandState, modalOpen]);
  const contextData = useMemo(() => getContextData(), [
    getContextData, activeKey, activeEditorGroupId, activeFilePath,
  ]);
  return { contextData, getContextData, subscribeContextChanges: subscribeEditorCommandContext };
}
