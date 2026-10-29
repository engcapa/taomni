import { shallow } from "zustand/shallow";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type CodeWorkspaceInstanceUi } from "../../../stores/codeWorkspaceStore";

export type WorkspaceRenderUi = Omit<CodeWorkspaceInstanceUi, "treeSelection">;
type State = ReturnType<typeof useCodeWorkspaceStore.getState>;

/** Tree selection paints its own pane; editor state still updates synchronously. */
export function createWorkspaceRenderUiSelector(instanceId: string) {
  let previous: CodeWorkspaceInstanceUi | undefined;
  let snapshot: WorkspaceRenderUi | undefined;
  return (state: State): WorkspaceRenderUi => {
    const ui = selectCodeWorkspaceUi(state, instanceId);
    if (previous === ui && snapshot) return snapshot;
    const { treeSelection: _selection, ...next } = ui;
    if (!snapshot || !shallow(snapshot, next)) snapshot = next;
    previous = ui;
    return snapshot;
  };
}

export function readWorkspaceTreeSelection(instanceId: string) {
  return selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId).treeSelection;
}
