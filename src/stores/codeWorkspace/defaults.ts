import { readCodeWorkspaceTreeViewMode } from "../../components/editor/workspace/codeWorkspaceModel";
import { createSingleLeafLayout } from "../../components/editor/workspace/recursiveLayoutTree";
import { type CodeWorkspaceEditorGroupState, type CodeWorkspaceInstanceUi, DEFAULT_SHELL_CHROME_STATE, type EditorGroupId } from "./model";

export function createEditorGroup(id: EditorGroupId): CodeWorkspaceEditorGroupState {
  return { id, openOrder: [], activeKey: null, previewKey: null, pinnedKeys: [] };
}

export function createDefaultCodeWorkspaceUi(): CodeWorkspaceInstanceUi {
  return {
    languagePanelOpen: true,
    bottomDockOpen: false,
    bottomDockTab: "problems",
    debugSubTab: "debugger",
    rightPaneOpen: false,
    rightPaneTab: "outline",
    shellChromeState: {
      ...DEFAULT_SHELL_CHROME_STATE,
      bottomHeightByTool: { ...DEFAULT_SHELL_CHROME_STATE.bottomHeightByTool },
    },
    searchEverywhereOpen: false,
    searchEverywhereMode: "files",
    recentFilesOpen: false,
    recentAdvanceNonce: 0,
    recentEntries: [],
    structureOpen: false,
    structureLoading: false,
    structureUnavailable: null,
    structureSymbols: [],
    quickDocOpen: false,
    quickDocContent: null,
    pinnedDoc: null,
    pinnedDocLocked: false,
    locationPeek: null,
    searchFocusNonce: 0,
    searchIncludePreset: { value: "", nonce: 0 },
    searchQueryPreset: { value: "", nonce: 0 },
    openOrder: [],
    activeKey: null,
    editorGroups: {
      primary: createEditorGroup("primary"),
      secondary: createEditorGroup("secondary"),
    },
    activeEditorGroupId: "primary",
    splitOrientation: null,
    layoutTreeV2: createSingleLeafLayout("primary", [], null),
    markdownModes: {},
    layoutRevision: 0,
    treeFilter: "",
    treeViewMode: readCodeWorkspaceTreeViewMode(),
    expandedRootIds: [],
    expandedDirKeys: [],
    treeSelection: null,
    openFiles: {},
    lspFiles: {},
  };
}

/** Stable fallback so React/zustand getSnapshot does not allocate every render. */
export const EMPTY_UI: CodeWorkspaceInstanceUi = createDefaultCodeWorkspaceUi();
