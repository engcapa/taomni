import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Braces,
  GitBranch,
  GitCommitHorizontal,
  ListTree,
  GitFork,
  Network,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  BookOpen,
  PanelRight,
  Columns2,
  Rows2,
  TerminalSquare,
  Play,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  workspaceCreateDir,
  workspaceCreateFile,
  workspaceDeletePath,
  workspaceDetectGitRoots,
  workspaceReadFile,
  workspaceReadLooseFile,
  workspaceRenamePath,
  workspaceWriteFile,
  workspaceWriteLooseFile,
  type WorkspaceGitRoot,
} from "../../lib/editor/workspace";
import {
  gitBlameLines,
  gitBlobPair,
  gitSnapshot,
  type GitBlameLine,
  type GitChange,
} from "../../lib/git";
import { notifyGitRepoChanged, subscribeGitRepoRefresh } from "../../lib/gitRefresh";
import {
  lspCodeActions,
  lspCompletion,
  lspCompletionResolve,
  lspDocumentSymbols,
  lspDocumentHighlights,
  lspFormatting,
  lspDefinition,
  lspHover,
  lspImplementation,
  lspInlayHints,
  lspPrepareCallHierarchy,
  lspPrepareRename,
  lspPrepareTypeHierarchy,
  lspRangeFormatting,
  lspReferences,
  lspRename,
  lspSelectionRanges,
  lspSignatureHelp,
  lspTypeDefinition,
  lspWorkspaceSymbols,
  type LspCodeAction,
  type LspCompletionItem,
  type LspCompletionResult,
  type LspDiagnostic,
  type LspDocumentSymbol,
  type LspDocumentHighlight,
  type LspInlayHint,
  type LspLocation,
  type LspPosition,
  type LspRange,
  type LspSignatureHelpResult,
  type LspWorkspaceEdit,
} from "../../lib/editor/lsp";
import { invoke } from "@tauri-apps/api/core";
import { selectFilePath, selectFolderPath } from "../../lib/ipc";
import {
  DEFAULT_CODE_VIEW_PROFILE,
  applyCodeViewProfile,
  loadCodeViewProfile,
  normalizeCodeViewProfile,
  sameCodeViewProfile,
  saveCodeViewProfile,
  subscribeCodeViewProfile,
  type CodeViewProfile,
} from "../../lib/codeViewProfile";
import { DEFAULT_TERMINAL_PROFILE } from "../../lib/terminalProfile";
import { useAppStore } from "../../stores/appStore";
import {
  selectCodeWorkspaceUi,
  useCodeWorkspaceStore,
  type BottomDockTabId,
  type CodeWorkspaceEditorGroupState,
  type EditorGroupId,
  type EditorSplitOrientation,
  type RightPaneTabId,
} from "../../stores/codeWorkspaceStore";
import {
  detectWorkspaceEol,
  useCodeWorkspaceStatusStore,
} from "../../stores/codeWorkspaceStatusStore";
import { historySnapshot } from "../../lib/localHistory";
import {
  fileRefFromFileKey,
  layoutSnapshotHasOpenFiles,
  readWorkspaceLayoutSnapshot,
  snapshotFromWorkspaceUi,
  uniqueOrderedKeys,
  writeWorkspaceLayoutSnapshot,
} from "./workspace/workspaceLayoutPersistence";
import { LocalHistoryDialog } from "./workspace/LocalHistoryDialog";
import { EditorSelectionAiToolbar, type EditorAiAction } from "./workspace/EditorSelectionAiToolbar";
import { EditorAiRewriteDialog } from "./workspace/EditorAiRewriteDialog";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { writeText } from "../../lib/clipboard";
import { useContextMenu } from "../ContextMenu";
import { useChatStore } from "../../stores/chatStore";
import { type EditorSelectionRange } from "./workspace/CodeMirrorHost";
import { fallbackWordHighlights } from "./workspace/lspIntelligenceChrome";
import {
  inlayHintsEnabledForLanguage,
  readWorkspaceIntelligencePreferences,
  writeWorkspaceIntelligencePreferences,
  type WorkspaceIntelligencePreferences,
} from "./workspace/intelligencePreferences";
import { applyLspTextEditsToString } from "./workspace/lspTextEdits";
import {
  applyWorkspaceEdit,
  summarizeWorkspaceEditOutcomes,
} from "./workspace/workspaceEditApply";
import { buildReplaceWorkspaceEdit } from "./workspace/buildReplaceEdits";
import { BottomDock } from "./workspace/panels/BottomDock";
import {
  ReferencesPanel,
  type ReferencesResultState,
} from "./workspace/panels/ReferencesPanel";
import {
  ProblemsPanel,
  type ProblemFileGroup,
} from "./workspace/panels/ProblemsPanel";
import { FindInFilesPanel } from "./workspace/panels/FindInFilesPanel";
import { DocumentationPane } from "./workspace/panels/DocumentationPane";
import {
  HierarchyPanel,
  type HierarchyRootState,
} from "./workspace/panels/HierarchyPanel";
import { type QuickDocContent } from "./workspace/QuickDocPopup";
import { type LocationPeekState } from "./workspace/LocationPeek";
import {
  type GoToFileItem,
  type GoToSymbolItem,
  type SearchEverywhereMode,
} from "./workspace/SearchEverywhere";
import { type RecentFileEntry } from "./workspace/RecentFilesPopup";
import { createDoubleShiftDetector } from "./workspace/doubleShift";
import { EditorGroup } from "./workspace/EditorGroup";
import { WorkspacePopupsHost } from "./workspace/WorkspacePopupsHost";
import { FileTreePane } from "./workspace/FileTreePane";
import { ProjectTree } from "./workspace/ProjectTree";
import { MarkdownPreview } from "./workspace/MarkdownPreview";
import { IconButton, LspStatusPill } from "./workspace/workspaceChrome";
import { OutlinePane } from "./workspace/OutlinePane";
import { buildGitLineChanges, type GitLineChange } from "./workspace/gitEditorChrome";
import {
  dispatchWorkspaceCommandKeydown,
  runWorkspaceCommand,
  workspaceCommandEnabled,
  workspaceCommandMenuItems,
  type WorkspaceCommand,
  type WorkspaceCommandContext,
  type WorkspaceCommandFocus,
  type WorkspaceCommandRegistration,
} from "./workspace/workspaceCommands";
import type { WorkspaceSearchMatch } from "../../lib/editor/workspaceSearch";
import type {
  CodeWorkspaceFileRef,
  CodeWorkspaceLooseFileInfo,
  CodeWorkspaceRootInfo,
  CodeWorkspaceTabInfo,
} from "../../types";

interface CodeWorkspaceTabProps {
  tabId: string;
  workspace: CodeWorkspaceTabInfo;
  visible?: boolean;
  onOpenGitManager?: (payload: CodeWorkspaceGitManagerPayload) => void;
  onSyncGitManager?: (payload: CodeWorkspaceGitManagerPayload) => void;
  onCommandsChange?: (tabId: string, registration: WorkspaceCommandRegistration | null) => void;
}

export interface CodeWorkspaceGitManagerPayload {
    workspaceName: string;
    workspaceInstanceId?: string;
    workspaceId?: string;
    roots: WorkspaceGitRoot[];
    activeRepoRoot: string | null;
}

function breadcrumbSegmentsForFile(
  file: OpenFileState,
  roots: CodeWorkspaceRootInfo[],
): BreadcrumbPathSegment[] {
  if (file.ref.kind === "root") {
    const rootId = file.ref.rootId;
    const root = roots.find((candidate) => candidate.id === rootId);
    if (!root) return [{ label: file.title, path: file.ref.path, kind: "file" }];
    const parts = file.ref.path.split("/").filter(Boolean);
    let path = "";
    return [
      { label: root.name, path: "", kind: "root" },
      ...parts.map((part, index): BreadcrumbPathSegment => {
        path = path ? `${path}/${part}` : part;
        return { label: part, path, kind: index === parts.length - 1 ? "file" : "directory" };
      }),
    ];
  }
  const normalized = normalizeFsPath(file.ref.path);
  const parts = normalized.split("/").filter(Boolean);
  let path = normalized.startsWith("/") ? "/" : "";
  return parts.map((part, index): BreadcrumbPathSegment => {
    path = path === "/" ? `/${part}` : path ? `${path}/${part}` : part;
    return { label: part, path, kind: index === parts.length - 1 ? "file" : "directory" };
  });
}

function initialInlayHintRange(text: string): LspRange {
  const lines = text.split("\n");
  const endLine = Math.min(Math.max(lines.length - 1, 0), 199);
  return {
    start: { line: 0, character: 0 },
    end: { line: endLine, character: lines[endLine]?.length ?? 0 },
  };
}

import {
  type LspFileState,
  type MarkdownViewMode,
  type OpenFileState,
  type TreeSelection,
  type TreeViewMode,
  type WorkspaceGitSnapshotState,
  type WorkspaceTreeCommandPayload,
  CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE,
  CODE_WORKSPACE_MAX_FONT_SIZE,
  CODE_WORKSPACE_MAX_TREE_FONT_SIZE,
  CODE_WORKSPACE_MIN_FONT_SIZE,
  CODE_WORKSPACE_MIN_TREE_FONT_SIZE,
  CUSTOM_LSP_COMMAND_ID,
  NAV_HISTORY_LIMIT,
  RECENT_FILES_LIMIT,
  absoluteWorkspacePath,
  basename,
  clampCodeWorkspaceFontSize,
  clampCodeWorkspaceTreeFontSize,
  emptyLspFileState,
  errorMessage,
  fileKey,
  fileMeta,
  fileRefUnder,
  formatBytes,
  formatMtime,
  gitRootForWorkspacePath,
  gitPathForWorkspacePath,
  gitRootsForWorkspaceRoot,
  initialFileRef,
  initialLooseFiles,
  initialRoots,
  isExternalHref,
  isMarkdownPath,
  joinRelativePath,
  makeLoadingFile,
  makeLooseFile,
  makeRoot,
  normalizeFsPath,
  parentPath,
  readCodeWorkspaceTreeFontSize,
  relativePathWithinRoot,
  remapFileRef,
  remapRelativePath,
  resolveLooseMarkdownLink,
  resolveRootMarkdownLink,
  rootDirKey,
  shouldHideEntry,
  workspacePathForGitPath,
  workspaceTitle,
  writeCodeWorkspaceTreeFontSize,
  writeCodeWorkspaceTreeViewMode,
} from "./workspace/codeWorkspaceModel";
import { useWorkspaceTreeData } from "./workspace/useWorkspaceTreeData";
import { useWorkspaceLspSession } from "./workspace/useWorkspaceLspSession";
import { Breadcrumbs, type BreadcrumbPathSegment } from "./workspace/Breadcrumbs";
import {
  TerminalDockPanel,
  type TerminalDockHandle,
} from "./workspace/panels/TerminalDockPanel";
import { RunPanel, type RunPanelHandle } from "./workspace/panels/RunPanel";
import type { EditorRevealTarget } from "./workspace/EditorGroup";

