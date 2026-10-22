import type { LocationPeekState } from "../../components/editor/workspace/LocationPeek";
import type { RecentFileEntry } from "../../components/editor/workspace/RecentFilesPopup";
import type { SearchEverywhereMode } from "../../components/editor/workspace/SearchEverywhere";
import type { LspFileState, OpenFileState, TreeSelection, TreeViewMode } from "../../components/editor/workspace/codeWorkspaceModel";
import { type LayoutNode } from "../../components/editor/workspace/recursiveLayoutTree";
import type { QuickDocContent } from "../../components/editor/workspace/referenceDocumentation";
import type { AnyWorkspaceTabPolicy } from "../../components/editor/workspace/workspaceTabPolicy";
import type { LspDocumentSymbol } from "../../lib/editor/lsp";

export type BottomDockTabId =
  | "problems"
  | "analysis"
  | "search"
  | "structural"
  | "references"
  | "call-hierarchy"
  | "type-hierarchy"
  | "todos"
  | "terminal"
  | "run"
  | "build"
  | "tests"
  | "coverage"
  | "debug"
  | "git";

export type DebugSubTabId = "debugger" | "console" | "breakpoints" | "memory";

export type EditorGroupId = "primary" | "secondary" | string;

export type EditorSplitOrientation = "horizontal" | "vertical";

export type RightPaneTabId = "outline" | "documentation";

export interface ShellChromeState {
  version: 1;
  projectWidthPx?: number;
  rightWidthPx?: number;
  bottomHeightPx?: number;
  bottomHeightByTool?: Partial<Record<BottomDockTabId, number>>;
}

export const DEFAULT_SHELL_CHROME_STATE: ShellChromeState = {
  version: 1,
  projectWidthPx: 452,
  rightWidthPx: 280,
  bottomHeightPx: 323,
  bottomHeightByTool: {
    problems: 449,
    run: 323,
  },
};

export interface CodeWorkspaceEditorGroupState {
  id: EditorGroupId;
  openOrder: string[];
  activeKey: string | null;
  previewKey: string | null;
  pinnedKeys: string[];
}

export type CodeWorkspaceFileKeyChanges = Record<string, string | null>;

export interface CodeWorkspaceFileStateReplacement {
  openFiles: Record<string, OpenFileState>;
  lspFiles: Record<string, LspFileState>;
  /** Old key -> new key, or null when a resource operation removed the file. */
  keyChanges: CodeWorkspaceFileKeyChanges;
}

/**
 * Per-workspace-instance UI / chrome + open buffers / LSP file map.
 * Keyed by workspaceInstanceId so multiple workspace tabs stay isolated.
 *
 * Directory listing caches (directories/compact/flat) stay in the shell until
 * a later extract; expand keys and buffer text live here.
 */
export interface CodeWorkspaceInstanceUi {
  languagePanelOpen: boolean;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  debugSubTab: DebugSubTabId;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  shellChromeState: ShellChromeState;
  searchEverywhereOpen: boolean;
  searchEverywhereMode: SearchEverywhereMode;
  recentFilesOpen: boolean;
  recentAdvanceNonce: number;
  recentEntries: RecentFileEntry[];
  structureOpen: boolean;
  structureLoading: boolean;
  structureUnavailable: string | null;
  structureSymbols: LspDocumentSymbol[];
  quickDocOpen: boolean;
  quickDocContent: QuickDocContent | null;
  pinnedDoc: QuickDocContent | null;
  pinnedDocLocked: boolean;
  locationPeek: LocationPeekState | null;
  searchFocusNonce: number;
  searchIncludePreset: { value: string; nonce: number; };
  searchQueryPreset: { value: string; nonce: number; };
  openOrder: string[];
  activeKey: string | null;
  editorGroups: Record<EditorGroupId, CodeWorkspaceEditorGroupState>;
  activeEditorGroupId: EditorGroupId;
  splitOrientation: EditorSplitOrientation | null;
  /** Recursive layout tree v2 schema (A2); every instance owns a valid tree. */
  layoutTreeV2: LayoutNode;
  markdownModes: Record<string, "edit" | "preview" | "split">;
  /** Project tree chrome */
  treeFilter: string;
  treeViewMode: TreeViewMode;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  treeSelection: TreeSelection | null;
  /** Open editor buffers keyed by fileKey(ref). */
  /** Monotonic layout revision (§8.26.3 AA2 / ED-TABS-001) incremented on every layout mutation. */
  layoutRevision: number;
  openFiles: Record<string, OpenFileState>;
  /** Per-open-file LSP sync/diagnostics map. */
  lspFiles: Record<string, LspFileState>;
}

