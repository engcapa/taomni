import { create } from "zustand";
import { createWorkspaceChromeActions } from "./codeWorkspace/chrome";
import { EMPTY_UI } from "./codeWorkspace/defaults";
import { createWorkspaceFileActions } from "./codeWorkspace/files";
import { createWorkspaceGroupActions } from "./codeWorkspace/group";
import { createWorkspaceInstanceActions } from "./codeWorkspace/instance";
import { createWorkspaceLayoutActions } from "./codeWorkspace/layout";
import { type CodeWorkspaceInstanceUi, type CodeWorkspaceStoreState } from "./codeWorkspace/model";

export const useCodeWorkspaceStore = create<CodeWorkspaceStoreState>((set, get) => ({
  ...createWorkspaceInstanceActions(set, get),
  ...createWorkspaceGroupActions(set, get),
  ...createWorkspaceLayoutActions(set, get),
  ...createWorkspaceFileActions(set, get),
  ...createWorkspaceChromeActions(set, get),
}));

/** Select one instance UI slice; returns stable defaults when missing. */
export function selectCodeWorkspaceUi(
  state: CodeWorkspaceStoreState,
  instanceId: string,
): CodeWorkspaceInstanceUi {
  return state.byInstanceId[instanceId] ?? EMPTY_UI;
}

export {
  DEFAULT_SHELL_CHROME_STATE,
  type BottomDockTabId,
  type CodeWorkspaceEditorGroupState,
  type CodeWorkspaceFileKeyChanges,
  type CodeWorkspaceFileStateReplacement,
  type CodeWorkspaceInstanceUi,
  type DebugSubTabId,
  type EditorGroupId,
  type EditorSplitOrientation,
  type RightPaneTabId,
  type ShellChromeState,
} from "./codeWorkspace/model";

export { createDefaultCodeWorkspaceUi, createEditorGroup } from "./codeWorkspace/defaults";