export function CodeWorkspaceTab({
  tabId,
  workspace,
  visible = true,
  onOpenGitManager,
  onSyncGitManager,
  onCommandsChange,
}: CodeWorkspaceTabProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setTabCodeWorkspaceContext = useAppStore((s) => s.setTabCodeWorkspaceContext);
  const setWorkspaceStatusSegments = useCodeWorkspaceStatusStore((s) => s.setStatus);
  const setWorkspaceStatusActions = useCodeWorkspaceStatusStore((s) => s.setActions);
  const clearWorkspaceStatus = useCodeWorkspaceStatusStore((s) => s.clearForTab);
  const attachToComposer = useChatStore((s) => s.attachToComposer);
  const workspaceInstanceId = useMemo(
    () => workspace.workspaceInstanceId ?? workspace.workspaceId ?? workspace.repoRoot?.trim() ?? tabId,
    [tabId, workspace.repoRoot, workspace.workspaceId, workspace.workspaceInstanceId],
  );
  const ensureWorkspaceUi = useCodeWorkspaceStore((s) => s.ensureInstance);
  const disposeWorkspaceUi = useCodeWorkspaceStore((s) => s.disposeInstance);
  const patchWorkspaceUi = useCodeWorkspaceStore((s) => s.patchInstance);
  const setStoreActiveKey = useCodeWorkspaceStore((s) => s.setActiveKey);
  const setStoreOpenOrder = useCodeWorkspaceStore((s) => s.setOpenOrder);
  const updateStoreOpenFiles = useCodeWorkspaceStore((s) => s.updateOpenFiles);
  const updateStoreLspFiles = useCodeWorkspaceStore((s) => s.updateLspFiles);
  const updateStoreExpandedRootIds = useCodeWorkspaceStore((s) => s.updateExpandedRootIds);
  const updateStoreExpandedDirKeys = useCodeWorkspaceStore((s) => s.updateExpandedDirKeys);
  const updateStoreEditorGroup = useCodeWorkspaceStore((s) => s.updateEditorGroup);
  const setStoreActiveEditorGroup = useCodeWorkspaceStore((s) => s.setActiveEditorGroup);
  const setStoreSplitOrientation = useCodeWorkspaceStore((s) => s.setSplitOrientation);
  const seedTreeExpandIfEmpty = useCodeWorkspaceStore((s) => s.seedTreeExpandIfEmpty);
  // Ensure before first read so the selector always hits a real map entry.
  ensureWorkspaceUi(workspaceInstanceId);
  const workspaceUi = useCodeWorkspaceStore((s) => selectCodeWorkspaceUi(s, workspaceInstanceId));

  useEffect(() => {
    ensureWorkspaceUi(workspaceInstanceId);
    return () => disposeWorkspaceUi(workspaceInstanceId);
  }, [disposeWorkspaceUi, ensureWorkspaceUi, workspaceInstanceId]);

  // Restore chrome/layout once per instance, then seed expand keys only when empty.
  const layoutHydratedRef = useRef<string | null>(null);
  const layoutRestoredOpenFilesRef = useRef(false);
  useEffect(() => {
    if (layoutHydratedRef.current === workspaceInstanceId) return;
    layoutHydratedRef.current = workspaceInstanceId;
    layoutRestoredOpenFilesRef.current = false;
    const snapshot = readWorkspaceLayoutSnapshot(workspaceInstanceId);
    if (snapshot) {
      patchWorkspaceUi(workspaceInstanceId, {
        bottomDockOpen: snapshot.bottomDockOpen,
        bottomDockTab: snapshot.bottomDockTab,
        rightPaneOpen: snapshot.rightPaneOpen,
        rightPaneTab: snapshot.rightPaneTab,
        languagePanelOpen: snapshot.languagePanelOpen,
        splitOrientation: snapshot.splitOrientation,
        activeEditorGroupId: snapshot.activeEditorGroupId,
        expandedRootIds: snapshot.expandedRootIds,
        expandedDirKeys: snapshot.expandedDirKeys,
        editorGroups: {
          primary: {
            id: "primary",
            openOrder: snapshot.editorGroups.primary.openOrder,
            activeKey: snapshot.editorGroups.primary.activeKey,
            previewKey: snapshot.editorGroups.primary.previewKey,
            pinnedKeys: snapshot.editorGroups.primary.pinnedKeys,
          },
          secondary: {
            id: "secondary",
            openOrder: snapshot.editorGroups.secondary.openOrder,
            activeKey: snapshot.editorGroups.secondary.activeKey,
            previewKey: snapshot.editorGroups.secondary.previewKey,
            pinnedKeys: snapshot.editorGroups.secondary.pinnedKeys,
          },
        },
        openOrder: uniqueOrderedKeys(snapshot.editorGroups),
        activeKey: snapshot.editorGroups[snapshot.activeEditorGroupId]?.activeKey
          ?? snapshot.editorGroups.primary.activeKey
          ?? snapshot.editorGroups.secondary.activeKey,
      });
      layoutRestoredOpenFilesRef.current = layoutSnapshotHasOpenFiles(snapshot);
      return;
    }
    const seedRoots = initialRoots(workspace);
    if (seedRoots.length === 0) return;
    seedTreeExpandIfEmpty(
      workspaceInstanceId,
      seedRoots.map((root) => root.id),
      seedRoots.map((root) => rootDirKey(root.id, "")),
    );
  }, [patchWorkspaceUi, seedTreeExpandIfEmpty, workspace, workspaceInstanceId]);

  const {
    languagePanelOpen,
    bottomDockOpen,
    bottomDockTab,
    rightPaneOpen,
    rightPaneTab,
    searchEverywhereOpen,
    searchEverywhereMode,
    recentFilesOpen,
    recentAdvanceNonce,
    recentEntries,
    structureOpen,
    structureLoading,
    structureUnavailable,
    structureSymbols,
    quickDocOpen,
    quickDocContent,
    pinnedDoc,
    pinnedDocLocked,
    locationPeek,
    searchFocusNonce,
    searchIncludePreset,
    searchQueryPreset,
    openOrder,
    activeKey,
    editorGroups,
    activeEditorGroupId,
    splitOrientation,
    markdownModes,
    treeFilter,
    treeViewMode,
    expandedRootIds,
    expandedDirKeys,
    treeSelection: selected,
    openFiles,
    lspFiles,
  } = workspaceUi;

  const expandedRoots = useMemo(() => new Set(expandedRootIds), [expandedRootIds]);
  const expandedDirs = useMemo(() => new Set(expandedDirKeys), [expandedDirKeys]);
  // Refs declared early so store-backed setters can dual-write latest maps synchronously.
  const openFilesRef = useRef(openFiles);
  const openOrderRef = useRef(openOrder);
  const lspFilesRef = useRef(lspFiles);

  const setLanguagePanelOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof open === "function" ? open(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).languagePanelOpen) : open;
    patchWorkspaceUi(workspaceInstanceId, { languagePanelOpen: next });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setBottomDockOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).bottomDockOpen;
    patchWorkspaceUi(workspaceInstanceId, { bottomDockOpen: typeof open === "function" ? open(prev) : open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setBottomDockTab = useCallback((tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).bottomDockTab;
    patchWorkspaceUi(workspaceInstanceId, { bottomDockTab: typeof tab === "function" ? tab(prev) : tab });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRightPaneOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).rightPaneOpen;
    patchWorkspaceUi(workspaceInstanceId, { rightPaneOpen: typeof open === "function" ? open(prev) : open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRightPaneTab = useCallback((tab: RightPaneTabId) => {
    patchWorkspaceUi(workspaceInstanceId, { rightPaneTab: tab });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchEverywhereOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { searchEverywhereOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchEverywhereMode = useCallback((mode: SearchEverywhereMode) => {
    patchWorkspaceUi(workspaceInstanceId, { searchEverywhereMode: mode });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRecentFilesOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { recentFilesOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRecentAdvanceNonce = useCallback((updater: number | ((prev: number) => number)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).recentAdvanceNonce;
    patchWorkspaceUi(workspaceInstanceId, {
      recentAdvanceNonce: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRecentEntries = useCallback((entries: RecentFileEntry[]) => {
    patchWorkspaceUi(workspaceInstanceId, { recentEntries: entries });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { structureOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureLoading = useCallback((loading: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { structureLoading: loading });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureUnavailable = useCallback((reason: string | null) => {
    patchWorkspaceUi(workspaceInstanceId, { structureUnavailable: reason });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureSymbols = useCallback((symbols: LspDocumentSymbol[]) => {
    patchWorkspaceUi(workspaceInstanceId, { structureSymbols: symbols });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setQuickDocOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { quickDocOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setQuickDocContent = useCallback((content: QuickDocContent | null) => {
    patchWorkspaceUi(workspaceInstanceId, { quickDocContent: content });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setPinnedDoc = useCallback((content: QuickDocContent | null) => {
    patchWorkspaceUi(workspaceInstanceId, { pinnedDoc: content });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setPinnedDocLocked = useCallback((locked: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { pinnedDocLocked: locked });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setLocationPeek = useCallback((peek: LocationPeekState | null) => {
    patchWorkspaceUi(workspaceInstanceId, { locationPeek: peek });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchFocusNonce = useCallback((updater: number | ((prev: number) => number)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchFocusNonce;
    patchWorkspaceUi(workspaceInstanceId, {
      searchFocusNonce: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchIncludePreset = useCallback((
    updater: { value: string; nonce: number } | ((prev: { value: string; nonce: number }) => { value: string; nonce: number }),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchIncludePreset;
    patchWorkspaceUi(workspaceInstanceId, {
      searchIncludePreset: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchQueryPreset = useCallback((
    updater: { value: string; nonce: number } | ((prev: { value: string; nonce: number }) => { value: string; nonce: number }),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchQueryPreset;
    patchWorkspaceUi(workspaceInstanceId, {
      searchQueryPreset: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setOpenOrder = useCallback((order: string[] | ((prev: string[]) => string[])) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openOrder;
    setStoreOpenOrder(workspaceInstanceId, typeof order === "function" ? order(prev) : order);
  }, [setStoreOpenOrder, workspaceInstanceId]);
  const setActiveKey = useCallback((key: string | null | ((prev: string | null) => string | null)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).activeKey;
    setStoreActiveKey(workspaceInstanceId, typeof key === "function" ? key(prev) : key);
  }, [setStoreActiveKey, workspaceInstanceId]);
  const updateEditorGroup = useCallback((
    groupId: EditorGroupId,
    updater: CodeWorkspaceEditorGroupState | ((prev: CodeWorkspaceEditorGroupState) => CodeWorkspaceEditorGroupState),
  ) => {
    updateStoreEditorGroup(workspaceInstanceId, groupId, updater);
  }, [updateStoreEditorGroup, workspaceInstanceId]);
  const activateEditorGroup = useCallback((groupId: EditorGroupId) => {
    setStoreActiveEditorGroup(workspaceInstanceId, groupId);
  }, [setStoreActiveEditorGroup, workspaceInstanceId]);
  const setMarkdownModes = useCallback((
    updater: Record<string, MarkdownViewMode> | ((prev: Record<string, MarkdownViewMode>) => Record<string, MarkdownViewMode>),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).markdownModes;
    const next = typeof updater === "function" ? updater(prev) : updater;
    patchWorkspaceUi(workspaceInstanceId, { markdownModes: next });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  const setTreeFilter = useCallback((value: string) => {
    patchWorkspaceUi(workspaceInstanceId, { treeFilter: value });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  const setSelected = useCallback((selection: TreeSelection | null) => {
    patchWorkspaceUi(workspaceInstanceId, { treeSelection: selection });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  const setExpandedRoots = useCallback((
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).expandedRootIds);
    const next = typeof updater === "function" ? updater(prev) : updater;
    updateStoreExpandedRootIds(workspaceInstanceId, [...next]);
  }, [updateStoreExpandedRootIds, workspaceInstanceId]);

  const setExpandedDirs = useCallback((
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).expandedDirKeys);
    const next = typeof updater === "function" ? updater(prev) : updater;
    updateStoreExpandedDirKeys(workspaceInstanceId, [...next]);
  }, [updateStoreExpandedDirKeys, workspaceInstanceId]);

  const setOpenFiles = useCallback((
    updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    openFilesRef.current = next;
    updateStoreOpenFiles(workspaceInstanceId, next);
  }, [updateStoreOpenFiles, workspaceInstanceId]);

  const setLspFiles = useCallback((
    updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).lspFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    lspFilesRef.current = next;
    updateStoreLspFiles(workspaceInstanceId, next);
  }, [updateStoreLspFiles, workspaceInstanceId]);

  const [codeViewProfile, setCodeViewProfileState] = useState<CodeViewProfile>(() => loadCodeViewProfile());
  const [treeFontSize, setTreeFontSizeState] = useState(() => readCodeWorkspaceTreeFontSize());
  const [roots, setRoots] = useState<CodeWorkspaceRootInfo[]>(() => initialRoots(workspace));
  const [looseFiles, setLooseFiles] = useState<CodeWorkspaceLooseFileInfo[]>(() => initialLooseFiles(workspace));
  const {
    directories,
    compactChains,
    flatFiles,
    loadDir,
    loadFlatFiles,
    reset: resetTreeData,
    removeRoot: removeTreeDataRoot,
  } = useWorkspaceTreeData({
    roots,
    expandedRootIds: expandedRoots,
    treeViewMode,
    onError: setStatusMessage,
  });
  const [gitRoots, setGitRoots] = useState<WorkspaceGitRoot[]>([]);
  const [gitRootsLoading, setGitRootsLoading] = useState(false);
  const [gitSnapshots, setGitSnapshots] = useState<Record<string, WorkspaceGitSnapshotState>>({});
  const [navCan, setNavCan] = useState({ back: false, forward: false });
  const [revealTarget, setRevealTarget] = useState<EditorRevealTarget | null>(null);
  const [cursorPositions, setCursorPositions] = useState<Record<EditorGroupId, LspPosition>>({
    primary: { line: 0, character: 0 },
    secondary: { line: 0, character: 0 },
  });
  const [viewportRanges, setViewportRanges] = useState<Record<EditorGroupId, LspRange | null>>({
    primary: null,
    secondary: null,
  });
  const [highlightsByGroup, setHighlightsByGroup] = useState<Record<EditorGroupId, LspDocumentHighlight[]>>({
    primary: [],
    secondary: [],
  });
  const [inlayHintsByGroup, setInlayHintsByGroup] = useState<Record<EditorGroupId, LspInlayHint[]>>({
    primary: [],
    secondary: [],
  });
  const [gitHeadTextByFile, setGitHeadTextByFile] = useState<Record<string, { sourceKey: string; text: string | null }>>({});
  const [gitLineChangesByFile, setGitLineChangesByFile] = useState<Record<string, GitLineChange[]>>({});
  const [gitBlameByGroup, setGitBlameByGroup] = useState<Record<EditorGroupId, GitBlameLine | null>>({
    primary: null,
    secondary: null,
  });
  const [intelligencePreferences, setIntelligencePreferencesState] = useState<WorkspaceIntelligencePreferences>(
    () => readWorkspaceIntelligencePreferences(workspaceInstanceId),
  );
  const [breadcrumbSymbolsByGroup, setBreadcrumbSymbolsByGroup] = useState<Record<EditorGroupId, LspDocumentSymbol[]>>({
    primary: [],
    secondary: [],
  });
  const [referencesResult, setReferencesResult] = useState<ReferencesResultState>({
    loading: false,
    origin: null,
    locations: [],
    error: null,
  });
  const [callHierarchyRoot, setCallHierarchyRoot] = useState<HierarchyRootState | null>(null);
  const [typeHierarchyRoot, setTypeHierarchyRoot] = useState<HierarchyRootState | null>(null);
  const setIntelligencePreferences = useCallback((
    update: WorkspaceIntelligencePreferences
      | ((current: WorkspaceIntelligencePreferences) => WorkspaceIntelligencePreferences),
  ) => {
    setIntelligencePreferencesState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      writeWorkspaceIntelligencePreferences(workspaceInstanceId, next);
      return next;
    });
  }, [workspaceInstanceId]);
  const rootsRef = useRef(roots);
  const looseFilesRef = useRef(looseFiles);
  const codeViewProfileRef = useRef(codeViewProfile);
  const treeFontSizeRef = useRef(treeFontSize);
  const gitRootsRef = useRef(gitRoots);
  const navHistoryRef = useRef<{ stack: CodeWorkspaceFileRef[]; index: number; suppress: boolean }>({
    stack: [],
    index: -1,
    suppress: false,
  });
  const recentFilesRef = useRef<CodeWorkspaceFileRef[]>([]);
  const gitHeadRequestsRef = useRef(new Set<string>());
  const gitBlameCacheRef = useRef(new Map<string, GitBlameLine | null>());
  const revealNonceRef = useRef(0);
  const editorSelectionRef = useRef<EditorSelectionRange>({
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
    empty: true,
    text: "",
    rect: null,
  });
  const [editorAiSelection, setEditorAiSelection] = useState<EditorSelectionRange | null>(null);
  const [aiRewriteState, setAiRewriteState] = useState<{
    key: string;
    path: string;
    original: string;
    proposal: string;
    instruction: string;
    range: EditorSelectionRange;
  } | null>(null);
  const workspaceCommandRunnerRef = useRef<(commandId: string, context?: WorkspaceCommandContext) => boolean>(() => false);
  const goToTypeDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToImplementationRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const renameSymbolRef = useRef<() => Promise<void>>(async () => {});
  const initialOpenedKeyRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const treePaneRef = useRef<HTMLElement | null>(null);
  const editorPaneRef = useRef<HTMLElement | null>(null);
  const inactiveEditorPaneRef = useRef<HTMLElement | null>(null);
  const terminalDockRef = useRef<TerminalDockHandle | null>(null);
  const runPanelRef = useRef<RunPanelHandle | null>(null);
  const {
    serverStatuses: lspServerStatuses,
    commandPrefs: lspCommandPrefs,
    customCommands: lspCustomCommands,
    refreshServerStatuses: refreshLspServerStatuses,
    updateCommandPref: updateLspCommandPref,
    updateCustomCommand: updateLspCustomCommand,
    descriptorForFile: lspDescriptorForFile,
    syncDocument: syncLspDocument,
    saveDocument: saveLspDocument,
    closeDocument: closeLspDocument,
    updateStatus: updateLspStatusForFile,
  } = useWorkspaceLspSession({
    workspaceInstanceId,
    roots,
    openFilesRef,
    updateLspFiles: setLspFiles,
    onError: setStatusMessage,
  });
  const treePaneStyle = useMemo(() => ({
    "--taomni-code-tree-font-size": `${treeFontSize}px`,
    "--taomni-code-tree-small-font-size": `${Math.max(10, treeFontSize - 1)}px`,
    "--taomni-code-tree-row-height": `${Math.max(24, treeFontSize + 15)}px`,
  }) as CSSProperties, [treeFontSize]);
  const editorPaneStyle = useMemo(() => ({
    "--taomni-code-editor-ui-font-size": `${codeViewProfile.fontSize}px`,
    "--taomni-code-editor-ui-small-font-size": `${Math.max(10, codeViewProfile.fontSize - 2)}px`,
    "--taomni-code-editor-tab-height": `${Math.max(28, codeViewProfile.fontSize + 15)}px`,
  }) as CSSProperties, [codeViewProfile.fontSize]);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    looseFilesRef.current = looseFiles;
  }, [looseFiles]);

  useEffect(() => {
    gitRootsRef.current = gitRoots;
  }, [gitRoots]);

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  useEffect(() => {
    openOrderRef.current = openOrder;
  }, [openOrder]);

  useEffect(() => {
    lspFilesRef.current = lspFiles;
  }, [lspFiles]);

  useEffect(() => {
    codeViewProfileRef.current = codeViewProfile;
  }, [codeViewProfile]);

  useEffect(() => {
    treeFontSizeRef.current = treeFontSize;
  }, [treeFontSize]);

  const updateCodeViewProfile = useCallback(
    (
      updater: CodeViewProfile | ((current: CodeViewProfile) => CodeViewProfile),
      statusMessage?: (profile: CodeViewProfile) => string,
    ) => {
      // Base the change on the freshly-persisted profile rather than local state
      // so a zoom here never clobbers a theme/font the user just picked in
      // Settings → Code View Appearance.
      const current = loadCodeViewProfile();
      const next = normalizeCodeViewProfile(
        typeof updater === "function" ? updater(current) : updater,
      );
      codeViewProfileRef.current = next;
      setCodeViewProfileState(next);
      saveCodeViewProfile(next);
      applyCodeViewProfile(next, DEFAULT_TERMINAL_PROFILE);
      if (statusMessage) setStatusMessage(statusMessage(next));
    },
    [setStatusMessage],
  );

  // Follow code-view appearance edits made elsewhere (Settings, another window)
  // so the workspace shares one theme/font with the Git diff view instead of
  // owning its own copy.
  useEffect(() => {
    return subscribeCodeViewProfile((incoming) => {
      if (sameCodeViewProfile(incoming, codeViewProfileRef.current)) return;
      codeViewProfileRef.current = incoming;
      setCodeViewProfileState(incoming);
      applyCodeViewProfile(incoming, DEFAULT_TERMINAL_PROFILE);
    });
  }, []);

  const setCodeViewFontSize = useCallback(
    (size: number) => {
      updateCodeViewProfile(
        (current) => ({ ...current, fontSize: clampCodeWorkspaceFontSize(size) }),
        (next) => `Code workspace zoom ${next.fontSize}px`,
      );
    },
    [updateCodeViewProfile],
  );

  const stepCodeViewFontSize = useCallback(
    (delta: number) => {
      setCodeViewFontSize(codeViewProfileRef.current.fontSize + delta);
    },
    [setCodeViewFontSize],
  );

  const setTreeFontSize = useCallback(
    (size: number) => {
      const next = clampCodeWorkspaceTreeFontSize(size);
      treeFontSizeRef.current = next;
      setTreeFontSizeState(next);
      writeCodeWorkspaceTreeFontSize(next);
      setStatusMessage(`File tree zoom ${next}px`);
    },
    [setStatusMessage],
  );

  const stepTreeFontSize = useCallback(
    (delta: number) => {
      setTreeFontSize(treeFontSizeRef.current + delta);
    },
    [setTreeFontSize],
  );

  const setTreeViewMode = useCallback((mode: TreeViewMode) => {
    patchWorkspaceUi(workspaceInstanceId, { treeViewMode: mode });
    writeCodeWorkspaceTreeViewMode(mode);
    setStatusMessage(`File tree view: ${mode}`);
  }, [patchWorkspaceUi, setStatusMessage, workspaceInstanceId]);

  const zoomTargetForNode = useCallback((target: EventTarget | null): "tree" | "editor" => {
    const node = target instanceof Node ? target : null;
    if (node && treePaneRef.current?.contains(node)) return "tree";
    return "editor";
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      const increase =
        event.key === "+" ||
        event.key === "=" ||
        event.code === "NumpadAdd";
      const decrease =
        event.key === "-" ||
        event.key === "_" ||
        event.code === "NumpadSubtract";
      const reset =
        event.key === "0" ||
        event.code === "Digit0" ||
        event.code === "Numpad0";

      if (!increase && !decrease && !reset) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const target = zoomTargetForNode(event.target);
      if (target === "tree") {
        if (increase) {
          stepTreeFontSize(1);
        } else if (decrease) {
          stepTreeFontSize(-1);
        } else {
          setTreeFontSize(CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE);
        }
      } else if (increase) {
        stepCodeViewFontSize(1);
      } else if (decrease) {
        stepCodeViewFontSize(-1);
      } else {
        setCodeViewFontSize(DEFAULT_CODE_VIEW_PROFILE.fontSize);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [setCodeViewFontSize, setTreeFontSize, stepCodeViewFontSize, stepTreeFontSize, visible, zoomTargetForNode]);

  useEffect(() => {
    if (!visible) return;
    const el = rootRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();

      const target = zoomTargetForNode(event.target);
      if (target === "tree") {
        if (event.deltaY < 0) {
          stepTreeFontSize(1);
        } else if (event.deltaY > 0) {
          stepTreeFontSize(-1);
        }
      } else if (event.deltaY < 0) {
        stepCodeViewFontSize(1);
      } else if (event.deltaY > 0) {
        stepCodeViewFontSize(-1);
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [stepCodeViewFontSize, stepTreeFontSize, visible, zoomTargetForNode]);

  const findRoot = useCallback((rootId: string) => rootsRef.current.find((root) => root.id === rootId) ?? null, []);

  const refreshWorkspaceGitSnapshots = useCallback(async (targets = gitRootsRef.current) => {
    await Promise.all(targets.map(async (root) => {
      setGitSnapshots((current) => ({
        ...current,
        [root.repoRoot]: {
          changes: current[root.repoRoot]?.changes ?? [],
          headOid: current[root.repoRoot]?.headOid ?? null,
          currentBranch: current[root.repoRoot]?.currentBranch ?? null,
          ahead: current[root.repoRoot]?.ahead ?? 0,
          behind: current[root.repoRoot]?.behind ?? 0,
          loading: true,
          error: null,
        },
      }));
      try {
        const snapshot = await gitSnapshot(root.repoRoot);
        setGitSnapshots((current) => ({
          ...current,
          [root.repoRoot]: {
            changes: snapshot.changes,
            headOid: snapshot.headOid,
            currentBranch: snapshot.currentBranch,
            ahead: snapshot.ahead,
            behind: snapshot.behind,
            loading: false,
            error: null,
          },
        }));
      } catch (err) {
        setGitSnapshots((current) => ({
          ...current,
          [root.repoRoot]: {
            changes: current[root.repoRoot]?.changes ?? [],
            headOid: current[root.repoRoot]?.headOid ?? null,
            currentBranch: current[root.repoRoot]?.currentBranch ?? null,
            ahead: current[root.repoRoot]?.ahead ?? 0,
            behind: current[root.repoRoot]?.behind ?? 0,
            loading: false,
            error: errorMessage(err),
          },
        }));
      }
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (roots.length === 0) {
      setGitRoots([]);
      setGitRootsLoading(false);
      setGitSnapshots({});
      return () => {
        cancelled = true;
      };
    }

    setGitRootsLoading(true);
    void workspaceDetectGitRoots(roots.map((root) => ({
      id: root.id,
      name: root.name,
      path: root.path,
    }))).then((detected) => {
      if (cancelled) return;
      setGitRoots(detected);
      setGitSnapshots((current) => Object.fromEntries(
        Object.entries(current).filter(([repoRoot]) => detected.some((root) => root.repoRoot === repoRoot)),
      ));
    }).catch((err) => {
      if (cancelled) return;
      const message = errorMessage(err);
      setGitRoots([]);
      setStatusMessage(message);
    }).finally(() => {
      if (!cancelled) setGitRootsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [roots, setStatusMessage]);

  useEffect(() => {
    if (gitRoots.length === 0) return;
    void refreshWorkspaceGitSnapshots(gitRoots);
    const timer = window.setInterval(() => {
      void refreshWorkspaceGitSnapshots(gitRootsRef.current);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [gitRoots, refreshWorkspaceGitSnapshots]);

  useEffect(() => subscribeGitRepoRefresh((repoRoot) => {
    const root = gitRootsRef.current.find((item) => item.repoRoot === repoRoot);
    if (root) void refreshWorkspaceGitSnapshots([root]);
  }), [refreshWorkspaceGitSnapshots]);

  const notifyWorkspacePathGitChanged = useCallback((rootId: string, path: string) => {
    const root = findRoot(rootId);
    if (!root) return;
    const repo = gitRootForWorkspacePath(root, path, gitRootsRef.current);
    if (repo) notifyGitRepoChanged(repo.repoRoot);
  }, [findRoot]);

  const openFile = useCallback(
    async (ref: CodeWorkspaceFileRef, options: { preview?: boolean; groupId?: EditorGroupId } = {}) => {
      const key = fileKey(ref);
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      const groupId = options.groupId ?? currentUi.activeEditorGroupId;
      updateEditorGroup(groupId, (group) => {
        const alreadyOpen = group.openOrder.includes(key);
        let nextOrder = group.openOrder;
        let previewKey = group.previewKey;
        if (!alreadyOpen) {
          if (options.preview && previewKey && previewKey !== key && !group.pinnedKeys.includes(previewKey)) {
            nextOrder = nextOrder.filter((entry) => entry !== previewKey);
          }
          nextOrder = [...nextOrder, key];
        }
        if (options.preview) {
          previewKey = group.pinnedKeys.includes(key) ? null : key;
        } else if (previewKey === key) {
          previewKey = null;
        }
        return { ...group, openOrder: nextOrder, activeKey: key, previewKey };
      });
      if (groupId !== currentUi.activeEditorGroupId) activateEditorGroup(groupId);
      if (openFilesRef.current[key] && !openFilesRef.current[key].loading) return;
      setOpenFiles((current) => ({
        ...current,
        [key]: current[key] ?? makeLoadingFile(ref, rootsRef.current, looseFilesRef.current),
      }));
      try {
        const file = ref.kind === "root"
          ? await workspaceReadFile(findRoot(ref.rootId)?.path ?? "", ref.path)
          : await workspaceReadLooseFile(ref.path);
        const nextRef = ref.kind === "root" ? { ...ref, path: file.path } : { ...ref, path: file.path };
        const meta = fileMeta(nextRef, rootsRef.current, looseFilesRef.current);
        setOpenFiles((current) => {
          const next = { ...current };
          if (fileKey(nextRef) !== key) delete next[key];
          next[fileKey(nextRef)] = {
            ref: nextRef,
            key: fileKey(nextRef),
            path: meta.path,
            title: meta.title,
            subtitle: meta.subtitle,
            languagePath: meta.languagePath,
            text: file.text,
            savedText: file.text,
            hash: file.hash,
            mtime: file.mtime,
            size: file.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          };
          return next;
        });
        updateEditorGroup(groupId, (group) => ({
          ...group,
          openOrder: group.openOrder.map((item) => (item === key ? fileKey(nextRef) : item)),
          activeKey: group.activeKey === key ? fileKey(nextRef) : group.activeKey,
          previewKey: group.previewKey === key ? fileKey(nextRef) : group.previewKey,
          pinnedKeys: group.pinnedKeys.map((item) => (item === key ? fileKey(nextRef) : item)),
        }));
        setStatusMessage(`Opened ${meta.subtitle}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? makeLoadingFile(ref, rootsRef.current, looseFilesRef.current)),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [activateEditorGroup, findRoot, setStatusMessage, updateEditorGroup, workspaceInstanceId],
  );

  const openSearchEverywhere = useCallback((mode: SearchEverywhereMode = "files") => {
    // Warm the recursive file index for every root; loadFlatFiles caches.
    rootsRef.current.forEach((root) => void loadFlatFiles(root.id));
    setSearchEverywhereMode(mode);
    setSearchEverywhereOpen(true);
  }, [loadFlatFiles]);

  const goToFileItems = useMemo<GoToFileItem[]>(() => {
    const items: GoToFileItem[] = [];
    for (const root of roots) {
      const state = flatFiles[root.id];
      if (!state) continue;
      for (const entry of state.entries) {
        if (entry.fileType !== "file" || shouldHideEntry(entry)) continue;
        items.push({ rootId: root.id, rootName: root.name, path: entry.path });
      }
    }
    return items;
  }, [flatFiles, roots]);
  const goToFileLoading = useMemo(
    () => roots.some((root) => flatFiles[root.id]?.loading ?? false),
    [flatFiles, roots],
  );
  const goToFileTruncated = useMemo(
    () => roots.some((root) => flatFiles[root.id]?.truncated ?? false),
    [flatFiles, roots],
  );

  const openGoToFileItem = useCallback(
    (item: GoToFileItem, options?: { split: boolean }) => {
      setSearchEverywhereOpen(false);
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: item.rootId, path: item.path };
      if (options?.split) {
        const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
        const targetGroupId: EditorGroupId = current.activeEditorGroupId === "primary"
          ? "secondary"
          : "primary";
        setStoreSplitOrientation(workspaceInstanceId, "vertical");
        void openFile(ref, { groupId: targetGroupId });
        return;
      }
      void openFile(ref, { preview: true });
    },
    [openFile, setStoreSplitOrientation, workspaceInstanceId],
  );

  // Track file activations for Recent Files (Ctrl+E) and the back/forward
  // navigation history.
  useEffect(() => {
    if (!activeKey) return;
    const ref = openFilesRef.current[activeKey]?.ref;
    if (!ref) return;
    recentFilesRef.current = [
      ref,
      ...recentFilesRef.current.filter((item) => fileKey(item) !== activeKey),
    ].slice(0, RECENT_FILES_LIMIT);
    const nav = navHistoryRef.current;
    if (nav.suppress) {
      nav.suppress = false;
      setNavCan({ back: nav.index > 0, forward: nav.index < nav.stack.length - 1 });
      return;
    }
    if (nav.index >= 0 && nav.stack[nav.index] && fileKey(nav.stack[nav.index]) === activeKey) return;
    nav.stack = [...nav.stack.slice(0, nav.index + 1), ref].slice(-NAV_HISTORY_LIMIT);
    nav.index = nav.stack.length - 1;
    setNavCan({ back: nav.index > 0, forward: false });
  }, [activeKey]);

  const navigateHistory = useCallback(
    (delta: -1 | 1) => {
      const nav = navHistoryRef.current;
      const nextIndex = nav.index + delta;
      if (nextIndex < 0 || nextIndex >= nav.stack.length) return;
      nav.index = nextIndex;
      nav.suppress = true;
      setNavCan({ back: nextIndex > 0, forward: nextIndex < nav.stack.length - 1 });
      void openFile(nav.stack[nextIndex]);
    },
    [openFile],
  );

  const openRecentFiles = useCallback(() => {
    const entries: RecentFileEntry[] = recentFilesRef.current.map((ref) => {
      const key = fileKey(ref);
      const meta = fileMeta(ref, rootsRef.current, looseFilesRef.current);
      return {
        key,
        ref,
        title: meta.title,
        subtitle: meta.subtitle,
        open: !!openFilesRef.current[key],
      };
    });
    setRecentEntries(entries);
    setRecentFilesOpen(true);
  }, []);

  const pickRecentFile = useCallback(
    (entry: RecentFileEntry) => {
      setRecentFilesOpen(false);
      void openFile(entry.ref);
    },
    [openFile],
  );

  useEffect(() => {
    if (!visible) return;
    const detector = createDoubleShiftDetector(() => openSearchEverywhere("all"));
    const handleKeyDown = (event: KeyboardEvent) => detector.handleKeyDown(event);
    const handleKeyUp = (event: KeyboardEvent) => detector.handleKeyUp(event);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [openSearchEverywhere, visible]);

  const openFindInFiles = useCallback(() => {
    setBottomDockOpen(true);
    setBottomDockTab("search");
    setSearchFocusNonce((nonce) => nonce + 1);
  }, []);

  const findInDirectory = useCallback((path: string) => {
    setBottomDockOpen(true);
    setBottomDockTab("search");
    setSearchIncludePreset((current) => ({
      value: path ? `${path}/**` : "",
      nonce: current.nonce + 1,
    }));
  }, []);

  const openTerminalAt = useCallback((rootId: string, path: string, pathIsFile = false) => {
    const root = findRoot(rootId);
    if (!root) return;
    const relativeDirectory = pathIsFile ? parentPath(path) : path;
    const cwd = absoluteWorkspacePath(root, relativeDirectory);
    setBottomDockTab("terminal");
    setBottomDockOpen(true);
    terminalDockRef.current?.openAt(cwd, relativeDirectory ? basename(relativeDirectory) : root.name);
  }, [findRoot]);

  const copyTreePath = useCallback(
    async (rootId: string, path: string, absolute: boolean) => {
      const root = findRoot(rootId);
      if (!root) return;
      const text = absolute
        ? (path ? `${normalizeFsPath(root.path)}/${path}` : normalizeFsPath(root.path))
        : path || normalizeFsPath(root.path);
      try {
        await writeText(text);
        setStatusMessage(`Copied ${text}`);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    },
    [findRoot, setStatusMessage],
  );

  useEffect(() => {
    if (layoutRestoredOpenFilesRef.current) {
      const snapshot = readWorkspaceLayoutSnapshot(workspaceInstanceId);
      if (!snapshot) {
        layoutRestoredOpenFilesRef.current = false;
      } else {
        const keys = uniqueOrderedKeys(snapshot.editorGroups);
        if (keys.length === 0) {
          layoutRestoredOpenFilesRef.current = false;
        } else {
          if (initialOpenedKeyRef.current === `restored:${workspaceInstanceId}`) return;
          initialOpenedKeyRef.current = `restored:${workspaceInstanceId}`;
          for (const groupId of ["primary", "secondary"] as const) {
            const group = snapshot.editorGroups[groupId];
            for (const key of group.openOrder) {
              const ref = fileRefFromFileKey(key, looseFiles);
              if (!ref) continue;
              void openFile(ref, {
                groupId,
                preview: group.previewKey === key,
              });
            }
          }
          return;
        }
      }
    }
    const ref = initialFileRef(workspace, roots, looseFiles);
    if (!ref) return;
    const key = fileKey(ref);
    if (initialOpenedKeyRef.current === key) return;
    initialOpenedKeyRef.current = key;
    void openFile(ref);
  }, [looseFiles, openFile, roots, workspace, workspaceInstanceId]);

  useEffect(() => {
    if (!workspaceInstanceId) return;
    const timer = window.setTimeout(() => {
      writeWorkspaceLayoutSnapshot(workspaceInstanceId, snapshotFromWorkspaceUi({
        bottomDockOpen,
        bottomDockTab,
        rightPaneOpen,
        rightPaneTab,
        languagePanelOpen,
        splitOrientation,
        activeEditorGroupId,
        expandedRootIds,
        expandedDirKeys,
        editorGroups,
      }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    activeEditorGroupId,
    bottomDockOpen,
    bottomDockTab,
    editorGroups,
    expandedDirKeys,
    expandedRootIds,
    languagePanelOpen,
    rightPaneOpen,
    rightPaneTab,
    splitOrientation,
    workspaceInstanceId,
  ]);

  const addRoot = useCallback(async () => {
    const path = await selectFolderPath();
    if (!path) return;
    const root = makeRoot(path, "folder");
    if (rootsRef.current.some((item) => item.path === root.path)) {
      setStatusMessage(`Folder already in workspace: ${root.path}`);
      return;
    }
    setRoots((current) => [...current, root]);
    setExpandedRoots((current) => new Set(current).add(root.id));
    setExpandedDirs((current) => new Set(current).add(rootDirKey(root.id, "")));
    setStatusMessage(`Added folder ${root.path}`);
    void loadDir(root.id, "");
  }, [loadDir, setStatusMessage]);

  const addLooseFilePath = useCallback(async (path: string) => {
    if (!path) return;
    const file = makeLooseFile(path);
    setLooseFiles((current) => current.some((item) => item.path === file.path) ? current : [...current, file]);
    setSelected({ kind: "file", ref: { kind: "loose", id: file.id, path: file.path } });
    await openFile({ kind: "loose", id: file.id, path: file.path });
  }, [openFile]);

  const openLooseFile = useCallback(async () => {
    const path = await selectFilePath();
    if (!path) return;
    await addLooseFilePath(path);
  }, [addLooseFilePath]);

  const refreshTree = useCallback(() => {
    resetTreeData();
    rootsRef.current.forEach((root) => {
      if (expandedRoots.has(root.id)) void loadDir(root.id, "");
      if (treeViewMode === "flat") void loadFlatFiles(root.id, true);
    });
  }, [expandedRoots, loadDir, loadFlatFiles, resetTreeData, treeViewMode]);

  const toggleRoot = useCallback(
    (rootId: string) => {
      setSelected({ kind: "root", rootId });
      setExpandedRoots((current) => {
        const next = new Set(current);
        if (next.has(rootId)) next.delete(rootId);
        else next.add(rootId);
        return next;
      });
      if (!directories[rootDirKey(rootId, "")]?.loaded) void loadDir(rootId, "");
    },
    [directories, loadDir],
  );

  const toggleDir = useCallback(
    (rootId: string, path: string) => {
      const key = rootDirKey(rootId, path);
      const wasExpanded = expandedDirs.has(key);
      setExpandedDirs((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      const state = directories[key];
      if (!wasExpanded && (!state?.loaded || state.error)) {
        void loadDir(rootId, path);
      }
    },
    [directories, expandedDirs, loadDir],
  );

  const selectedRootDirectory = useMemo(() => {
    if (selected?.kind === "dir") return { rootId: selected.rootId, path: selected.path };
    if (selected?.kind === "file" && selected.ref.kind === "root") {
      return { rootId: selected.ref.rootId, path: parentPath(selected.ref.path) };
    }
    if (activeKey) {
      const active = openFiles[activeKey];
      if (active?.ref.kind === "root") return { rootId: active.ref.rootId, path: parentPath(active.ref.path) };
    }
    return roots[0] ? { rootId: roots[0].id, path: "" } : null;
  }, [activeKey, openFiles, roots, selected]);

  const createFile = useCallback(async (target?: { rootId: string; path: string }) => {
    const directory = target ?? selectedRootDirectory;
    if (!directory) {
      setStatusMessage("Add a folder before creating files");
      return;
    }
    const name = await promptAppDialog({
      title: "New file",
      label: "File name",
      initialValue: directory.path ? `${directory.path}/` : "",
    });
    if (!name) return;
    const root = findRoot(directory.rootId);
    if (!root) return;
    const path = name.includes("/") || name.includes("\\")
      ? name.trim().replace(/\\/g, "/").replace(/^\/+/, "")
      : joinRelativePath(directory.path, name);
    try {
      const file = await workspaceCreateFile(root.path, path);
      await loadDir(root.id, parentPath(file.path));
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: file.path };
      setSelected({ kind: "file", ref });
      await openFile(ref);
      notifyWorkspacePathGitChanged(root.id, file.path);
      setStatusMessage(`Created ${root.name} / ${file.path}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, loadDir, notifyWorkspacePathGitChanged, openFile, selectedRootDirectory, setStatusMessage]);

  const createDir = useCallback(async (target?: { rootId: string; path: string }) => {
    const directory = target ?? selectedRootDirectory;
    if (!directory) {
      setStatusMessage("Add a folder before creating directories");
      return;
    }
    const name = await promptAppDialog({
      title: "New directory",
      label: "Directory name",
      initialValue: directory.path ? `${directory.path}/` : "",
    });
    if (!name) return;
    const root = findRoot(directory.rootId);
    if (!root) return;
    const path = name.includes("/") || name.includes("\\")
      ? name.trim().replace(/\\/g, "/").replace(/^\/+/, "")
      : joinRelativePath(directory.path, name);
    try {
      const entry = await workspaceCreateDir(root.path, path);
      await loadDir(root.id, parentPath(entry.path));
      setExpandedDirs((current) => new Set(current).add(rootDirKey(root.id, parentPath(entry.path))));
      setSelected({ kind: "dir", rootId: root.id, path: entry.path });
      notifyWorkspacePathGitChanged(root.id, entry.path);
      setStatusMessage(`Created ${root.name} / ${entry.path}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, loadDir, notifyWorkspacePathGitChanged, selectedRootDirectory, setStatusMessage]);

  const renameSelected = useCallback(async (target?: TreeSelection) => {
    const selection = target ?? selected;
    if (!selection) return;
    if (selection.kind === "root") {
      const root = findRoot(selection.rootId);
      if (!root) return;
      const name = await promptAppDialog({ title: "Rename root", label: "Display name", initialValue: root.name });
      if (!name || name === root.name) return;
      setRoots((current) => current.map((item) => item.id === root.id ? { ...item, name } : item));
      return;
    }
    if (selection.kind === "file" && selection.ref.kind === "loose") {
      const ref = selection.ref;
      const loose = looseFilesRef.current.find((item) => item.id === ref.id);
      if (!loose) return;
      const name = await promptAppDialog({ title: "Rename loose file", label: "Display name", initialValue: loose.name });
      if (!name || name === loose.name) return;
      setLooseFiles((current) => current.map((item) => item.id === loose.id ? { ...item, name } : item));
      return;
    }
    const rootTarget = selection.kind === "dir"
      ? { rootId: selection.rootId, path: selection.path }
      : selection.ref.kind === "root"
        ? { rootId: selection.ref.rootId, path: selection.ref.path }
        : null;
    if (!rootTarget) return;
    const rootId = rootTarget.rootId;
    const selectedPath = rootTarget.path;
    const root = findRoot(rootId);
    if (!root) return;
    const nextName = await promptAppDialog({
      title: "Rename",
      label: "New name",
      initialValue: basename(selectedPath),
    });
    if (!nextName || nextName === basename(selectedPath)) return;
    const nextPath = joinRelativePath(parentPath(selectedPath), nextName);
    try {
      const entry = await workspaceRenamePath(root.path, selectedPath, nextPath);
      const newPath = entry.path;
      await loadDir(root.id, parentPath(selectedPath));
      await loadDir(root.id, parentPath(newPath));
      setExpandedDirs((current) => {
        const next = new Set<string>();
        for (const item of current) {
          const [id, path] = item.split(":", 2);
          next.add(id === root.id ? rootDirKey(root.id, remapRelativePath(path, selectedPath, newPath)) : item);
        }
        return next;
      });
      setOpenFiles((current) => {
        const next: Record<string, OpenFileState> = {};
        for (const file of Object.values(current)) {
          const ref = remapFileRef(file.ref, root.id, selectedPath, newPath);
          const meta = fileMeta(ref, rootsRef.current, looseFilesRef.current);
          next[fileKey(ref)] = { ...file, ref, key: fileKey(ref), path: meta.path, title: meta.title, subtitle: meta.subtitle, languagePath: meta.languagePath };
        }
        return next;
      });
      setOpenOrder((current) => current.map((key) => {
        const file = openFilesRef.current[key];
        if (!file) return key;
        return fileKey(remapFileRef(file.ref, root.id, selectedPath, newPath));
      }));
      setActiveKey((current) => {
        const file = current ? openFilesRef.current[current] : null;
        return file ? fileKey(remapFileRef(file.ref, root.id, selectedPath, newPath)) : current;
      });
      setSelected(entry.fileType === "dir" ? { kind: "dir", rootId: root.id, path: newPath } : { kind: "file", ref: { kind: "root", rootId: root.id, path: newPath } });
      notifyWorkspacePathGitChanged(root.id, selectedPath);
      notifyWorkspacePathGitChanged(root.id, newPath);
      setStatusMessage(`Renamed to ${root.name} / ${newPath}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, loadDir, notifyWorkspacePathGitChanged, selected, setStatusMessage]);

  const deleteSelected = useCallback(async (target?: TreeSelection) => {
    const selection = target ?? selected;
    if (!selection) return;
    if (selection.kind === "root") {
      const root = findRoot(selection.rootId);
      if (!root) return;
      const confirmed = await confirmAppDialog({
        title: "Remove folder",
        message: `Remove ${root.name} from this workspace? Files on disk are not deleted.`,
        confirmLabel: "Remove",
      });
      if (!confirmed) return;
      const removedRootId = root.id;
      setRoots((current) => current.filter((item) => item.id !== removedRootId));
      removeTreeDataRoot(removedRootId);
      setOpenFiles((current) => Object.fromEntries(Object.entries(current).filter(([, file]) => file.ref.kind !== "root" || file.ref.rootId !== removedRootId)));
      const remaining = openOrderRef.current.filter((key) => {
        const file = openFilesRef.current[key];
        return !file || file.ref.kind !== "root" || file.ref.rootId !== removedRootId;
      });
      setOpenOrder(remaining);
      setActiveKey((current) => current && !remaining.includes(current) ? remaining[0] ?? null : current);
      setSelected(null);
      return;
    }
    if (selection.kind === "file" && selection.ref.kind === "loose") {
      const ref = selection.ref;
      const confirmed = await confirmAppDialog({
        title: "Remove loose file",
        message: `Remove ${ref.path} from this workspace? The file on disk is not deleted.`,
        confirmLabel: "Remove",
      });
      if (!confirmed) return;
      const key = fileKey(ref);
      setLooseFiles((current) => current.filter((item) => item.id !== ref.id));
      setOpenFiles((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      const remaining = openOrderRef.current.filter((item) => item !== key);
      setOpenOrder(remaining);
      setActiveKey((current) => current === key ? remaining[0] ?? null : current);
      setSelected(null);
      return;
    }
    const rootTarget = selection.kind === "dir"
      ? { rootId: selection.rootId, path: selection.path }
      : selection.ref.kind === "root"
        ? { rootId: selection.ref.rootId, path: selection.ref.path }
        : null;
    if (!rootTarget) return;
    const rootId = rootTarget.rootId;
    const selectedPath = rootTarget.path;
    const root = findRoot(rootId);
    if (!root) return;
    const confirmed = await confirmAppDialog({
      title: "Delete",
      message: `Delete ${root.name} / ${selectedPath}?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await workspaceDeletePath(root.path, selectedPath, selection.kind === "dir");
      await loadDir(root.id, parentPath(selectedPath));
      setExpandedDirs((current) => {
        const next = new Set<string>();
        for (const item of current) {
          const [id, path] = item.split(":", 2);
          if (id !== root.id || (path !== selectedPath && !path.startsWith(`${selectedPath}/`))) next.add(item);
        }
        return next;
      });
      setOpenFiles((current) => Object.fromEntries(Object.entries(current).filter(([, file]) => !fileRefUnder(file.ref, root.id, selectedPath))));
      const remainingOpen = openOrderRef.current.filter((key) => {
        const file = openFilesRef.current[key];
        return !file || !fileRefUnder(file.ref, root.id, selectedPath);
      });
      setOpenOrder(remainingOpen);
      setActiveKey((current) => {
        const file = current ? openFilesRef.current[current] : null;
        return file && fileRefUnder(file.ref, root.id, selectedPath) ? remainingOpen[0] ?? null : current;
      });
      setSelected(null);
      notifyWorkspacePathGitChanged(root.id, selectedPath);
      setStatusMessage(`Deleted ${root.name} / ${selectedPath}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, loadDir, notifyWorkspacePathGitChanged, removeTreeDataRoot, selected, setStatusMessage]);

  const treeContextMenu = useContextMenu();
  const treeClipboardRef = useRef<{ mode: "copy" | "cut"; rootId: string; path: string } | null>(null);

  const revealInExplorer = useCallback(async (rootId: string, path: string) => {
    const root = findRoot(rootId);
    if (!root) return;
    const absolute = path ? absoluteWorkspacePath(root, path) : normalizeFsPath(root.path);
    try {
      await invoke("sftp_open_path", { path: absolute });
      setStatusMessage(`Opened ${absolute}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, setStatusMessage]);

  const copyEditorTabPath = useCallback(async (key: string, absolute: boolean) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.ref.kind === "root") {
      await copyTreePath(file.ref.rootId, file.ref.path, absolute);
      return;
    }
    const text = absolute ? normalizeFsPath(file.ref.path) : basename(file.ref.path);
    try {
      await writeText(text);
      setStatusMessage(`Copied ${text}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [copyTreePath, setStatusMessage]);

  const revealEditorTabInTree = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    setSelected({ kind: "file", ref: file.ref });
    if (file.ref.kind !== "root") return;
    const rootId = file.ref.rootId;
    setExpandedRoots((current) => new Set(current).add(rootId));
    const directories = file.ref.path.split("/").filter(Boolean).slice(0, -1);
    setExpandedDirs((current) => {
      const next = new Set(current);
      let path = "";
      for (const directory of directories) {
        path = path ? `${path}/${directory}` : directory;
        next.add(rootDirKey(rootId, path));
        void loadDir(rootId, path);
      }
      return next;
    });
    treePaneRef.current?.focus();
  }, [loadDir]);

  const revealEditorTabInExplorer = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.ref.kind === "root") {
      void revealInExplorer(file.ref.rootId, file.ref.path);
      return;
    }
    const absolute = normalizeFsPath(file.ref.path);
    void invoke("sftp_open_path", { path: absolute })
      .then(() => setStatusMessage(`Opened ${absolute}`))
      .catch((err) => setStatusMessage(errorMessage(err)));
  }, [revealInExplorer, setStatusMessage]);

  const openEditorTabInTerminal = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.ref.kind === "root") {
      openTerminalAt(file.ref.rootId, file.ref.path, true);
      return;
    }
    const cwd = parentPath(normalizeFsPath(file.ref.path));
    setBottomDockTab("terminal");
    setBottomDockOpen(true);
    terminalDockRef.current?.openAt(cwd, basename(cwd));
  }, [openTerminalAt]);

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const pane = treePaneRef.current;
    if (!pane) return;
    // Ignore when typing in the filter input.
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const rows = Array.from(pane.querySelectorAll<HTMLElement>(
      "[data-testid='code-workspace-tree-root'], [data-testid='code-workspace-tree-dir'], [data-testid='code-workspace-tree-file'], [data-testid='code-workspace-flat-file']",
    ));
    if (rows.length === 0) return;
    const selectedIndex = Math.max(0, rows.findIndex((row) => row.dataset.selected === "true"));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown"
        ? Math.min(rows.length - 1, selectedIndex + 1)
        : Math.max(0, selectedIndex - 1);
      rows[next]?.click();
      rows[next]?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (selected?.kind === "file" && (event.ctrlKey || event.metaKey)) {
        const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
        const targetGroupId: EditorGroupId = current.activeEditorGroupId === "primary"
          ? "secondary"
          : "primary";
        setStoreSplitOrientation(workspaceInstanceId, "vertical");
        void openFile(selected.ref, { groupId: targetGroupId });
      } else if (selected?.kind === "file") void openFile(selected.ref);
      else rows[selectedIndex]?.click();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      workspaceCommandRunnerRef.current("workspace.tree.rename", { focus: "tree", payload: { selection: selected ?? undefined } });
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      workspaceCommandRunnerRef.current("workspace.tree.delete", { focus: "tree", payload: { selection: selected ?? undefined } });
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      // Expand/collapse by re-clicking directory/root rows.
      const row = rows[selectedIndex];
      if (!row) return;
      if (row.dataset.testid === "code-workspace-tree-dir" || row.dataset.testid === "code-workspace-tree-root") {
        event.preventDefault();
        row.click();
      }
    }
  }, [openFile, selected, setStoreSplitOrientation, workspaceInstanceId]);

  const pasteTreeClipboard = useCallback(async (target: { rootId: string; path: string }) => {
    const clip = treeClipboardRef.current;
    if (!clip) {
      setStatusMessage("Nothing to paste");
      return;
    }
    if (clip.rootId !== target.rootId) {
      setStatusMessage("Cross-root paste is not supported");
      return;
    }
    const root = findRoot(clip.rootId);
    if (!root) return;
    const name = basename(clip.path);
    const destPath = target.path ? `${target.path}/${name}` : name;
    try {
      if (clip.mode === "cut") {
        await workspaceRenamePath(root.path, clip.path, destPath);
        treeClipboardRef.current = null;
        setStatusMessage(`Moved to ${destPath}`);
      } else {
        const file = await workspaceReadFile(root.path, clip.path);
        await workspaceCreateFile(root.path, destPath, file.text);
        setStatusMessage(`Copied to ${destPath}`);
      }
      await loadDir(clip.rootId, parentPath(clip.path) || "");
      if (target.path) await loadDir(target.rootId, target.path);
      else await loadDir(target.rootId, "");
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, loadDir, setStatusMessage]);

  const showTreeContextMenu = useCallback(
    (event: React.MouseEvent, selection: TreeSelection) => {
      setSelected(selection);
      const run = (commandId: string, payload: WorkspaceTreeCommandPayload) => () => {
        workspaceCommandRunnerRef.current(commandId, { focus: "tree", payload });
      };
      const clipboardItems = (rootId: string, path: string, directory: { rootId: string; path: string }) => [
        {
          label: "Cut",
          onClick: () => {
            treeClipboardRef.current = { mode: "cut", rootId, path };
            setStatusMessage("Cut to clipboard");
          },
        },
        {
          label: "Copy",
          onClick: () => {
            treeClipboardRef.current = { mode: "copy", rootId, path };
            setStatusMessage("Copied to clipboard");
          },
        },
        {
          label: "Paste",
          disabled: !treeClipboardRef.current,
          onClick: () => void pasteTreeClipboard(directory),
        },
      ];
      if (selection.kind === "file" && selection.ref.kind === "root") {
        const ref = selection.ref;
        const dir = parentPath(ref.path);
        treeContextMenu.show(event, [
          { label: "Open", onClick: run("workspace.tree.open", { selection }) },
          { separator: true, label: "" },
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "Rename...", onClick: run("workspace.tree.rename", { selection }) },
          { label: "Delete", danger: true, onClick: run("workspace.tree.delete", { selection }) },
          { separator: true, label: "" },
          ...clipboardItems(ref.rootId, ref.path, { rootId: ref.rootId, path: dir }),
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: ref.rootId, path: ref.path }) },
          { label: "Copy Relative Path", onClick: run("workspace.tree.copyRelativePath", { rootId: ref.rootId, path: ref.path }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void revealInExplorer(ref.rootId, ref.path),
          },
          { label: "Open in Terminal", onClick: () => openTerminalAt(ref.rootId, ref.path, true) },
        ]);
        return;
      }
      if (selection.kind === "dir") {
        treeContextMenu.show(event, [
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "Rename...", onClick: run("workspace.tree.rename", { selection }) },
          { label: "Delete", danger: true, onClick: run("workspace.tree.delete", { selection }) },
          { separator: true, label: "" },
          ...clipboardItems(selection.rootId, selection.path, { rootId: selection.rootId, path: selection.path }),
          { separator: true, label: "" },
          { label: "Find in Directory...", onClick: run("workspace.tree.findInDirectory", { path: selection.path }) },
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: selection.rootId, path: selection.path }) },
          { label: "Copy Relative Path", onClick: run("workspace.tree.copyRelativePath", { rootId: selection.rootId, path: selection.path }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void revealInExplorer(selection.rootId, selection.path),
          },
          { label: "Open in Terminal", onClick: () => openTerminalAt(selection.rootId, selection.path) },
        ]);
        return;
      }
      if (selection.kind === "root") {
        treeContextMenu.show(event, [
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "Rename Root...", onClick: run("workspace.tree.rename", { selection }) },
          { separator: true, label: "" },
          {
            label: "Paste",
            disabled: !treeClipboardRef.current,
            onClick: () => void pasteTreeClipboard({ rootId: selection.rootId, path: "" }),
          },
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: selection.rootId, path: "" }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void revealInExplorer(selection.rootId, ""),
          },
          { label: "Open in Terminal", onClick: () => openTerminalAt(selection.rootId, "") },
          { separator: true, label: "" },
          { label: "Remove from Workspace", danger: true, onClick: run("workspace.tree.delete", { selection }) },
        ]);
      }
    },
    [openTerminalAt, pasteTreeClipboard, revealInExplorer, treeContextMenu],
  );

  const updateFileText = useCallback((key: string, text: string) => {
    const file = openFilesRef.current[key];
    if (!file || file.text === text) return;
    const next: OpenFileState = {
      ...file,
      text,
      dirty: text !== file.savedText,
      error: null,
    };
    // Sync ref immediately so WorkspaceEdit apply → save sees the new text
    // without waiting for React to flush setState.
    openFilesRef.current = { ...openFilesRef.current, [key]: next };
    setOpenFiles((current) => ({ ...current, [key]: next }));
  }, []);

  const absolutePathForOpenFile = useCallback((file: OpenFileState): string | null => {
    if (file.ref.kind === "loose") return normalizeFsPath(file.ref.path);
    const root = findRoot(file.ref.rootId);
    if (!root) return null;
    return absoluteWorkspacePath(root, file.ref.path);
  }, [findRoot]);

  /**
   * Persist an open buffer with an explicit text payload.
   * Used by WorkspaceEdit for open-clean files (§5.2.9): apply then save.
   * Unlike `saveFile`, this does not require the buffer to already be dirty.
   */
  const [localHistoryTarget, setLocalHistoryTarget] = useState<{ key: string; path: string } | null>(null);

  const openLocalHistoryForKey = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    const absolute = absolutePathForOpenFile(file);
    if (!absolute) {
      setStatusMessage("Cannot resolve path for local history");
      return;
    }
    setLocalHistoryTarget({ key, path: absolute });
  }, [absolutePathForOpenFile, setStatusMessage]);

  const restoreLocalHistoryText = useCallback((key: string, text: string) => {
    updateFileText(key, text);
    setStatusMessage("Restored local history snapshot into the editor buffer");
  }, [setStatusMessage, updateFileText]);

  const applySelectionReplacement = useCallback((key: string, range: EditorSelectionRange, nextText: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    const lines = file.text.split("\n");
    const offsetAt = (position: { line: number; character: number }) => {
      let offset = 0;
      for (let line = 0; line < Math.min(position.line, lines.length); line += 1) {
        offset += (lines[line]?.length ?? 0) + 1;
      }
      const lineText = lines[Math.min(position.line, Math.max(0, lines.length - 1))] ?? "";
      return offset + Math.min(Math.max(0, position.character), lineText.length);
    };
    const from = offsetAt(range.start);
    const to = offsetAt(range.end);
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const replaced = `${file.text.slice(0, start)}${nextText}${file.text.slice(end)}`;
    updateFileText(key, replaced);
  }, [updateFileText]);

  const handleEditorAiAction = useCallback(async (action: EditorAiAction, text: string) => {
    const selection = editorSelectionRef.current;
    const file = activeKey ? openFilesRef.current[activeKey] ?? null : null;
    if (!file || selection.empty || !text.trim()) return;
    const pathLabel = file.subtitle || file.path;
    if (action === "explain") {
      // explainSelection wraps the payload as terminal output; stage a code-specific prompt instead.
      await attachToComposer([
        `请解释下面这段代码的作用、关键逻辑和潜在问题：`,
        `文件: ${pathLabel}`,
        "",
        "```",
        text,
        "```",
      ].join("\n"));
      setEditorAiSelection(null);
      setStatusMessage("Staged explain request in AI chat");
      return;
    }
    if (action === "fix") {
      const prompt = [
        `请修复下面这段代码中的问题，保持原有意图，并只返回修复后的完整代码块。`,
        `文件: ${pathLabel}`,
        "",
        "```",
        text,
        "```",
      ].join("\n");
      await attachToComposer(prompt);
      setAiRewriteState({
        key: file.key,
        path: pathLabel,
        original: text,
        proposal: text,
        instruction: "Fix issues in the selected code",
        range: selection,
      });
      setEditorAiSelection(null);
      setStatusMessage("Staged fix request in AI chat — paste the result into the proposal or apply after editing");
      return;
    }
    const instruction = "Rewrite the selected code";
    const prompt = [
      `请按指令改写下面的代码，只返回改写后的完整代码块。`,
      `文件: ${pathLabel}`,
      `指令: ${instruction}`,
      "",
      "```",
      text,
      "```",
    ].join("\n");
    await attachToComposer(prompt);
    setAiRewriteState({
      key: file.key,
      path: pathLabel,
      original: text,
      proposal: text,
      instruction,
      range: selection,
    });
    setEditorAiSelection(null);
    setStatusMessage("Staged rewrite request in AI chat");
  }, [activeKey, attachToComposer, setStatusMessage]);

  const saveOpenBufferText = useCallback(async (key: string, textToSave: string) => {
    const file = openFilesRef.current[key];
    if (!file || file.loading) {
      throw new Error("Open buffer is not available to save");
    }
    setOpenFiles((current) => ({
      ...current,
      [key]: { ...current[key], text: textToSave, saving: true, error: null },
    }));
    openFilesRef.current = {
      ...openFilesRef.current,
      [key]: { ...file, text: textToSave, saving: true, error: null },
    };
    try {
      // Snapshot the previous on-disk contents before overwrite when available.
      const historyPath = absolutePathForOpenFile(file);
      if (historyPath && file.savedText.length <= 2 * 1024 * 1024) {
        await historySnapshot(historyPath, file.savedText, "save").catch(() => null);
      }
      const saved = file.ref.kind === "root"
        ? await workspaceWriteFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path, textToSave, file.hash)
        : await workspaceWriteLooseFile(file.ref.path, textToSave, file.hash);
      const cleaned: OpenFileState = {
        ...file,
        text: saved.text,
        savedText: saved.text,
        hash: saved.hash,
        mtime: saved.mtime,
        size: saved.size,
        loading: false,
        saving: false,
        dirty: false,
        error: null,
      };
      openFilesRef.current = { ...openFilesRef.current, [key]: cleaned };
      setOpenFiles((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? cleaned),
          ...cleaned,
          // If the user typed while we saved, keep their newer text dirty.
          text: (current[key]?.text ?? saved.text) !== textToSave && current[key]
            ? current[key].text
            : saved.text,
          dirty: (current[key]?.text ?? saved.text) !== textToSave
            && (current[key]?.text ?? saved.text) !== saved.text
            ? true
            : false,
          savedText: saved.text,
          hash: saved.hash,
          mtime: saved.mtime,
          size: saved.size,
          saving: false,
          error: null,
        },
      }));
      if (file.ref.kind === "root") {
        notifyWorkspacePathGitChanged(file.ref.rootId, file.ref.path);
      }
      void saveLspDocument(file, textToSave);
    } catch (err) {
      const message = errorMessage(err);
      setOpenFiles((current) => ({
        ...current,
        [key]: {
          ...current[key],
          text: textToSave,
          dirty: true,
          saving: false,
          error: message,
        },
      }));
      throw err instanceof Error ? err : new Error(message);
    }
  }, [absolutePathForOpenFile, findRoot, notifyWorkspacePathGitChanged, saveLspDocument]);

  const saveFile = useCallback(
    async (key: string | null = activeKey) => {
      if (!key) return;
      const file = openFilesRef.current[key];
      if (!file || file.loading || file.saving || !file.dirty) return;
      try {
        await saveOpenBufferText(key, file.text);
        setStatusMessage(`Saved ${file.subtitle}`);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    },
    [activeKey, saveOpenBufferText, setStatusMessage],
  );

  const reloadFile = useCallback(
    async (key: string | null = activeKey) => {
      if (!key) return;
      const file = openFilesRef.current[key];
      if (!file) return;
      if (file.dirty) {
        const confirmed = await confirmAppDialog({
          title: "Reload file",
          message: `Discard unsaved changes in ${file.subtitle}?`,
          confirmLabel: "Reload",
          danger: true,
        });
        if (!confirmed) return;
      }
      setOpenFiles((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? file),
          loading: true,
          error: null,
        },
      }));
      try {
        const reloaded = file.ref.kind === "root"
          ? await workspaceReadFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path)
          : await workspaceReadLooseFile(file.ref.path);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...file,
            text: reloaded.text,
            savedText: reloaded.text,
            hash: reloaded.hash,
            mtime: reloaded.mtime,
            size: reloaded.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          },
        }));
        setStatusMessage(`Reloaded ${file.subtitle}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? file),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [activeKey, findRoot, setStatusMessage],
  );

  const closeFile = useCallback(
    async (key: string, groupId: EditorGroupId = activeEditorGroupId) => {
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      const group = currentUi.editorGroups[groupId];
      if (!group.openOrder.includes(key)) return;
      const file = openFilesRef.current[key];
      const usedByOtherGroup = Object.values(currentUi.editorGroups).some(
        (candidate) => candidate.id !== groupId && candidate.openOrder.includes(key),
      );
      if (file?.dirty && !usedByOtherGroup) {
        const confirmed = await confirmAppDialog({
          title: "Close file",
          message: `Discard unsaved changes in ${file.subtitle}?`,
          confirmLabel: "Close",
          danger: true,
        });
        if (!confirmed) return;
      }
      const index = group.openOrder.indexOf(key);
      const nextOrder = group.openOrder.filter((entry) => entry !== key);
      updateEditorGroup(groupId, (current) => ({
        ...current,
        openOrder: nextOrder,
        activeKey: current.activeKey === key
          ? nextOrder[Math.min(index, nextOrder.length - 1)] ?? null
          : current.activeKey,
        previewKey: current.previewKey === key ? null : current.previewKey,
        pinnedKeys: current.pinnedKeys.filter((entry) => entry !== key),
      }));
      if (usedByOtherGroup) return;
      if (file) closeLspDocument(file);
      setOpenFiles((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setMarkdownModes((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      setLspFiles((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [activeEditorGroupId, closeLspDocument, updateEditorGroup, workspaceInstanceId],
  );

  const promotePreviewTab = useCallback((groupId: EditorGroupId, key: string) => {
    updateEditorGroup(groupId, (group) => ({
      ...group,
      previewKey: group.previewKey === key ? null : group.previewKey,
    }));
  }, [updateEditorGroup]);

  const setTabPinned = useCallback((groupId: EditorGroupId, key: string, pinned: boolean) => {
    updateEditorGroup(groupId, (group) => ({
      ...group,
      previewKey: pinned && group.previewKey === key ? null : group.previewKey,
      pinnedKeys: pinned
        ? [...group.pinnedKeys.filter((entry) => entry !== key), key]
        : group.pinnedKeys.filter((entry) => entry !== key),
    }));
  }, [updateEditorGroup]);

  const closeGroupFiles = useCallback(async (groupId: EditorGroupId, keys: string[]) => {
    for (const key of keys) await closeFile(key, groupId);
  }, [closeFile]);

  const splitEditor = useCallback((
    orientation: EditorSplitOrientation,
    key = activeKey,
    sourceGroupId = activeEditorGroupId,
  ) => {
    if (!key) return;
    const file = openFilesRef.current[key];
    if (!file) return;
    const targetGroupId: EditorGroupId = sourceGroupId === "primary" ? "secondary" : "primary";
    void openFile(file.ref, { groupId: targetGroupId });
    setStoreSplitOrientation(workspaceInstanceId, orientation);
  }, [activeEditorGroupId, activeKey, openFile, setStoreSplitOrientation, workspaceInstanceId]);

  const closeSplit = useCallback(() => {
    const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const primary = current.editorGroups.primary;
    const secondary = current.editorGroups.secondary;
    const mergedOrder = [...primary.openOrder];
    for (const key of secondary.openOrder) {
      if (!mergedOrder.includes(key)) mergedOrder.push(key);
    }
    updateEditorGroup("primary", {
      ...primary,
      openOrder: mergedOrder,
      activeKey: current.activeEditorGroupId === "secondary"
        ? secondary.activeKey ?? primary.activeKey
        : primary.activeKey,
      pinnedKeys: [...new Set([...primary.pinnedKeys, ...secondary.pinnedKeys])],
      previewKey: primary.previewKey ?? secondary.previewKey,
    });
    updateEditorGroup("secondary", {
      id: "secondary",
      openOrder: [],
      activeKey: null,
      previewKey: null,
      pinnedKeys: [],
    });
    setStoreSplitOrientation(workspaceInstanceId, null);
    activateEditorGroup("primary");
  }, [activateEditorGroup, setStoreSplitOrientation, updateEditorGroup, workspaceInstanceId]);

  useEffect(() => {
    if (!splitOrientation) return;
    const primary = editorGroups.primary;
    const secondary = editorGroups.secondary;
    if (primary.openOrder.length > 0 && secondary.openOrder.length > 0) return;
    if (primary.openOrder.length === 0 && secondary.openOrder.length > 0) {
      updateEditorGroup("primary", { ...secondary, id: "primary" });
      updateEditorGroup("secondary", {
        id: "secondary",
        openOrder: [],
        activeKey: null,
        previewKey: null,
        pinnedKeys: [],
      });
    }
    setStoreSplitOrientation(workspaceInstanceId, null);
    activateEditorGroup("primary");
  }, [activateEditorGroup, editorGroups, setStoreSplitOrientation, splitOrientation, updateEditorGroup, workspaceInstanceId]);

  const activeFile = activeKey ? openFiles[activeKey] ?? null : null;
  const activeLspState = activeKey ? lspFiles[activeKey] ?? null : null;
  const activeCapabilities = activeLspState?.status?.capabilities ?? null;
  const openHierarchy = useCallback(async (mode: "call" | "type") => {
    const file = activeFile;
    if (!file || file.loading) return;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) {
      setStatusMessage("No language service for this file");
      return;
    }
    const capabilities = lspFilesRef.current[file.key]?.status?.capabilities;
    const supported = mode === "call" ? capabilities?.callHierarchy : capabilities?.typeHierarchy;
    if (!supported) {
      setStatusMessage(`${mode === "call" ? "Call" : "Type"} hierarchy is not supported by this language server`);
      return;
    }
    try {
      const position = cursorPositions[activeEditorGroupId] ?? editorSelectionRef.current.start;
      const result = mode === "call"
        ? await lspPrepareCallHierarchy(descriptor, position)
        : await lspPrepareTypeHierarchy(descriptor, position);
      updateLspStatusForFile(file, result.status);
      const item = result.items[0];
      if (!item) {
        setStatusMessage(`No ${mode} hierarchy is available at the cursor`);
        return;
      }
      const root: HierarchyRootState = { descriptor, item };
      if (mode === "call") {
        setCallHierarchyRoot(root);
        setBottomDockTab("call-hierarchy");
      } else {
        setTypeHierarchyRoot(root);
        setBottomDockTab("type-hierarchy");
      }
      setBottomDockOpen(true);
    } catch (cause) {
      setStatusMessage(errorMessage(cause));
    }
  }, [
    activeEditorGroupId,
    activeFile,
    cursorPositions,
    lspDescriptorForFile,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    updateLspStatusForFile,
  ]);
  const activeLanguageId = activeLspState?.status?.languageId ?? null;
  const activeInlayHintsEnabled = inlayHintsEnabledForLanguage(
    intelligencePreferences,
    activeLanguageId,
  );
  const toggleInlayHints = useCallback(() => {
    setIntelligencePreferences((current) => ({
      ...current,
      inlayHintsEnabled: !current.inlayHintsEnabled,
    }));
  }, [setIntelligencePreferences]);
  const toggleInlayHintsForActiveLanguage = useCallback(() => {
    const languageId = activeLanguageId;
    setIntelligencePreferences((current) => {
      if (!languageId) return { ...current, inlayHintsEnabled: !current.inlayHintsEnabled };
      const currentlyEnabled = inlayHintsEnabledForLanguage(current, languageId);
      return {
        ...current,
        inlayHintsEnabled: true,
        inlayHintLanguages: {
          ...current.inlayHintLanguages,
          [languageId]: !currentlyEnabled,
        },
      };
    });
  }, [activeLanguageId, setIntelligencePreferences]);
  const toggleInlineBlame = useCallback(() => {
    setIntelligencePreferences((current) => ({
      ...current,
      inlineBlameEnabled: !current.inlineBlameEnabled,
    }));
  }, [setIntelligencePreferences]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    if (!file || file.loading) {
      setHighlightsByGroup((current) => ({ ...current, [groupId]: [] }));
      return;
    }
    let cancelled = false;
    const position = cursorPositions[groupId] ?? { line: 0, character: 0 };
    const timer = window.setTimeout(() => {
      const descriptor = lspDescriptorForFile(file);
      if (!activeCapabilities?.documentHighlight || !descriptor) {
        if (!cancelled) {
          setHighlightsByGroup((current) => ({
            ...current,
            [groupId]: fallbackWordHighlights(file.text, position),
          }));
        }
        return;
      }
      void lspDocumentHighlights(descriptor, position)
        .then((result) => {
          if (cancelled) return;
          updateLspStatusForFile(file, result.status);
          setHighlightsByGroup((current) => ({ ...current, [groupId]: result.highlights }));
        })
        .catch(() => {
          if (!cancelled) {
            setHighlightsByGroup((current) => ({
              ...current,
              [groupId]: fallbackWordHighlights(file.text, position),
            }));
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.documentHighlight,
    activeEditorGroupId,
    activeFile,
    cursorPositions,
    lspDescriptorForFile,
    updateLspStatusForFile,
  ]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    if (!file || file.loading || !activeInlayHintsEnabled || !activeCapabilities?.inlayHint) {
      setInlayHintsByGroup((current) => ({ ...current, [groupId]: [] }));
      return;
    }
    const range = viewportRanges[groupId] ?? initialInlayHintRange(file.text);
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void lspInlayHints(descriptor, range)
        .then((result) => {
          if (cancelled) return;
          updateLspStatusForFile(file, result.status);
          setInlayHintsByGroup((current) => ({ ...current, [groupId]: result.hints }));
        })
        .catch(() => {
          if (!cancelled) setInlayHintsByGroup((current) => ({ ...current, [groupId]: [] }));
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.inlayHint,
    activeEditorGroupId,
    activeFile,
    activeInlayHintsEnabled,
    lspDescriptorForFile,
    updateLspStatusForFile,
    viewportRanges,
  ]);

  const getLspSelectionRanges = useCallback(async (
    file: OpenFileState,
    selection: EditorSelectionRange,
  ): Promise<LspRange[] | null> => {
    const capabilities = lspFilesRef.current[file.key]?.status?.capabilities;
    if (!capabilities?.selectionRange) return null;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return null;
    try {
      const result = await lspSelectionRanges(descriptor, selection.end);
      updateLspStatusForFile(file, result.status);
      return result.ranges.length > 0 ? result.ranges : null;
    } catch {
      return null;
    }
  }, [lspDescriptorForFile, updateLspStatusForFile]);
  const breadcrumbPathSegments = useMemo<BreadcrumbPathSegment[]>(() => {
    return activeFile ? breadcrumbSegmentsForFile(activeFile, roots) : [];
  }, [activeFile, roots]);

  useEffect(() => {
    let cancelled = false;
    if (!activeFile || activeFile.loading || !activeCapabilities?.documentSymbol) {
      setBreadcrumbSymbolsByGroup((current) => ({ ...current, [activeEditorGroupId]: [] }));
      return () => { cancelled = true; };
    }
    const descriptor = lspDescriptorForFile(activeFile);
    if (!descriptor) return () => { cancelled = true; };
    const timer = window.setTimeout(() => {
      void lspDocumentSymbols(descriptor).then((result) => {
        if (!cancelled) {
          updateLspStatusForFile(activeFile, result.status);
          setBreadcrumbSymbolsByGroup((current) => ({
            ...current,
            [activeEditorGroupId]: result.symbols,
          }));
        }
      }).catch(() => {
        if (!cancelled) {
          setBreadcrumbSymbolsByGroup((current) => ({ ...current, [activeEditorGroupId]: [] }));
        }
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeCapabilities?.documentSymbol, activeEditorGroupId, activeFile, lspDescriptorForFile, updateLspStatusForFile]);
  const activeRootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : null;
  const activeRoot = activeRootId ? roots.find((root) => root.id === activeRootId) ?? null : null;
  const activeGitRoot = activeRoot && activeFile?.ref.kind === "root"
    ? gitRootForWorkspacePath(activeRoot, activeFile.ref.path, gitRoots)
    : null;
  const title = workspaceTitle(workspace, roots, looseFiles);
  const gitManagerPayload = useMemo<CodeWorkspaceGitManagerPayload | null>(() => {
    if (gitRoots.length === 0) return null;
    return {
      workspaceName: title,
      workspaceInstanceId,
      workspaceId: workspace.workspaceId,
      roots: gitRoots,
      activeRepoRoot: activeGitRoot?.repoRoot ?? gitRoots[0]?.repoRoot ?? null,
    };
  }, [activeGitRoot, gitRoots, title, workspace.workspaceId, workspaceInstanceId]);

  const openGitManager = useCallback(() => {
    if (!onOpenGitManager || !gitManagerPayload) return;
    onOpenGitManager(gitManagerPayload);
  }, [gitManagerPayload, onOpenGitManager]);

  useEffect(() => {
    if (!visible) {
      clearWorkspaceStatus(tabId);
      return;
    }
    const cursor = cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 };
    const status = activeLspState?.status ?? null;
    const gitSnapshot = activeGitRoot ? gitSnapshots[activeGitRoot.repoRoot] : null;
    setWorkspaceStatusSegments({
      tabId,
      line: cursor.line + 1,
      column: cursor.character + 1,
      encoding: "UTF-8",
      eol: detectWorkspaceEol(activeFile?.text ?? ""),
      languageId: status?.languageId ?? activeLanguageId,
      lspActive: !!status?.active,
      lspLabel: status?.displayName ?? (status?.active ? "LSP" : null),
      lspError: !!activeLspState?.error || (!!status && !status.active && !!status.error),
      gitBranch: gitSnapshot?.currentBranch ?? null,
      gitAhead: gitSnapshot?.ahead ?? 0,
      gitBehind: gitSnapshot?.behind ?? 0,
      fontSize: codeViewProfile.fontSize,
    });
    setWorkspaceStatusActions(tabId, {
      openLanguagePanel: () => setLanguagePanelOpen(true),
      openGitManager: gitManagerPayload && onOpenGitManager ? openGitManager : undefined,
    });
    return () => clearWorkspaceStatus(tabId);
  }, [
    activeEditorGroupId,
    activeFile?.text,
    activeGitRoot,
    activeLanguageId,
    activeLspState,
    clearWorkspaceStatus,
    codeViewProfile.fontSize,
    cursorPositions,
    gitManagerPayload,
    gitSnapshots,
    onOpenGitManager,
    openGitManager,
    setLanguagePanelOpen,
    setWorkspaceStatusActions,
    setWorkspaceStatusSegments,
    tabId,
    visible,
  ]);

  const gitChangeByRootPath = useMemo(() => {
    const map = new Map<string, GitChange>();
    for (const root of roots) {
      for (const repo of gitRootsForWorkspaceRoot(root, gitRoots)) {
        const snapshot = gitSnapshots[repo.repoRoot];
        if (!snapshot?.changes.length) continue;
        for (const change of snapshot.changes) {
          const workspacePath = workspacePathForGitPath(root, repo, change.path);
          if (workspacePath === null) continue;
          map.set(`${root.id}:${workspacePath}`, change);
        }
      }
    }
    return map;
  }, [gitRoots, gitSnapshots, roots]);

  const gitTargetForFile = useCallback((file: OpenFileState | null) => {
    if (!file || file.loading || file.ref.kind !== "root") return null;
    const ref = file.ref;
    const root = roots.find((candidate) => candidate.id === ref.rootId);
    if (!root) return null;
    const repo = gitRootForWorkspacePath(root, ref.path, gitRoots);
    if (!repo) return null;
    const path = gitPathForWorkspacePath(root, repo, ref.path);
    if (!path) return null;
    const snapshot = gitSnapshots[repo.repoRoot];
    return {
      repoRoot: repo.repoRoot,
      path,
      headOid: snapshot?.headOid ?? null,
      sourceKey: `${repo.repoRoot}:${snapshot?.headOid ?? "no-head"}:${path}`,
    };
  }, [gitRoots, gitSnapshots, roots]);

  useEffect(() => {
    let cancelled = false;
    const activeKeys = new Set([
      editorGroups.primary.activeKey,
      editorGroups.secondary.activeKey,
    ].filter((key): key is string => !!key));
    for (const key of activeKeys) {
      const file = openFiles[key];
      const target = gitTargetForFile(file ?? null);
      if (!file || !target || gitHeadTextByFile[key]?.sourceKey === target.sourceKey) continue;
      if (!target.headOid) {
        setGitHeadTextByFile((current) => ({
          ...current,
          [key]: { sourceKey: target.sourceKey, text: "" },
        }));
        continue;
      }
      if (gitHeadRequestsRef.current.has(target.sourceKey)) continue;
      gitHeadRequestsRef.current.add(target.sourceKey);
      void gitBlobPair(target.repoRoot, target.path, "HEAD", "")
        .then((pair) => {
          if (cancelled) return;
          setGitHeadTextByFile((current) => ({
            ...current,
            [key]: {
              sourceKey: target.sourceKey,
              text: pair.binary || pair.oversize ? null : pair.oldText ?? "",
            },
          }));
        })
        .catch(() => {
          if (!cancelled) {
            setGitHeadTextByFile((current) => ({
              ...current,
              [key]: { sourceKey: target.sourceKey, text: null },
            }));
          }
        })
        .finally(() => gitHeadRequestsRef.current.delete(target.sourceKey));
    }
    return () => { cancelled = true; };
  }, [editorGroups.primary.activeKey, editorGroups.secondary.activeKey, gitHeadTextByFile, gitTargetForFile, openFiles]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next: Record<string, GitLineChange[]> = {};
      for (const [key, head] of Object.entries(gitHeadTextByFile)) {
        const file = openFiles[key];
        const target = gitTargetForFile(file ?? null);
        if (!file || !target || head.sourceKey !== target.sourceKey || head.text === null) continue;
        next[key] = buildGitLineChanges(head.text, file.text);
      }
      setGitLineChangesByFile(next);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [gitHeadTextByFile, gitTargetForFile, openFiles]);

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const loadForGroup = (groupId: EditorGroupId) => {
      const key = editorGroups[groupId].activeKey;
      const file = key ? openFiles[key] ?? null : null;
      const target = gitTargetForFile(file);
      if (!intelligencePreferences.inlineBlameEnabled || !file || file.dirty || !target?.headOid) {
        setGitBlameByGroup((current) => current[groupId] === null ? current : { ...current, [groupId]: null });
        return;
      }
      const line = (cursorPositions[groupId]?.line ?? 0) + 1;
      const cacheKey = `${target.sourceKey}:${file.hash}:${line}`;
      if (gitBlameCacheRef.current.has(cacheKey)) {
        const cached = gitBlameCacheRef.current.get(cacheKey) ?? null;
        setGitBlameByGroup((current) => current[groupId] === cached ? current : { ...current, [groupId]: cached });
        return;
      }
      timers.push(window.setTimeout(() => {
        void gitBlameLines(target.repoRoot, target.path, line, line)
          .then((lines) => {
            const blame = lines[0] ?? null;
            gitBlameCacheRef.current.set(cacheKey, blame);
            if (!cancelled) setGitBlameByGroup((current) => ({ ...current, [groupId]: blame }));
          })
          .catch(() => {
            gitBlameCacheRef.current.set(cacheKey, null);
            if (!cancelled) setGitBlameByGroup((current) => ({ ...current, [groupId]: null }));
          });
      }, 250));
    };
    loadForGroup("primary");
    loadForGroup("secondary");
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [cursorPositions, editorGroups, gitTargetForFile, intelligencePreferences.inlineBlameEnabled, openFiles]);

  useEffect(() => {
    if (!visible || !activeFile || activeFile.loading) return;
    const lspState = lspFilesRef.current[activeFile.key];
    if (lspState?.syncedText === activeFile.text && lspState.status) return;
    const mode: "open" | "change" = lspState?.status ? "change" : "open";
    const timer = window.setTimeout(() => {
      const latest = openFilesRef.current[activeFile.key];
      if (latest) void syncLspDocument(latest, mode);
    }, mode === "open" ? 0 : 350);
    return () => window.clearTimeout(timer);
  }, [activeFile, syncLspDocument, visible]);

  const openMarkdownHref = useCallback(
    (href: string) => {
      if (!activeFile || isExternalHref(href)) return false;
      const target = href.split("#", 1)[0].split("?", 1)[0];
      if (!target) return false;
      if (activeFile.ref.kind === "root") {
        const path = resolveRootMarkdownLink(activeFile.ref.path, target);
        void openFile({ kind: "root", rootId: activeFile.ref.rootId, path });
        return true;
      }
      const path = resolveLooseMarkdownLink(activeFile.ref.path, target);
      void addLooseFilePath(path);
      return true;
    },
    [activeFile, addLooseFilePath, openFile],
  );

  const revealEditorLocation = useCallback((key: string, range: LspLocation["range"]) => {
    revealNonceRef.current += 1;
    setRevealTarget({
      key,
      line: range.start.line,
      character: range.start.character,
      nonce: revealNonceRef.current,
    });
  }, []);

  const openLspLocation = useCallback(
    async (
      location: LspLocation,
      options: { groupId?: EditorGroupId; preview?: boolean } = {},
    ) => {
      const path = location.path;
      if (!path) return false;
      for (const root of rootsRef.current) {
        const relative = relativePathWithinRoot(root.path, path);
        if (relative === null) continue;
        const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: relative };
        revealEditorLocation(fileKey(ref), location.range);
        await openFile(ref, options);
        return true;
      }
      const loose = makeLooseFile(path);
      const ref: CodeWorkspaceFileRef = { kind: "loose", id: loose.id, path: loose.path };
      setLooseFiles((current) => current.some((item) => item.path === loose.path) ? current : [...current, loose]);
      revealEditorLocation(fileKey(ref), location.range);
      await openFile(ref, options);
      return true;
    },
    [openFile, revealEditorLocation],
  );

  const fetchWorkspaceSymbols = useCallback(async (query: string): Promise<GoToSymbolItem[]> => {
    const file = activeFile ?? Object.values(openFilesRef.current).find((item) => !item.loading) ?? null;
    if (!file) return [];
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return [];
    try {
      const result = await lspWorkspaceSymbols(descriptor, query);
      updateLspStatusForFile(file, result.status);
      return result.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        containerName: symbol.containerName,
        path: symbol.path ?? symbol.uri,
        uri: symbol.uri,
        line: symbol.selectionRange.start.line,
        character: symbol.selectionRange.start.character,
      }));
    } catch {
      return [];
    }
  }, [activeFile, lspDescriptorForFile, updateLspStatusForFile]);

  const openWorkspaceSymbol = useCallback(async (
    symbol: GoToSymbolItem,
    options?: { split: boolean },
  ) => {
    setSearchEverywhereOpen(false);
    let groupId: EditorGroupId | undefined;
    if (options?.split) {
      const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      groupId = current.activeEditorGroupId === "primary" ? "secondary" : "primary";
      setStoreSplitOrientation(workspaceInstanceId, "vertical");
    }
    await openLspLocation({
      uri: symbol.uri,
      path: symbol.path,
      range: {
        start: { line: symbol.line, character: symbol.character },
        end: { line: symbol.line, character: symbol.character },
      },
    }, { groupId, preview: !options?.split });
  }, [openLspLocation, setStoreSplitOrientation, workspaceInstanceId]);

  const seSymbolsAvailable = !!(
    activeCapabilities?.workspaceSymbol
    || Object.values(lspFiles).some((state) => state.status?.capabilities?.workspaceSymbol)
  );

  const openSearchMatch = useCallback(
    (match: WorkspaceSearchMatch, options: { preview: boolean }) => {
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: match.rootId, path: match.path };
      // Backend line numbers are 1-based; reveal targets follow LSP 0-based.
      const line = Math.max(0, match.lineNumber - 1);
      revealEditorLocation(fileKey(ref), {
        start: { line, character: match.matchStart },
        end: { line, character: match.matchEnd },
      });
      void openFile(ref, { preview: options.preview });
    },
    [openFile, revealEditorLocation],
  );

  const structureFileRef = useRef<string | null>(null);

  const pinQuickDocumentation = useCallback((content: QuickDocContent) => {
    setPinnedDoc(content);
    setPinnedDocLocked(true);
    setRightPaneTab("documentation");
    setRightPaneOpen(true);
    setQuickDocOpen(false);
  }, [setPinnedDoc, setPinnedDocLocked, setQuickDocOpen, setRightPaneOpen, setRightPaneTab]);

  const openQuickDocumentation = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const position = editorSelectionRef.current.start;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) {
      setStatusMessage("No documentation available");
      return;
    }
    let body: string | null = null;
    try {
      const result = await lspHover(descriptor, position);
      updateLspStatusForFile(file, result.status);
      body = result.contents;
    } catch (err) {
      setStatusMessage(errorMessage(err));
      return;
    }
    if (!body) {
      setStatusMessage("No documentation available");
      return;
    }
    const lines = file.text.split("\n");
    const line = lines[position.line] ?? "";
    const left = line.slice(0, position.character);
    const right = line.slice(position.character);
    const start = left.search(/[A-Za-z0-9_$]+$/);
    const endMatch = right.match(/^[A-Za-z0-9_$]*/);
    const from = start >= 0 ? start : position.character;
    const to = position.character + (endMatch?.[0].length ?? 0);
    const word = line.slice(from, to) || file.title;
    setQuickDocContent({ title: word, body });
    setQuickDocOpen(true);
  }, [activeFile, lspDescriptorForFile, setStatusMessage, updateLspStatusForFile]);

  const formatActiveFile = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    const caps = lspFilesRef.current[file.key]?.status?.capabilities ?? null;
    const selection = editorSelectionRef.current;
    const hasSelection = !selection.empty
      && (selection.start.line !== selection.end.line || selection.start.character !== selection.end.character);
    const useRange = hasSelection && (caps?.rangeFormatting ?? false);
    // When capabilities are known and neither provider is present, stay silent.
    if (caps && !useRange && !caps.formatting && !(hasSelection && caps.rangeFormatting)) {
      return;
    }
    if (caps && !caps.formatting && !caps.rangeFormatting) return;
    try {
      const range: LspRange = {
        start: selection.start,
        end: selection.end,
      };
      // Prefer range formatting only when advertised; otherwise format the whole document.
      // If capabilities are not yet known, attempt full-document formatting.
      const result = useRange
        ? await lspRangeFormatting(descriptor, range)
        : await lspFormatting(descriptor);
      if (!result.edits.length) return;
      const next = applyLspTextEditsToString(file.text, result.edits);
      if (next !== file.text) updateFileText(file.key, next);
    } catch (error) {
      console.error("Format document failed", error);
    }
  }, [activeFile, lspDescriptorForFile, updateFileText]);

  const applyLspWorkspaceEdit = useCallback(async (edit: LspWorkspaceEdit) => {
    const outcomes = await applyWorkspaceEdit(edit, {
      resolvePath: (file) => {
        if (file.path) return normalizeFsPath(file.path);
        return null;
      },
      getOpenBuffer: (absolutePath) => {
        const normalized = normalizeFsPath(absolutePath);
        for (const file of Object.values(openFilesRef.current)) {
          const path = absolutePathForOpenFile(file);
          if (path && normalizeFsPath(path) === normalized) {
            return { text: file.text, dirty: file.dirty, key: file.key };
          }
        }
        return null;
      },
      applyToOpenBuffer: (key, nextText) => updateFileText(key, nextText),
      // §5.2.9 open-clean: apply then save so the buffer is not left dirty.
      saveOpenBuffer: (key, nextText) => saveOpenBufferText(key, nextText),
      readDisk: async (absolutePath) => {
        // Prefer workspace APIs via root-relative path when possible.
        for (const root of rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, absolutePath);
          if (rel === null) continue;
          try {
            const disk = await workspaceReadFile(root.path, rel);
            return { text: disk.text, hash: disk.hash };
          } catch {
            return null;
          }
        }
        try {
          const disk = await workspaceReadLooseFile(absolutePath);
          return { text: disk.text, hash: disk.hash };
        } catch {
          return null;
        }
      },
      writeDisk: async (absolutePath, text, expectedHash) => {
        // Snapshot current disk contents before bulk WorkspaceEdit writes.
        try {
          let oldText: string | null = null;
          for (const root of rootsRef.current) {
            const rel = relativePathWithinRoot(root.path, absolutePath);
            if (rel === null) continue;
            try {
              oldText = (await workspaceReadFile(root.path, rel)).text;
            } catch {
              oldText = null;
            }
            break;
          }
          if (oldText == null) {
            try {
              oldText = (await workspaceReadLooseFile(absolutePath)).text;
            } catch {
              oldText = null;
            }
          }
          if (oldText != null && oldText.length <= 2 * 1024 * 1024) {
            await historySnapshot(absolutePath, oldText, "replace").catch(() => null);
          }
        } catch {
          // Best-effort history; never block the edit write.
        }
        for (const root of rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, absolutePath);
          if (rel === null) continue;
          await workspaceWriteFile(root.path, rel, text, expectedHash);
          return;
        }
        await workspaceWriteLooseFile(absolutePath, text, expectedHash);
      },
    });
    setStatusMessage(summarizeWorkspaceEditOutcomes(outcomes));
    return outcomes;
  }, [absolutePathForOpenFile, saveOpenBufferText, setStatusMessage, updateFileText]);

  const requestCodeActions = useCallback(async (
    file: OpenFileState,
    range: LspRange,
    diagnostics: LspDiagnostic[] = [],
  ): Promise<LspCodeAction[]> => {
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return [];
    const caps = lspFilesRef.current[file.key]?.status?.capabilities;
    if (caps && !caps.codeAction) return [];
    try {
      const result = await lspCodeActions(
        descriptor,
        range,
        diagnostics.map((item) => ({
          range: item.range,
          severity: item.severity,
          code: item.code,
          source: item.source,
          message: item.message,
        })),
      );
      updateLspStatusForFile(file, result.status);
      return result.actions;
    } catch {
      return [];
    }
  }, [lspDescriptorForFile, updateLspStatusForFile]);

  const runCodeAction = useCallback(async (action: LspCodeAction) => {
    if (action.edit) {
      await applyLspWorkspaceEdit(action.edit);
      return;
    }
    if (action.command) {
      setStatusMessage(`Code action command not yet executed: ${action.command}`);
      return;
    }
    setStatusMessage("Code action had no edit to apply");
  }, [applyLspWorkspaceEdit, setStatusMessage]);

  const showCodeActionsMenu = useCallback(async (
    clientX: number,
    clientY: number,
    file: OpenFileState,
    range: LspRange,
    diagnostics: LspDiagnostic[] = [],
  ) => {
    const actions = await requestCodeActions(file, range, diagnostics);
    if (!actions.length) {
      setStatusMessage("No code actions available");
      return;
    }
    const sorted = [...actions].sort((a, b) => {
      const aQuick = a.kind?.includes("quickfix") ? 0 : 1;
      const bQuick = b.kind?.includes("quickfix") ? 0 : 1;
      if (aQuick !== bQuick) return aQuick - bQuick;
      if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    // Use a synthetic context menu near the caret / lightbulb.
    const synthetic = {
      preventDefault() {},
      stopPropagation() {},
      clientX,
      clientY,
      button: 2,
    } as unknown as React.MouseEvent;
    treeContextMenu.show(synthetic, sorted.map((action) => ({
      label: action.title,
      onClick: () => void runCodeAction(action),
    })));
  }, [requestCodeActions, runCodeAction, treeContextMenu]);

  const openCodeActionsAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const selection = editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? []).filter((item) => (
      item.range.start.line === range.start.line
      || item.range.end.line === range.start.line
    ));
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 80,
      file,
      range,
      diagnostics,
    );
  }, [activeFile, showCodeActionsMenu]);

  const openCodeActionsForLine = useCallback(async (line: number) => {
    const file = activeFile;
    if (!file || file.loading) return;
    const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? []).filter(
      (item) => item.range.start.line === line || item.range.end.line === line,
    );
    const range: LspRange = diagnostics[0]?.range ?? {
      start: { line, character: 0 },
      end: { line, character: 0 },
    };
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 48,
      (rect?.top ?? 0) + 48 + line * 16,
      file,
      range,
      diagnostics,
    );
  }, [activeFile, showCodeActionsMenu]);

  const openQuickFixForProblem = useCallback(async (fileKey: string, diagnostic: LspDiagnostic) => {
    const file = openFilesRef.current[fileKey];
    if (!file) return;
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 120,
      file,
      diagnostic.range,
      [diagnostic],
    );
  }, [showCodeActionsMenu]);

  const openStructurePopup = useCallback(async () => {
    const file = activeKey ? openFilesRef.current[activeKey] : null;
    if (!file || file.loading) return;
    structureFileRef.current = file.key;
    setStructureSymbols([]);
    setStructureUnavailable(null);
    setStructureLoading(true);
    setStructureOpen(true);
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) {
      setStructureLoading(false);
      setStructureUnavailable("No language service for this file");
      return;
    }
    try {
      const result = await lspDocumentSymbols(descriptor);
      updateLspStatusForFile(file, result.status);
      if (structureFileRef.current !== file.key) return;
      setStructureSymbols(result.symbols);
      setStructureUnavailable(
        result.symbols.length === 0 && !result.status.active
          ? result.status.error ?? "Language server is not running for this file"
          : null,
      );
    } catch (err) {
      if (structureFileRef.current === file.key) setStructureUnavailable(errorMessage(err));
    } finally {
      if (structureFileRef.current === file.key) setStructureLoading(false);
    }
  }, [activeKey, lspDescriptorForFile, updateLspStatusForFile]);

  const pickStructureSymbol = useCallback(
    (symbol: LspDocumentSymbol) => {
      setStructureOpen(false);
      const key = structureFileRef.current;
      if (key) revealEditorLocation(key, symbol.selectionRange);
    },
    [revealEditorLocation],
  );

  const pickOutlineSymbol = useCallback((symbol: LspDocumentSymbol) => {
    if (activeKey) revealEditorLocation(activeKey, symbol.selectionRange);
  }, [activeKey, revealEditorLocation]);

  const toggleOutlinePane = useCallback(() => {
    if (rightPaneOpen && rightPaneTab === "outline") {
      setRightPaneOpen(false);
      return;
    }
    setRightPaneTab("outline");
    setRightPaneOpen(true);
  }, [rightPaneOpen, rightPaneTab, setRightPaneOpen, setRightPaneTab]);

  const workspaceCommands = useMemo<WorkspaceCommand[]>(() => [
    {
      id: "workspace.goToFile",
      title: "Go to File",
      category: "Navigation",
      keybinding: "Ctrl+Shift+N",
      keybindings: ["Ctrl+P"],
      keywords: ["search everywhere", "file", "open"],
      run: () => openSearchEverywhere("files"),
    },
    {
      id: "workspace.goToClass",
      title: "Go to Class",
      category: "Navigation",
      keybinding: "Ctrl+N",
      keywords: ["type", "interface", "struct"],
      when: () => seSymbolsAvailable,
      run: () => openSearchEverywhere("classes"),
    },
    {
      id: "workspace.goToSymbol",
      title: "Go to Symbol",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Shift+N",
      keywords: ["workspace symbol"],
      when: () => seSymbolsAvailable,
      run: () => openSearchEverywhere("symbols"),
    },
    {
      id: "workspace.searchEverywhere",
      title: "Search Everywhere",
      category: "Navigation",
      keywords: ["double shift", "all"],
      run: () => openSearchEverywhere("all"),
    },
    {
      id: "workspace.recentFiles",
      title: "Recent Files",
      category: "Navigation",
      keybinding: "Ctrl+E",
      keywords: ["previous", "history"],
      run: () => {
        if (recentFilesOpen) setRecentAdvanceNonce((nonce) => nonce + 1);
        else openRecentFiles();
      },
    },
    {
      id: "workspace.navigateBack",
      title: "Navigate Back",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Left",
      when: () => navCan.back,
      run: () => navigateHistory(-1),
    },
    {
      id: "workspace.navigateForward",
      title: "Navigate Forward",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Right",
      when: () => navCan.forward,
      run: () => navigateHistory(1),
    },
    {
      id: "workspace.findInFiles",
      title: "Find in Files",
      category: "Search",
      keybinding: "Ctrl+Shift+F",
      keywords: ["text", "content", "grep"],
      run: openFindInFiles,
    },
    {
      id: "workspace.replaceInFiles",
      title: "Replace in Files",
      category: "Search",
      keybinding: "Ctrl+Shift+R",
      keywords: ["bulk replace"],
      run: () => {
        openFindInFiles();
        setStatusMessage("Enter a replace string and use Replace All in Find in Files");
      },
    },
    {
      id: "workspace.fileStructure",
      title: "File Structure",
      category: "Navigation",
      keybinding: "Ctrl+F12",
      keywords: ["outline", "symbol"],
      when: () => !!activeFile,
      run: () => void openStructurePopup(),
    },
    {
      id: "workspace.format",
      title: "Format Document",
      category: "Code",
      keybinding: "Ctrl+Alt+L",
      keywords: ["format", "prettier", "indent"],
      when: (context) => {
        if (context.focus === "tree" || context.focus === "terminal") return false;
        if (!activeFile || activeFile.loading) return false;
        // Prefer capability gate when status is known; if LSP has not
        // reported yet, still allow the command so the shortcut is live
        // as soon as the buffer is open (formatActiveFile no-ops without a formatter).
        if (!activeCapabilities) return true;
        return !!(activeCapabilities.formatting || activeCapabilities.rangeFormatting);
      },
      run: () => void formatActiveFile(),
    },
    {
      id: "workspace.quickDocumentation",
      title: "Quick Documentation",
      category: "Code",
      keybinding: "Ctrl+Q",
      keybindings: ["F1"],
      keywords: ["docs", "hover", "javadoc"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!activeFile && !activeFile.loading,
      run: () => void openQuickDocumentation(),
    },
    {
      id: "workspace.codeActions",
      title: "Show Code Actions / Quick Fix",
      category: "Code",
      keybinding: "Alt+Enter",
      keywords: ["quickfix", "bulb", "intention"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!activeFile && !activeFile.loading,
      run: () => void openCodeActionsAtCursor(),
    },
    {
      id: "workspace.gotoTypeDefinition",
      title: "Go to Type Definition",
      category: "Navigation",
      keybinding: "Ctrl+Shift+B",
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && (!activeCapabilities || !!activeCapabilities.typeDefinition),
      run: () => {
        const file = activeFile;
        if (!file) return;
        void goToTypeDefinitionRef.current(file, editorSelectionRef.current.start);
      },
    },
    {
      id: "workspace.gotoImplementation",
      title: "Go to Implementation",
      category: "Navigation",
      keybinding: "Ctrl+Alt+B",
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && (!activeCapabilities || !!activeCapabilities.implementation),
      run: () => {
        const file = activeFile;
        if (!file) return;
        void goToImplementationRef.current(file, editorSelectionRef.current.start);
      },
    },
    {
      id: "workspace.renameSymbol",
      title: "Rename Symbol",
      category: "Refactor",
      keybinding: "Shift+F6",
      keywords: ["refactor", "rename"],
      when: (context) => context.focus === "editor" && !!activeFile && !activeFile.loading
        && (!activeCapabilities || !!activeCapabilities.rename),
      run: () => void renameSymbolRef.current(),
    },
    {
      id: "workspace.toggleDocumentationPane",
      title: "Toggle Outline Pane",
      category: "View",
      keywords: ["right", "outline", "structure", "symbols"],
      run: toggleOutlinePane,
    },
    {
      id: "workspace.callHierarchy",
      title: "Call Hierarchy",
      category: "Navigation",
      keybinding: "Ctrl+Alt+H",
      keywords: ["callers", "callees", "calls"],
      when: (context) => context.focus === "editor" && !!activeFile
        && !!activeCapabilities?.callHierarchy,
      run: () => void openHierarchy("call"),
    },
    {
      id: "workspace.typeHierarchy",
      title: "Type Hierarchy",
      category: "Navigation",
      keybinding: "Ctrl+H",
      keywords: ["supertypes", "subtypes", "inheritance"],
      when: (context) => context.focus === "editor" && !!activeFile
        && !!activeCapabilities?.typeHierarchy,
      run: () => void openHierarchy("type"),
    },
    {
      id: "workspace.toggleInlayHints",
      title: `${intelligencePreferences.inlayHintsEnabled ? "Disable" : "Enable"} Inlay Hints`,
      category: "View",
      keywords: ["inlay", "hints", "types", "parameters"],
      run: toggleInlayHints,
    },
    {
      id: "workspace.toggleLanguageInlayHints",
      title: `${activeInlayHintsEnabled ? "Disable" : "Enable"} Inlay Hints for ${activeLanguageId ?? "Current Language"}`,
      category: "View",
      keywords: ["inlay", "language", "hints"],
      when: () => !!activeCapabilities?.inlayHint,
      run: toggleInlayHintsForActiveLanguage,
    },
    {
      id: "workspace.toggleInlineBlame",
      title: `${intelligencePreferences.inlineBlameEnabled ? "Disable" : "Enable"} Inline Git Blame`,
      category: "Git",
      keywords: ["git", "blame", "author", "line"],
      when: () => !!activeGitRoot,
      run: toggleInlineBlame,
    },
    {
      id: "workspace.toggleTerminal",
      title: "Toggle Workspace Terminal",
      category: "View",
      keybinding: "Alt+F12",
      keywords: ["terminal", "shell", "bottom"],
      run: () => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
        if (ui.bottomDockOpen && ui.bottomDockTab === "terminal") {
          setBottomDockOpen(false);
        } else {
          setBottomDockTab("terminal");
          setBottomDockOpen(true);
          terminalDockRef.current?.focus();
        }
      },
    },
    {
      id: "workspace.showRunTasks",
      title: "Show Run Tasks",
      category: "Run",
      keywords: ["run", "task", "script"],
      run: () => {
        setBottomDockTab("run");
        setBottomDockOpen(true);
      },
    },
    {
      id: "workspace.rerunLastTask",
      title: "Rerun Last Task",
      category: "Run",
      keybinding: "Ctrl+F5",
      keywords: ["run", "rerun", "repeat"],
      run: () => {
        if (!runPanelRef.current?.rerunLast()) setStatusMessage("No workspace task has run yet");
      },
    },
    {
      id: "workspace.save",
      title: "Save Active File",
      category: "File",
      keybinding: "Ctrl+S",
      when: () => !!activeFile?.dirty && !activeFile.loading && !activeFile.saving,
      run: () => void saveFile(),
    },
    {
      id: "workspace.closeActiveEditorTab",
      title: "Close Active Editor Tab",
      category: "File",
      keybinding: "Ctrl+F4",
      when: () => !!activeKey,
      run: () => {
        if (activeKey) void closeFile(activeKey, activeEditorGroupId);
      },
    },
    {
      id: "workspace.revealActiveFileInTree",
      title: "Reveal Active File in Project Tree",
      category: "Navigation",
      keybinding: "Alt+F1",
      when: () => !!activeKey,
      run: () => {
        if (activeKey) revealEditorTabInTree(activeKey);
      },
    },
    {
      id: "workspace.reload",
      title: "Reload Active File",
      category: "File",
      when: () => !!activeFile && !activeFile.loading,
      run: () => void reloadFile(),
    },
    {
      id: "workspace.refreshTree",
      title: "Refresh Project Tree",
      category: "File",
      run: refreshTree,
    },
    {
      id: "workspace.openGit",
      title: "Open Git Manager",
      category: "Git",
      when: () => !gitRootsLoading && !!onOpenGitManager && gitRoots.length > 0,
      run: openGitManager,
    },
    {
      id: "workspace.tree.openLooseFile",
      title: "Open Loose File",
      category: "File",
      run: () => void openLooseFile(),
    },
    {
      id: "workspace.tree.addFolder",
      title: "Add Folder to Workspace",
      category: "File",
      run: () => void addRoot(),
    },
    {
      id: "workspace.tree.open",
      title: "Open Selected File",
      category: "File",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        const selection = payload?.selection ?? selected;
        if (selection?.kind === "file") void openFile(selection.ref);
      },
    },
    {
      id: "workspace.tree.newFile",
      title: "New File",
      category: "File",
      when: (context) => context.focus !== "tree" || !!selectedRootDirectory,
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void createFile(payload?.directory);
      },
    },
    {
      id: "workspace.tree.newDirectory",
      title: "New Directory",
      category: "File",
      when: (context) => context.focus !== "tree" || !!selectedRootDirectory,
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void createDir(payload?.directory);
      },
    },
    {
      id: "workspace.tree.rename",
      title: "Rename Tree Selection",
      category: "Refactor",
      keybinding: "F2",
      when: (context) => context.focus === "tree" && !!((context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? selected),
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void renameSelected(payload?.selection);
      },
    },
    {
      id: "workspace.tree.delete",
      title: "Delete or Remove Tree Selection",
      category: "File",
      keybinding: "Delete",
      when: (context) => context.focus === "tree" && !!((context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? selected),
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void deleteSelected(payload?.selection);
      },
    },
    {
      id: "workspace.tree.findInDirectory",
      title: "Find in Selected Directory",
      category: "Search",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        findInDirectory(payload?.path ?? "");
      },
    },
    {
      id: "workspace.tree.copyPath",
      title: "Copy Absolute Path",
      category: "File",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        if (payload?.rootId !== undefined && payload.path !== undefined) {
          void copyTreePath(payload.rootId, payload.path, true);
        }
      },
    },
    {
      id: "workspace.tree.copyRelativePath",
      title: "Copy Relative Path",
      category: "File",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        if (payload?.rootId !== undefined && payload.path !== undefined) {
          void copyTreePath(payload.rootId, payload.path, false);
        }
      },
    },
  ], [
    activeCapabilities,
    activeEditorGroupId,
    activeFile,
    activeGitRoot,
    activeKey,
    activeInlayHintsEnabled,
    activeLanguageId,
    addRoot,
    closeFile,
    copyTreePath,
    createDir,
    createFile,
    deleteSelected,
    findInDirectory,
    formatActiveFile,
    gitRoots.length,
    gitRootsLoading,
    navCan.back,
    navCan.forward,
    navigateHistory,
    onOpenGitManager,
    openCodeActionsAtCursor,
    openFile,
    openFindInFiles,
    openGitManager,
    openHierarchy,
    openLooseFile,
    openQuickDocumentation,
    openRecentFiles,
    openSearchEverywhere,
    openStructurePopup,
    recentFilesOpen,
    refreshTree,
    reloadFile,
    revealEditorTabInTree,
    renameSelected,
    saveFile,
    seSymbolsAvailable,
    selected,
    selectedRootDirectory,
    intelligencePreferences.inlayHintsEnabled,
    intelligencePreferences.inlineBlameEnabled,
    toggleInlayHints,
    toggleInlayHintsForActiveLanguage,
    toggleInlineBlame,
    toggleOutlinePane,
  ]);

  const executeWorkspaceCommand = useCallback((
    commandId: string,
    context: WorkspaceCommandContext = { focus: "workspace" },
  ) => runWorkspaceCommand(workspaceCommands, commandId, context), [workspaceCommands]);
  workspaceCommandRunnerRef.current = executeWorkspaceCommand;

  const commandFocusForTarget = useCallback((target: EventTarget | null): WorkspaceCommandFocus => {
    const node = target instanceof Node ? target : null;
    if (!node) return "workspace";
    // Terminal dock (M3) marks itself with data-workspace-focus="terminal".
    const el = node instanceof Element ? node : node.parentElement;
    if (el?.closest('[data-workspace-focus="terminal"]')) return "terminal";
    if (treePaneRef.current?.contains(node)) return "tree";
    if (editorPaneRef.current?.contains(node)) return "editor";
    return "workspace";
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handleWorkspaceCommand = (event: KeyboardEvent) => {
      dispatchWorkspaceCommandKeydown(
        workspaceCommands,
        { focus: commandFocusForTarget(event.target) },
        event,
      );
    };
    window.addEventListener("keydown", handleWorkspaceCommand, true);
    return () => window.removeEventListener("keydown", handleWorkspaceCommand, true);
  }, [commandFocusForTarget, visible, workspaceCommands]);

  const searchableWorkspaceCommands = useMemo(
    () => workspaceCommands.filter((command) => (
      command.id !== "workspace.goToFile"
      && workspaceCommandEnabled(command, { focus: "workspace" })
    )),
    [workspaceCommands],
  );

  const runSearchEverywhereCommand = useCallback((commandId: string) => {
    setSearchEverywhereOpen(false);
    executeWorkspaceCommand(commandId);
  }, [executeWorkspaceCommand]);

  const commandRegistration = useMemo<WorkspaceCommandRegistration>(() => ({
    items: workspaceCommandMenuItems(workspaceCommands, { focus: "workspace" }),
    execute: (commandId) => executeWorkspaceCommand(commandId),
  }), [executeWorkspaceCommand, workspaceCommands]);

  useEffect(() => {
    if (!onCommandsChange) return;
    onCommandsChange(tabId, commandRegistration);
    return () => onCommandsChange(tabId, null);
  }, [commandRegistration, onCommandsChange, tabId]);

  const getLspCompletions = useCallback(
    async (
      file: OpenFileState,
      position: LspPosition,
      triggerCharacter: string | null,
    ): Promise<LspCompletionResult | null> => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return null;
      try {
        const result = await lspCompletion(descriptor, position, triggerCharacter);
        updateLspStatusForFile(file, result.status);
        return result;
      } catch {
        return null;
      }
    },
    [lspDescriptorForFile, updateLspStatusForFile],
  );

  const resolveLspCompletion = useCallback(
    async (file: OpenFileState, raw: unknown): Promise<LspCompletionItem | null> => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return null;
      try {
        return await lspCompletionResolve(descriptor, raw);
      } catch {
        return null;
      }
    },
    [lspDescriptorForFile],
  );

  const getLspSignatureHelp = useCallback(
    async (
      file: OpenFileState,
      position: LspPosition,
      triggerCharacter: string | null,
    ): Promise<LspSignatureHelpResult | null> => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return null;
      try {
        const result = await lspSignatureHelp(descriptor, position, triggerCharacter);
        updateLspStatusForFile(file, result.status);
        return result;
      } catch {
        return null;
      }
    },
    [lspDescriptorForFile, updateLspStatusForFile],
  );

  const getLspHover = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return null;
      try {
        const result = await lspHover(descriptor, position);
        updateLspStatusForFile(file, result.status);
        return result.contents;
      } catch (err) {
        setLspFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? emptyLspFileState()),
            error: errorMessage(err),
          },
        }));
        return null;
      }
    },
    [lspDescriptorForFile, updateLspStatusForFile],
  );

  const navigateLocations = useCallback(async (
    title: string,
    locations: LspLocation[],
    emptyMessage: string,
  ) => {
    if (!locations.length) {
      setStatusMessage(emptyMessage);
      return false;
    }
    if (locations.length === 1) {
      setLocationPeek(null);
      await openLspLocation(locations[0]);
      return true;
    }
    setLocationPeek({ title, locations });
    return true;
  }, [openLspLocation, setStatusMessage]);

  const goToDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      try {
        const result = await lspDefinition(descriptor, position);
        updateLspStatusForFile(file, result.status);
        return navigateLocations("Definitions", result.locations, "No definition found");
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [lspDescriptorForFile, navigateLocations, setStatusMessage, updateLspStatusForFile],
  );

  const goToTypeDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      const caps = lspFilesRef.current[file.key]?.status?.capabilities;
      if (caps && !caps.typeDefinition) {
        setStatusMessage("Type definition is not supported by this language server");
        return false;
      }
      try {
        const result = await lspTypeDefinition(descriptor, position);
        updateLspStatusForFile(file, result.status);
        return navigateLocations("Type definitions", result.locations, "No type definition found");
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [lspDescriptorForFile, navigateLocations, setStatusMessage, updateLspStatusForFile],
  );

  const goToImplementation = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      const caps = lspFilesRef.current[file.key]?.status?.capabilities;
      if (caps && !caps.implementation) {
        setStatusMessage("Go to implementation is not supported by this language server");
        return false;
      }
      try {
        const result = await lspImplementation(descriptor, position);
        updateLspStatusForFile(file, result.status);
        return navigateLocations("Implementations", result.locations, "No implementation found");
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [lspDescriptorForFile, navigateLocations, setStatusMessage, updateLspStatusForFile],
  );
  goToTypeDefinitionRef.current = goToTypeDefinition;
  goToImplementationRef.current = goToImplementation;

  const renameSymbolAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    const caps = lspFilesRef.current[file.key]?.status?.capabilities;
    if (caps && !caps.rename) {
      setStatusMessage("Rename is not supported by this language server");
      return;
    }
    const position = editorSelectionRef.current.start;
    try {
      const prepared = await lspPrepareRename(descriptor, position);
      updateLspStatusForFile(file, prepared.status);
      if (!prepared.allowed && prepared.range == null && !prepared.placeholder) {
        setStatusMessage(prepared.message ?? "Cannot rename symbol here");
        return;
      }
      const defaultName = prepared.placeholder
        ?? (() => {
          const lines = file.text.split("\n");
          const line = lines[position.line] ?? "";
          if (prepared.range) {
            return line.slice(prepared.range.start.character, prepared.range.end.character);
          }
          return line.slice(position.character).match(/^[A-Za-z0-9_$]+/)?.[0] ?? "";
        })();
      const nextName = await promptAppDialog({
        title: "Rename Symbol",
        label: "New name",
        initialValue: defaultName,
        confirmLabel: "Rename",
      });
      if (!nextName || nextName === defaultName) return;
      const renamed = await lspRename(descriptor, position, nextName);
      updateLspStatusForFile(file, renamed.status);
      if (!renamed.edit.documentEdits.length) {
        setStatusMessage("Rename produced no edits");
        return;
      }
      const fileCount = renamed.edit.documentEdits.length;
      if (fileCount > 1) {
        const confirmed = await confirmAppDialog({
          title: "Rename across files",
          message: `This rename touches ${fileCount} files. Apply non-atomic WorkspaceEdit?`,
          confirmLabel: "Apply",
        });
        if (!confirmed) return;
      }
      await applyLspWorkspaceEdit(renamed.edit);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [activeFile, applyLspWorkspaceEdit, lspDescriptorForFile, setStatusMessage, updateLspStatusForFile]);
  renameSymbolRef.current = renameSymbolAtCursor;

  const findReferences = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return;
      setBottomDockOpen(true);
      setBottomDockTab("references");
      setReferencesResult({
        loading: true,
        origin: file.subtitle,
        locations: [],
        error: null,
      });
      try {
        const result = await lspReferences(descriptor, position, true);
        updateLspStatusForFile(file, result.status);
        setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: result.locations,
          error: null,
        });
        setStatusMessage(`${result.locations.length} reference${result.locations.length === 1 ? "" : "s"} found`);
      } catch (err) {
        setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: [],
          error: errorMessage(err),
        });
      }
    },
    [lspDescriptorForFile, setStatusMessage, updateLspStatusForFile],
  );

  const dirtyCount = useMemo(
    () => Object.values(openFiles).filter((file) => file.dirty).length,
    [openFiles],
  );
  const dirtyFiles = useMemo(
    () => openOrder.map((key) => openFiles[key]).filter((file): file is OpenFileState => !!file?.dirty),
    [openFiles, openOrder],
  );
  const problemFiles = useMemo<ProblemFileGroup[]>(
    () => openOrder.flatMap((key) => {
      const file = openFiles[key];
      const diagnostics = lspFiles[key]?.diagnostics ?? [];
      return file && diagnostics.length > 0
        ? [{ key, title: file.title, subtitle: file.subtitle, diagnostics }]
        : [];
    }),
    [lspFiles, openFiles, openOrder],
  );
  const problemCounts = useMemo(
    () => problemFiles.reduce(
      (counts, file) => {
        for (const diagnostic of file.diagnostics) {
          if (diagnostic.severity === 1) counts.errors += 1;
          else if (diagnostic.severity === 2) counts.warnings += 1;
        }
        return counts;
      },
      { errors: 0, warnings: 0 },
    ),
    [problemFiles],
  );
  const openProblem = useCallback(
    (fileKeyValue: string, diagnostic: LspDiagnostic) => {
      const file = openFilesRef.current[fileKeyValue];
      if (!file) return;
      revealEditorLocation(file.key, diagnostic.range);
      void openFile(file.ref);
    },
    [openFile, revealEditorLocation],
  );
  useEffect(() => {
    if (!onSyncGitManager || !gitManagerPayload) return;
    onSyncGitManager(gitManagerPayload);
  }, [gitManagerPayload, onSyncGitManager]);

  useEffect(() => {
    const firstRoot = roots[0] ?? null;
    const openStates = openOrder.map((key) => openFiles[key]).filter((file): file is OpenFileState => !!file);
    const toContextFile = (file: OpenFileState) => {
      const ref = file.ref;
      if (ref.kind === "root") {
        const root = roots.find((item) => item.id === ref.rootId);
        return {
          kind: "root" as const,
          rootId: ref.rootId,
          rootName: root?.name,
          rootPath: root?.path,
          path: ref.path,
        };
      }
      const loose = looseFiles.find((item) => item.id === ref.id);
      return {
        kind: "loose" as const,
        id: ref.id,
        name: loose?.name,
        path: ref.path,
      };
    };
    const lspDiagnostics = openStates
      .map((file) => {
        const diagnostics = lspFiles[file.key]?.diagnostics ?? [];
        if (diagnostics.length === 0) return null;
        return {
          file: toContextFile(file),
          errorCount: diagnostics.filter((item) => item.severity === 1).length,
          warningCount: diagnostics.filter((item) => item.severity === 2).length,
          infoCount: diagnostics.filter((item) => item.severity !== 1 && item.severity !== 2).length,
          messages: diagnostics
            .slice()
            .sort((a, b) => (a.severity ?? 99) - (b.severity ?? 99))
            .slice(0, 5)
            .map((item) => item.message),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item);
    const activeStatus = activeLspState?.status
      ? {
          displayName: activeLspState.status.displayName,
          languageId: activeLspState.status.languageId,
          active: activeLspState.status.active,
          available: activeLspState.status.available,
          selectedCommand: activeLspState.status.selectedCommand,
          installHint: activeLspState.status.installHint,
          error: activeLspState.status.error ?? activeLspState.error,
        }
      : null;
    const lspContext = activeStatus || lspDiagnostics.length > 0
      ? {
          activeStatus,
          diagnostics: lspDiagnostics,
        }
      : null;
    setTabCodeWorkspaceContext(tabId, {
      repoRoot: firstRoot?.path ?? workspace.repoRoot ?? "",
      activePath: activeFile?.ref.kind === "root" && activeFile.ref.rootId === firstRoot?.id ? activeFile.ref.path : null,
      openPaths: firstRoot ? openStates.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      dirtyPaths: firstRoot ? dirtyFiles.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      roots,
      looseFiles,
      activeFile: activeFile ? toContextFile(activeFile) : null,
      openFiles: openStates.map(toContextFile),
      dirtyFiles: dirtyFiles.map(toContextFile),
      lsp: lspContext,
    });
  }, [activeFile, activeLspState, dirtyFiles, looseFiles, lspFiles, openFiles, openOrder, roots, setTabCodeWorkspaceContext, tabId, workspace.repoRoot]);

  useEffect(() => {
    return () => setTabCodeWorkspaceContext(tabId, null);
  }, [setTabCodeWorkspaceContext, tabId]);

  const renderEditorGroup = (groupId: EditorGroupId) => {
    const group = editorGroups[groupId];
    const groupFile = group.activeKey ? openFiles[group.activeKey] ?? null : null;
    const groupLspState = group.activeKey ? lspFiles[group.activeKey] ?? null : null;
    const groupDiagnostics = groupLspState?.diagnostics ?? [];
    const groupCapabilities = groupLspState?.status?.capabilities ?? null;
    const groupMarkdownMode = groupFile && isMarkdownPath(groupFile.languagePath)
      ? markdownModes[groupFile.key] ?? "edit"
      : "edit";
    const groupBreadcrumbSegments = groupId === activeEditorGroupId
      ? breadcrumbPathSegments
      : groupFile ? breadcrumbSegmentsForFile(groupFile, roots) : [];

    return (
      <EditorGroup
        groupId={groupId}
        workspaceInstanceId={`${workspaceInstanceId}-${groupId}`}
        visible={visible}
        openOrder={group.openOrder}
        openFiles={openFiles}
        activeKey={group.activeKey}
        previewKey={group.previewKey}
        pinnedKeys={group.pinnedKeys}
        activeFile={groupFile}
        activeMarkdownMode={groupMarkdownMode}
        activeDiagnostics={groupDiagnostics}
        activeHighlights={highlightsByGroup[groupId]}
        activeInlayHints={inlayHintsByGroup[groupId]}
        activeGitChanges={groupFile ? gitLineChangesByFile[groupFile.key] ?? [] : []}
        activeGitBlame={gitBlameByGroup[groupId]}
        activeCapabilities={groupCapabilities}
        activeLspSyncing={!!groupLspState?.syncing}
        lspStatusPill={<LspStatusPill state={groupLspState} diagnostics={groupDiagnostics} />}
        breadcrumbs={groupFile ? (
          <Breadcrumbs
            pathSegments={groupBreadcrumbSegments}
            symbols={breadcrumbSymbolsByGroup[groupId]}
            position={cursorPositions[groupId]}
            onPathClick={(segment) => {
              if (groupFile.ref.kind !== "root") return;
              const rootId = groupFile.ref.rootId;
              if (segment.kind === "root") {
                setSelected({ kind: "root", rootId });
              } else if (segment.kind === "directory") {
                setSelected({ kind: "dir", rootId, path: segment.path });
                setExpandedDirs((current) => new Set(current).add(rootDirKey(rootId, segment.path)));
                void loadDir(rootId, segment.path);
              } else {
                setSelected({ kind: "file", ref: groupFile.ref });
              }
            }}
            onSymbolClick={(symbol) => revealEditorLocation(groupFile.key, symbol.selectionRange)}
          />
        ) : null}
        revealTarget={revealTarget}
        editorPaneRef={groupId === activeEditorGroupId ? editorPaneRef : inactiveEditorPaneRef}
        editorPaneStyle={editorPaneStyle}
        onActivate={(key) => {
          updateEditorGroup(groupId, (current) => ({ ...current, activeKey: key }));
          activateEditorGroup(groupId);
        }}
        onActivateGroup={() => activateEditorGroup(groupId)}
        onClose={(key) => void closeFile(key, groupId)}
        onPin={(key, pinned) => setTabPinned(groupId, key, pinned)}
        onPromotePreview={(key) => promotePreviewTab(groupId, key)}
        onCloseOthers={(key) => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          void closeGroupFiles(groupId, latest.openOrder.filter(
            (entry) => entry !== key && !latest.pinnedKeys.includes(entry),
          ));
        }}
        onCloseRight={(key) => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          const index = latest.openOrder.indexOf(key);
          void closeGroupFiles(groupId, latest.openOrder.slice(index + 1).filter(
            (entry) => !latest.pinnedKeys.includes(entry),
          ));
        }}
        onCloseUnmodified={() => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          void closeGroupFiles(groupId, latest.openOrder.filter(
            (entry) => !openFilesRef.current[entry]?.dirty,
          ));
        }}
        onCloseAll={() => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          void closeGroupFiles(groupId, latest.openOrder);
        }}
        onSplitRight={(key) => splitEditor("vertical", key, groupId)}
        onSplitDown={(key) => splitEditor("horizontal", key, groupId)}
        onCopyPath={(key, absolute) => void copyEditorTabPath(key, absolute)}
        onRevealInTree={revealEditorTabInTree}
        onRevealInSystem={revealEditorTabInExplorer}
        onOpenInTerminal={openEditorTabInTerminal}
        onLocalHistory={openLocalHistoryForKey}
        onMarkdownModeChange={(mode) => {
          if (!groupFile) return;
          setMarkdownModes((current) => ({ ...current, [groupFile.key]: mode }));
        }}
        onChangeText={updateFileText}
        onSave={(key) => void saveFile(key)}
        onHover={getLspHover}
        onDefinition={goToDefinition}
        onReferences={findReferences}
        onComplete={getLspCompletions}
        onCompleteResolve={resolveLspCompletion}
        onSignatureHelp={getLspSignatureHelp}
        onSelectionChange={(selection) => {
          if (groupId === activeEditorGroupId) {
            editorSelectionRef.current = selection;
            setEditorAiSelection(!selection.empty && selection.text.trim().length >= 2 ? selection : null);
          }
          setCursorPositions((current) => ({ ...current, [groupId]: selection.end }));
        }}
        onViewportChange={(range) => {
          setViewportRanges((current) => ({ ...current, [groupId]: range }));
        }}
        onExpandSelection={getLspSelectionRanges}
        onLightbulb={(line) => void openCodeActionsForLine(line)}
        onOpenMarkdownHref={openMarkdownHref}
        formatBytes={formatBytes}
        formatMtime={formatMtime}
        isMarkdownPath={isMarkdownPath}
        renderMarkdownPreview={(file, onOpenHref) => (
          <MarkdownPreview file={file} onOpenHref={onOpenHref} />
        )}
      />
    );
  };

  return (
    <div
      ref={rootRef}
      data-testid="code-workspace-tab"
      className="relative h-full w-full min-h-0 flex flex-col overflow-hidden bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)]"
    >
      <header className="h-10 shrink-0 flex items-center gap-2 overflow-x-auto px-3 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]">
        <Braces className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="min-w-0">
          <div className="font-semibold leading-4 truncate">Code · {title}</div>
          <div className="text-[11px] text-[var(--taomni-code-muted)] truncate max-w-[620px]">
            {roots.length ? `${roots.length} root${roots.length === 1 ? "" : "s"}` : "No project roots"}
            {looseFiles.length > 0 ? ` · ${looseFiles.length} loose file${looseFiles.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        {dirtyCount > 0 && (
          <span className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[11px] bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-accent)]">
            {dirtyCount} unsaved
          </span>
        )}
        <div className="flex-1" />
        <IconButton
          label="Back"
          testId="code-workspace-nav-back"
          icon={<ArrowLeft className="w-3.5 h-3.5" />}
          disabled={!navCan.back}
          onClick={() => executeWorkspaceCommand("workspace.navigateBack")}
        />
        <IconButton
          label="Forward"
          testId="code-workspace-nav-forward"
          icon={<ArrowRight className="w-3.5 h-3.5" />}
          disabled={!navCan.forward}
          onClick={() => executeWorkspaceCommand("workspace.navigateForward")}
        />
        <div className="flex items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1">
          <IconButton
            label="Editor zoom out"
            testId="code-workspace-zoom-out"
            icon={<ZoomOut className="w-3.5 h-3.5" />}
            disabled={codeViewProfile.fontSize <= CODE_WORKSPACE_MIN_FONT_SIZE}
            onClick={() => stepCodeViewFontSize(-1)}
          />
          <button
            type="button"
            data-testid="code-workspace-zoom-reset"
            title="Reset editor zoom"
            aria-label="Reset editor zoom"
            className="h-6 min-w-10 rounded px-1.5 text-[11px] tabular-nums text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={() => setCodeViewFontSize(DEFAULT_CODE_VIEW_PROFILE.fontSize)}
          >
            {codeViewProfile.fontSize}px
          </button>
          <IconButton
            label="Editor zoom in"
            testId="code-workspace-zoom-in"
            icon={<ZoomIn className="w-3.5 h-3.5" />}
            disabled={codeViewProfile.fontSize >= CODE_WORKSPACE_MAX_FONT_SIZE}
            onClick={() => stepCodeViewFontSize(1)}
          />
        </div>
        <IconButton
          label="Save"
          icon={activeFile?.saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          disabled={!activeFile || !activeFile.dirty || activeFile.saving || activeFile.loading}
          onClick={() => executeWorkspaceCommand("workspace.save", { focus: "editor" })}
        />
        <IconButton
          label="Reload"
          icon={<RotateCcw className="w-3.5 h-3.5" />}
          disabled={!activeFile || activeFile.loading}
          onClick={() => executeWorkspaceCommand("workspace.reload", { focus: "editor" })}
        />
        <IconButton
          label="Refresh tree"
          icon={<RefreshCw className="w-3.5 h-3.5" />}
          onClick={() => executeWorkspaceCommand("workspace.refreshTree")}
        />
        <IconButton
          label="Open Git tab"
          testId="code-workspace-git-panel-toggle"
          icon={gitRootsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
          disabled={gitRootsLoading || !onOpenGitManager || gitRoots.length === 0}
          onClick={() => executeWorkspaceCommand("workspace.openGit")}
        />
        <IconButton
          label="Split editor right"
          testId="code-workspace-split-right"
          icon={<Columns2 className="h-3.5 w-3.5" />}
          active={splitOrientation === "vertical"}
          disabled={!activeFile}
          onClick={() => splitEditor("vertical")}
        />
        <IconButton
          label="Split editor down"
          testId="code-workspace-split-down"
          icon={<Rows2 className="h-3.5 w-3.5" />}
          active={splitOrientation === "horizontal"}
          disabled={!activeFile}
          onClick={() => splitEditor("horizontal")}
        />
        {splitOrientation && (
          <IconButton
            label="Close editor split"
            testId="code-workspace-split-close"
            icon={<X className="h-3.5 w-3.5" />}
            onClick={closeSplit}
          />
        )}
        <IconButton
          label={`${activeInlayHintsEnabled ? "Disable" : "Enable"} inlay hints${activeLanguageId ? ` for ${activeLanguageId}` : ""}`}
          testId="code-workspace-inlay-hints-toggle"
          icon={<Braces className="h-3.5 w-3.5" />}
          active={activeInlayHintsEnabled}
          disabled={!activeCapabilities?.inlayHint}
          onClick={toggleInlayHintsForActiveLanguage}
        />
        <IconButton
          label={`${intelligencePreferences.inlineBlameEnabled ? "Disable" : "Enable"} inline Git blame`}
          testId="code-workspace-inline-blame-toggle"
          icon={<GitCommitHorizontal className="h-3.5 w-3.5" />}
          active={intelligencePreferences.inlineBlameEnabled}
          disabled={!activeGitRoot}
          onClick={toggleInlineBlame}
        />
        <IconButton
          label="Toggle outline pane"
          testId="code-workspace-right-pane-toggle"
          icon={<PanelRight className="w-3.5 h-3.5" />}
          active={rightPaneOpen && rightPaneTab === "outline"}
          onClick={() => executeWorkspaceCommand("workspace.toggleDocumentationPane")}
        />
      </header>

      <PanelGroup
        orientation="horizontal"
        id={`code-workspace-${workspaceInstanceId}`}
        className="flex-1 min-h-0"
      >
        <Panel id="project" defaultSize="24%" minSize="15%" maxSize="45%" className="min-w-0">
          <FileTreePane
            paneRef={treePaneRef}
            style={treePaneStyle}
            onKeyDown={handleTreeKeyDown}
            filter={treeFilter}
            onFilterChange={setTreeFilter}
            viewMode={treeViewMode}
            onViewModeChange={setTreeViewMode}
            fontSize={treeFontSize}
            minFontSize={CODE_WORKSPACE_MIN_TREE_FONT_SIZE}
            maxFontSize={CODE_WORKSPACE_MAX_TREE_FONT_SIZE}
            defaultFontSize={CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE}
            onFontSizeChange={setTreeFontSize}
            onOpenFile={() => executeWorkspaceCommand("workspace.tree.openLooseFile", { focus: "tree" })}
            onAddFolder={() => executeWorkspaceCommand("workspace.tree.addFolder", { focus: "tree" })}
            canCreate={!!selectedRootDirectory}
            canMutateSelection={!!selected}
            onCreateFile={() => executeWorkspaceCommand("workspace.tree.newFile", { focus: "tree" })}
            onCreateDirectory={() => executeWorkspaceCommand("workspace.tree.newDirectory", { focus: "tree" })}
            onRename={() => executeWorkspaceCommand("workspace.tree.rename", { focus: "tree" })}
            onDelete={() => executeWorkspaceCommand("workspace.tree.delete", { focus: "tree" })}
            languageServers={{
              open: languagePanelOpen,
              statuses: lspServerStatuses,
              activeStatus: activeLspState?.status ?? null,
              commandPrefs: lspCommandPrefs,
              customCommands: lspCustomCommands,
              customCommandId: CUSTOM_LSP_COMMAND_ID,
              onToggle: () => setLanguagePanelOpen((value) => !value),
              onRefresh: () => void refreshLspServerStatuses(),
              onCommandChange: updateLspCommandPref,
              onCustomCommandChange: updateLspCustomCommand,
            }}
          >
              <ProjectTree
                roots={roots}
                looseFiles={looseFiles}
                directories={directories}
                compactChains={compactChains}
                flatFiles={flatFiles}
                treeViewMode={treeViewMode}
                treeFilter={treeFilter}
                expandedRoots={expandedRoots}
                expandedDirs={expandedDirs}
                selected={selected}
                activeKey={activeKey}
                openFiles={openFiles}
                gitChangeByRootPath={gitChangeByRootPath}
                onToggleRoot={toggleRoot}
                onToggleDir={toggleDir}
                onSelect={setSelected}
                onOpenFile={(ref, options) => { void openFile(ref, options); }}
                onContextMenu={showTreeContextMenu}
              />
          </FileTreePane>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
        <Panel id="editor" defaultSize={rightPaneOpen ? "56%" : "76%"} minSize="35%" className="min-w-0">
          {splitOrientation ? (
            <div data-testid="code-workspace-editor-split" className="h-full min-h-0">
              <PanelGroup
                orientation={splitOrientation === "vertical" ? "horizontal" : "vertical"}
                id={`code-workspace-editor-split-${workspaceInstanceId}`}
                className="h-full min-h-0"
              >
                <Panel id="editor-primary" defaultSize="50%" minSize="20%" className="min-h-0 min-w-0">
                  {renderEditorGroup("primary")}
                </Panel>
                <PanelResizeHandle
                  className={splitOrientation === "vertical"
                    ? "w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"
                    : "h-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"}
                />
                <Panel id="editor-secondary" defaultSize="50%" minSize="20%" className="min-h-0 min-w-0">
                  {renderEditorGroup("secondary")}
                </Panel>
              </PanelGroup>
            </div>
          ) : renderEditorGroup("primary")}
        </Panel>
        {rightPaneOpen && (
          <>
            <PanelResizeHandle className="w-1 bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] transition-colors" />
            <Panel
              id="documentation"
              defaultSize="20%"
              minSize="12%"
              maxSize="40%"
              className="min-w-0"
            >
              <aside
                data-testid="code-workspace-right-pane"
                className="h-full min-h-0 flex flex-col border-l border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
              >
                <div role="tablist" aria-label="Right tool window" className="flex h-8 shrink-0 items-center border-b border-[var(--taomni-code-border)] px-1">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={rightPaneTab === "outline"}
                    className="inline-flex h-7 items-center gap-1 rounded px-2 text-[10px] text-[var(--taomni-code-muted)] aria-selected:bg-[var(--taomni-code-active-line-bg)] aria-selected:text-[var(--taomni-code-text)]"
                    onClick={() => setRightPaneTab("outline")}
                  >
                    <ListTree className="h-3.5 w-3.5" />
                    Outline
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={rightPaneTab === "documentation"}
                    className="inline-flex h-7 items-center gap-1 rounded px-2 text-[10px] text-[var(--taomni-code-muted)] aria-selected:bg-[var(--taomni-code-active-line-bg)] aria-selected:text-[var(--taomni-code-text)]"
                    onClick={() => setRightPaneTab("documentation")}
                  >
                    <BookOpen className="h-3.5 w-3.5" />
                    Documentation
                  </button>
                  <button
                    type="button"
                    aria-label="Close right pane"
                    className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                    onClick={() => setRightPaneOpen(false)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div role="tabpanel" className="min-h-0 flex-1">
                  {rightPaneTab === "outline" ? (
                    <OutlinePane
                      symbols={breadcrumbSymbolsByGroup[activeEditorGroupId]}
                      position={cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 }}
                      loading={!!activeFile && (!!activeLspState?.syncing || (activeCapabilities?.documentSymbol === true && !activeLspState?.status))}
                      unavailableReason={!activeFile
                        ? "Open a file to view its outline"
                        : activeCapabilities?.documentSymbol === false
                          ? "Document symbols are not supported by this language server"
                          : null}
                      onPick={pickOutlineSymbol}
                    />
                  ) : (
                    <DocumentationPane
                      content={pinnedDoc}
                      locked={pinnedDocLocked}
                      onUnlock={() => setPinnedDocLocked(false)}
                      onClear={() => {
                        setPinnedDoc(null);
                        setPinnedDocLocked(false);
                      }}
                    />
                  )}
                </div>
              </aside>
            </Panel>
          </>
        )}
      </PanelGroup>
      <BottomDock
        open={bottomDockOpen}
        activeTab={bottomDockTab}
        tabs={[
          {
            id: "problems",
            label: "Problems",
            icon: <AlertTriangle className="h-3.5 w-3.5" />,
            badge: problemCounts.errors > 0 || problemCounts.warnings > 0 ? (
              <span className="inline-flex items-center gap-1">
                {problemCounts.errors > 0 && <span className="text-red-500">{problemCounts.errors}</span>}
                {problemCounts.warnings > 0 && <span className="text-amber-500">{problemCounts.warnings}</span>}
              </span>
            ) : undefined,
            content: (
              <ProblemsPanel
                files={problemFiles}
                onOpenProblem={openProblem}
                onQuickFix={(fileKey, diagnostic) => void openQuickFixForProblem(fileKey, diagnostic)}
              />
            ),
          },
          {
            id: "search",
            label: "Search",
            icon: <Search className="h-3.5 w-3.5" />,
            content: (
              <FindInFilesPanel
                roots={roots}
                workspaceInstanceId={workspaceInstanceId}
                focusNonce={searchFocusNonce}
                includePreset={searchIncludePreset}
                queryPreset={searchQueryPreset}
                onOpenMatch={openSearchMatch}
                onReplaceMatches={async (matches, replacement) => {
                  const edit = buildReplaceWorkspaceEdit(matches, replacement);
                  await applyLspWorkspaceEdit(edit);
                }}
              />
            ),
          },
          {
            id: "references",
            label: "References",
            icon: <ListTree className="h-3.5 w-3.5" />,
            badge: referencesResult.locations.length,
            content: (
              <ReferencesPanel
                result={referencesResult}
                roots={roots}
                onOpenLocation={(location) => void openLspLocation(location)}
              />
            ),
          },
          {
            id: "call-hierarchy",
            label: "Call Hierarchy",
            icon: <GitFork className="h-3.5 w-3.5" />,
            content: (
              <HierarchyPanel
                mode="call"
                root={callHierarchyRoot}
                active={bottomDockOpen && bottomDockTab === "call-hierarchy"}
                onOpenLocation={(location) => void openLspLocation(location)}
                onStatus={(status) => {
                  if (activeFile) updateLspStatusForFile(activeFile, status);
                }}
              />
            ),
          },
          {
            id: "type-hierarchy",
            label: "Type Hierarchy",
            icon: <Network className="h-3.5 w-3.5" />,
            content: (
              <HierarchyPanel
                mode="type"
                root={typeHierarchyRoot}
                active={bottomDockOpen && bottomDockTab === "type-hierarchy"}
                onOpenLocation={(location) => void openLspLocation(location)}
                onStatus={(status) => {
                  if (activeFile) updateLspStatusForFile(activeFile, status);
                }}
              />
            ),
          },
          {
            id: "terminal",
            label: "Terminal",
            icon: <TerminalSquare className="h-3.5 w-3.5" />,
            badge: undefined,
            content: (
              <TerminalDockPanel
                ref={terminalDockRef}
                workspaceInstanceId={workspaceInstanceId}
                roots={roots}
                defaultCwd={activeRoot?.path ?? roots[0]?.path ?? ""}
                active={bottomDockOpen && bottomDockTab === "terminal"}
              />
            ),
          },
          {
            id: "run",
            label: "Run",
            icon: <Play className="h-3.5 w-3.5" />,
            content: (
              <RunPanel
                ref={runPanelRef}
                workspaceInstanceId={workspaceInstanceId}
                roots={roots}
                active={bottomDockOpen && bottomDockTab === "run"}
                onRun={(task, onExit) => {
                  terminalDockRef.current?.runCommand(
                    task.command,
                    task.cwd,
                    `Run: ${task.label}`,
                    onExit,
                  );
                  setBottomDockTab("terminal");
                  setBottomDockOpen(true);
                }}
              />
            ),
          },
        ]}
        onOpenChange={setBottomDockOpen}
        onActiveTabChange={(tab) => setBottomDockTab(tab as BottomDockTabId)}
      />
      <WorkspacePopupsHost
        searchEverywhereOpen={searchEverywhereOpen}
        searchEverywhereMode={searchEverywhereMode}
        goToFileItems={goToFileItems}
        goToFileLoading={goToFileLoading}
        goToFileTruncated={goToFileTruncated}
        searchableCommands={searchableWorkspaceCommands}
        symbolsAvailable={seSymbolsAvailable}
        fetchWorkspaceSymbols={fetchWorkspaceSymbols}
        onCloseSearchEverywhere={() => setSearchEverywhereOpen(false)}
        onOpenFileItem={openGoToFileItem}
        onOpenSymbol={(symbol) => void openWorkspaceSymbol(symbol)}
        onRunCommand={runSearchEverywhereCommand}
        onSearchText={(query) => {
          setSearchEverywhereOpen(false);
          setBottomDockOpen(true);
          setBottomDockTab("search");
          setSearchFocusNonce((nonce) => nonce + 1);
          setSearchQueryPreset((current) => ({ value: query, nonce: current.nonce + 1 }));
        }}
        recentFilesOpen={recentFilesOpen}
        recentEntries={recentEntries}
        recentAdvanceNonce={recentAdvanceNonce}
        onCloseRecent={() => setRecentFilesOpen(false)}
        onPickRecent={pickRecentFile}
        structureOpen={structureOpen}
        structureFileTitle={activeFile?.title ?? null}
        structureSymbols={structureSymbols}
        structureLoading={structureLoading}
        structureUnavailable={structureUnavailable}
        onCloseStructure={() => setStructureOpen(false)}
        onPickStructure={pickStructureSymbol}
        quickDocOpen={quickDocOpen}
        quickDocContent={quickDocContent}
        onCloseQuickDoc={() => setQuickDocOpen(false)}
        onPinQuickDoc={pinQuickDocumentation}
        locationPeek={locationPeek}
        onCloseLocationPeek={() => setLocationPeek(null)}
        onOpenLocation={(location) => {
          setLocationPeek(null);
          void openLspLocation(location);
        }}
      />
      {treeContextMenu.render}
      {localHistoryTarget && openFiles[localHistoryTarget.key] && (
        <LocalHistoryDialog
          path={localHistoryTarget.path}
          currentText={openFiles[localHistoryTarget.key].text}
          onClose={() => setLocalHistoryTarget(null)}
          onRestore={(text) => restoreLocalHistoryText(localHistoryTarget.key, text)}
        />
      )}
      <EditorSelectionAiToolbar
        visible={!!editorAiSelection && !aiRewriteState}
        rect={editorAiSelection?.rect ?? null}
        selectionText={editorAiSelection?.text ?? ""}
        onAction={(action, text) => {
          void handleEditorAiAction(action, text);
        }}
        onDismiss={() => setEditorAiSelection(null)}
      />
      {aiRewriteState && (
        <EditorAiRewriteDialog
          path={aiRewriteState.path}
          original={aiRewriteState.original}
          proposal={aiRewriteState.proposal}
          instruction={aiRewriteState.instruction}
          onInstructionChange={(value) => setAiRewriteState((current) => (
            current ? { ...current, instruction: value } : current
          ))}
          onProposalChange={(value) => setAiRewriteState((current) => (
            current ? { ...current, proposal: value } : current
          ))}
          onClose={() => setAiRewriteState(null)}
          onRegenerate={() => {
            const prompt = [
              `请按指令改写下面的代码，只返回改写后的完整代码块。`,
              `文件: ${aiRewriteState.path}`,
              `指令: ${aiRewriteState.instruction || "Rewrite the selected code"}`,
              "",
              "```",
              aiRewriteState.original,
              "```",
            ].join("\n");
            void attachToComposer(prompt);
            setStatusMessage("Re-staged rewrite prompt in AI chat");
          }}
          onApply={() => {
            applySelectionReplacement(aiRewriteState.key, aiRewriteState.range, aiRewriteState.proposal);
            setAiRewriteState(null);
            setStatusMessage("Applied AI proposal to the selection");
          }}
        />
      )}
    </div>
  );
}