export type Updater<T> = T | ((prev: T) => T);

export interface CodeWorkspaceStoreState {
  byInstanceId: Record<string, CodeWorkspaceInstanceUi>;
  ensureInstance: (instanceId: string) => void;
  disposeInstance: (instanceId: string) => void;
  getInstance: (instanceId: string) => CodeWorkspaceInstanceUi;
  patchInstance: (instanceId: string, patch: Partial<CodeWorkspaceInstanceUi>) => void;
  setActiveKey: (instanceId: string, key: string | null) => void;
  setOpenOrder: (instanceId: string, order: string[]) => void;
  updateEditorGroup: (
    instanceId: string,
    groupId: EditorGroupId,
    updater: Updater<CodeWorkspaceEditorGroupState>,
  ) => void;
  setActiveEditorGroup: (instanceId: string, groupId: EditorGroupId) => void;
  setSplitOrientation: (instanceId: string, orientation: EditorSplitOrientation | null) => void;
  setLayoutTreeV2: (instanceId: string, layoutTree: LayoutNode) => void;
  setLayoutNodeRatios: (instanceId: string, splitId: string, ratios: number[]) => void;
  /** §8.19.6: even out the ratios of the split directly containing the leaf. */
  equalizeLayoutRatios: (instanceId: string, leafId: string) => void;
  /** §8.19.6: grow the leaf's share inside its parent split (repeatable, capped). */
  stretchLayoutLeaf: (
    instanceId: string,
    leafId: string,
    options?: { step?: number; max?: number; },
  ) => void;
  /** §8.19.6: collapse every split into the first leaf, migrating all tabs. */
  unsplitAllLayout: (instanceId: string) => void;
  splitLayoutLeaf: (
    instanceId: string,
    leafId: string,
    orientation: "horizontal" | "vertical",
    newFileKey?: string,
  ) => void;
  closeLayoutLeaf: (instanceId: string, leafId: string) => void;
  moveLayoutTab: (
    instanceId: string,
    sourceLeafId: string,
    targetLeafId: string,
    fileKey: string,
  ) => void;
  setLeafActiveTab: (instanceId: string, leafId: string, fileKey: string | null) => void;
  closeLayoutTabInLeaf: (
    instanceId: string,
    leafId: string,
    fileKey: string,
    policy?: AnyWorkspaceTabPolicy,
    lastUsedByKey?: ReadonlyMap<string, number>,
  ) => void;
  setMarkdownMode: (instanceId: string, fileKey: string, mode: "edit" | "preview" | "split") => void;
  replaceFileState: (instanceId: string, replacement: CodeWorkspaceFileStateReplacement) => void;
  /** Explicitly increment monotonic layout revision (§8.26.3 AA2 / ED-TABS-001). */
  bumpLayoutRevision: (instanceId: string) => number;
  updateOpenFiles: (instanceId: string, updater: Updater<Record<string, OpenFileState>>) => void;
  updateLspFiles: (instanceId: string, updater: Updater<Record<string, LspFileState>>) => void;
  updateExpandedRootIds: (instanceId: string, updater: Updater<string[]>) => void;
  updateExpandedDirKeys: (instanceId: string, updater: Updater<string[]>) => void;
  seedTreeExpandIfEmpty: (instanceId: string, rootIds: string[], dirKeys: string[]) => void;
  setShellChromeState: (instanceId: string, patch: Partial<ShellChromeState>) => void;
  setBottomDockHeightForTool: (instanceId: string, toolId: BottomDockTabId, height: number) => void;
  restoreDefaultToolWindowLayout: (instanceId: string) => void;
}
