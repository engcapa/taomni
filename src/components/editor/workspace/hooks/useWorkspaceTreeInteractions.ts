import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef } from "react";
import { writeText } from "../../../../lib/clipboard";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { useContextMenu, type ContextMenuCloseReason } from "../../../ContextMenu";
import { type BreadcrumbPathChild } from "../Breadcrumbs";
import { basename, errorMessage, normalizeFsPath, parentPath, rootDirKey, type OpenFileState, type TreeSelection } from "../codeWorkspaceModel";
import { createBreadcrumbPathActions, createLoadBreadcrumbPathChildren, createShowTreeContextMenu } from "../controller/treeActions";
import { type TerminalDockHandle } from "../panels/TerminalDockPanel";
import { navigateProjectTree } from "../projectTreeNavigation";
import { useWorkspaceFileActions } from "../useWorkspaceFileActions";
import { useWorkspaceTreeData } from "../useWorkspaceTreeData";
import { type WorkspaceCommandContext } from "../workspaceCommands";
import { useWorkspaceEditorCommands } from "./useWorkspaceEditorCommands";
import { useWorkspaceToolWindowRouting } from "./useWorkspaceToolWindowRouting";
import { useWorkspaceTreeFocusState } from "./useWorkspaceTreeFocusState";
import { useWorkspaceTreeOpening } from "./useWorkspaceTreeOpening";
import { useWorkspaceUiActions } from "./useWorkspaceUiActions";


export interface UseWorkspaceTreeInteractionsContext {
  treeFocus: ReturnType<typeof useWorkspaceTreeFocusState>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  fileActions: ReturnType<typeof useWorkspaceFileActions>;
  setStatusMessage: (message: string) => void;
  toolWindowRouting: ReturnType<typeof useWorkspaceToolWindowRouting>;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  treeData: ReturnType<typeof useWorkspaceTreeData>;
  roots: CodeWorkspaceRootInfo[];
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  openTerminalAt: (rootId: string, path: string, pathIsFile?: boolean) => void;
  terminalDockRef: import("react").RefObject<TerminalDockHandle | null>;
  selected: TreeSelection | null;
  getSelected?: () => TreeSelection | null;
  treeOpening: ReturnType<typeof useWorkspaceTreeOpening>;
  editorCommands: ReturnType<typeof useWorkspaceEditorCommands>;
  workspaceCommandRunnerRef: import("react").RefObject<(commandId: string, context?: WorkspaceCommandContext) => boolean>;
  workspaceInstanceId: string;
}

export function useWorkspaceTreeInteractions(context: UseWorkspaceTreeInteractionsContext) {
  const {
    treeFocus,
    openFilesRef,
    fileActions,
    setStatusMessage,
    toolWindowRouting,
    uiActions,
    treeData,
    roots,
    rootsRef,
    openFile,
    openTerminalAt,
    terminalDockRef,
    selected,
    getSelected,
    treeOpening,
    editorCommands,
    workspaceCommandRunnerRef,
    workspaceInstanceId,
  } = context;

  const treeContextMenuSessionRef = useRef<{
    workspaceInstanceId: string;
    selection: TreeSelection | null;
    consumed: boolean;
  } | null>(null);

  const handleTreeContextMenuClose = useCallback((reason?: ContextMenuCloseReason) => {
    const session = treeContextMenuSessionRef.current;
    treeContextMenuSessionRef.current = null;
    if (!session || session.consumed) {
      return;
    }
    if (reason !== "escape") return;
    // ED-TREEOPEN-001 / DEC-TOF-04: Esc gives focus back to the tree row the
    // menu acted on. useContextMenu notifies after the menu DOM is removed.
    // Fill a delayed native focus reset once more at the next paint, while
    // preserving any new popup or other surface that has since taken focus.
    const claimTreeFocus = (own: boolean) => {
      const pane = treeFocus.treePaneRef.current;
      if (!pane) return;
      const active = document.activeElement;
      const focusLost = !(active instanceof HTMLElement)
        || active === document.body
        || active === document.documentElement
        || !active.isConnected;
      // The closing menu hands the row back unconditionally; the retries only
      // fill a focus vacuum so they never steal from another surface.
      if (!own && !focusLost) return;
      const target = pane.querySelector<HTMLElement>("[role='treeitem'][data-selected='true']")
        ?? pane.querySelector<HTMLElement>("[data-testid='code-workspace-tree']");
      target?.focus({ preventScroll: true });
    };
    claimTreeFocus(true);
    if (typeof queueMicrotask === "function") queueMicrotask(() => claimTreeFocus(false));
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => claimTreeFocus(false));
  }, []);

  const {
    show: openTreeContextMenu,
    showAt: openTreeContextMenuAt,
    render: treeContextMenu,
  } = useContextMenu({ onClose: handleTreeContextMenuClose });
  const {
    showAt: openEditorContextMenuAt,
    render: editorContextMenu,
  } = useContextMenu();

  const copyEditorTabPath = useCallback(async (key: string, absolute: boolean) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.ref.kind === "root") {
      await fileActions.copyTreePath(file.ref.rootId, file.ref.path, absolute);
      return;
    }
    const text = absolute ? normalizeFsPath(file.ref.path) : basename(file.ref.path);
    try {
      await writeText(text);
      setStatusMessage(`Copied ${text}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [fileActions.copyTreePath, setStatusMessage]);

  const revealEditorTabInTree = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    toolWindowRouting.setLanguagePanelOpen(true);
    uiActions.setSelected({ kind: "file", ref: file.ref });
    if (file.ref.kind !== "root") return;
    const rootId = file.ref.rootId;
    uiActions.setExpandedRoots((current) => new Set(current).add(rootId));
    const directories = file.ref.path.split("/").filter(Boolean).slice(0, -1);
    uiActions.setExpandedDirs((current) => {
      const next = new Set(current);
      let path = "";
      for (const directory of directories) {
        path = path ? `${path}/${directory}` : directory;
        next.add(rootDirKey(rootId, path));
        void treeData.loadDir(rootId, path);
      }
      return next;
    });
    treeFocus.treePaneRef.current?.focus();
  }, [treeData.loadDir, toolWindowRouting.setLanguagePanelOpen]);

  /**
   * IDEA Project view "Expand All": every root plus every directory listed so
   * far; their unloaded sub-directories load now, so repeated use goes deeper
   * without walking a whole large project at once.
   */
  const expandAllProjectTree = useCallback(() => {
    const keys = new Set<string>();
    const pending: Array<{ rootId: string; path: string; }> = [];
    for (const [key, state] of Object.entries(treeData.directories)) {
      if (!state.loaded) continue;
      const rootId = key.slice(0, key.indexOf(":"));
      for (const entry of state.entries) {
        if (entry.fileType !== "dir") continue;
        const childKey = rootDirKey(rootId, entry.path);
        keys.add(childKey);
        if (!treeData.directories[childKey]?.loaded) pending.push({ rootId, path: entry.path });
      }
    }
    uiActions.setExpandedRoots(new Set(roots.map((root) => root.id)));
    uiActions.setExpandedDirs((current) => new Set([...current, ...keys]));
    for (const root of roots) {
      if (!treeData.directories[rootDirKey(root.id, "")]?.loaded) void treeData.loadDir(root.id, "");
    }
    for (const target of pending.slice(0, 200)) void treeData.loadDir(target.rootId, target.path);
  }, [treeData.directories, treeData.loadDir, roots, uiActions.setExpandedDirs, uiActions.setExpandedRoots]);

  /** IDEA Project view "Collapse All": back to the roots' top level. */
  const collapseAllProjectTree = useCallback(() => {
    uiActions.setExpandedDirs(new Set());
  }, [uiActions.setExpandedDirs]);

  const revealEditorTabInExplorer = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.library) {
      setStatusMessage(`${file.title} is a library source with no file on disk`);
      return;
    }
    if (file.ref.kind === "root") {
      void fileActions.revealInExplorer(file.ref.rootId, file.ref.path);
      return;
    }
    const absolute = normalizeFsPath(file.ref.path);
    void invoke("sftp_open_path", { path: absolute })
      .then(() => setStatusMessage(`Opened ${absolute}`))
      .catch((err) => setStatusMessage(errorMessage(err)));
  }, [fileActions.revealInExplorer, setStatusMessage]);

  /**
   * IDEA-style breadcrumb: list children of a directory/root segment, or siblings
   * when the file segment is clicked. Marks the trail's next segment as active.
   */
  const loadBreadcrumbPathChildren = useCallback(createLoadBreadcrumbPathChildren({
    rootsRef,
    loadDir: treeData.loadDir,
  }), [treeData.loadDir]);

  const navigateBreadcrumbPathChild = useCallback((
    child: BreadcrumbPathChild,
    file: OpenFileState,
  ) => {
    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      if (child.kind === "directory") {
        uiActions.setSelected({ kind: "dir", rootId, path: child.path });
        uiActions.setExpandedRoots((current) => new Set(current).add(rootId));
        uiActions.setExpandedDirs((current) => {
          const next = new Set(current);
          let acc = "";
          for (const part of child.path.split("/").filter(Boolean)) {
            acc = acc ? `${acc}/${part}` : part;
            next.add(rootDirKey(rootId, acc));
          }
          return next;
        });
        void treeData.loadDir(rootId, child.path);
        treeFocus.treePaneRef.current?.focus();
        return;
      }
      void openFile({ kind: "root", rootId, path: child.path });
      return;
    }
    // Loose file sibling/parent navigation: open absolute path as a loose file.
    if (child.kind === "file") {
      void fileActions.addLooseFilePath(child.path);
      return;
    }
    setStatusMessage(`Folder: ${child.path}`);
  }, [fileActions.addLooseFilePath, treeData.loadDir, openFile, setStatusMessage]);

  const breadcrumbPathActions = useCallback(createBreadcrumbPathActions({
    setSelected: uiActions.setSelected,
    treePaneRef: treeFocus.treePaneRef,
    setExpandedRoots: uiActions.setExpandedRoots,
    setExpandedDirs: uiActions.setExpandedDirs,
    loadDir: treeData.loadDir,
    revealEditorTabInTree,
    copyTreePath: fileActions.copyTreePath,
    revealInExplorer: fileActions.revealInExplorer,
    setStatusMessage,
  }), [fileActions.copyTreePath, treeData.loadDir, revealEditorTabInTree, fileActions.revealInExplorer, setStatusMessage]);

  const openEditorTabInTerminal = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.library) {
      setStatusMessage(`${file.title} is a library source with no directory on disk`);
      return;
    }
    if (file.ref.kind === "root") {
      openTerminalAt(file.ref.rootId, file.ref.path, true);
      return;
    }
    const cwd = parentPath(normalizeFsPath(file.ref.path));
    toolWindowRouting.setBottomDockTab("terminal");
    toolWindowRouting.setBottomDockOpen(true);
    terminalDockRef.current?.openAt(cwd, basename(cwd));
  }, [openTerminalAt, setStatusMessage]);

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const selection = getSelected ? getSelected() : selected;
    const pane = treeFocus.treePaneRef.current;
    const target = event.target;
    if (!pane || !(target instanceof HTMLElement) || event.nativeEvent.isComposing) return;
    // WKWebView can report function keys as Unidentified while preserving the
    // physical code. Use that code for tree actions such as F2 and Delete.
    const key = event.key === "Unidentified" ? event.nativeEvent.code : event.key;
    const tree = pane.querySelector<HTMLElement>("[data-testid='code-workspace-tree']");
    if (!tree || (target !== pane && !tree.contains(target))) return;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
      navigateProjectTree(tree, key, { onSelect: uiActions.setSelected, onToggleRoot: fileActions.toggleRoot, onToggleDir: fileActions.toggleDir })) {
      event.preventDefault();
      treeFocus.treeInteractionEpochRef.current += 1;
      treeFocus.pendingTreeOpenIntentRef.current = null;
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      if (selection?.kind === "file") {
        void treeOpening.requestTreeOpen(selection.ref, { split: event.ctrlKey || event.metaKey });
      } else if (selection?.kind === "root") fileActions.toggleRoot(selection.rootId);
      else if (selection?.kind === "dir") fileActions.toggleDir(selection.rootId, selection.path);
      return;
    }
    if ((event.nativeEvent as KeyboardEvent).isComposing) return;
    if (key === "Escape") {
      event.preventDefault();
      editorCommands.handleReturnToEditor();
      return;
    }
    if (key === "F2") {
      event.preventDefault();
      workspaceCommandRunnerRef.current("workspace.tree.rename", { focus: "tree", payload: { selection: selection ?? undefined } });
    } else if (key === "Delete") {
      event.preventDefault();
      workspaceCommandRunnerRef.current("workspace.tree.delete", { focus: "tree", payload: { selection: selection ?? undefined } });
    }
  }, [editorCommands.handleReturnToEditor, treeOpening.requestTreeOpen, getSelected, selected, uiActions.setSelected, fileActions.toggleDir, fileActions.toggleRoot]);

  const showTreeContextMenu = useCallback(
    createShowTreeContextMenu({
      setSelected: uiActions.setSelected,
      treeContextMenuSessionRef,
      workspaceInstanceId,
      workspaceCommandRunnerRef,
      stageTreeClipboard: fileActions.stageTreeClipboard,
      canPasteTreeClipboard: fileActions.canPasteTreeClipboard,
      pasteTreeClipboard: fileActions.pasteTreeClipboard,
      openTreeContextMenu,
      setStatusMessage,
      revealInExplorer: fileActions.revealInExplorer,
      openTerminalAt,
    }),
    [
      fileActions.canPasteTreeClipboard,
      openTerminalAt,
      openTreeContextMenu,
      fileActions.pasteTreeClipboard,
      fileActions.revealInExplorer,
      fileActions.stageTreeClipboard,
      workspaceInstanceId,
    ],
  );
  return {
    openTreeContextMenuAt,
    revealEditorTabInTree,
    treeContextMenuSessionRef,
    showTreeContextMenu,
    openEditorContextMenuAt,
    loadBreadcrumbPathChildren,
    navigateBreadcrumbPathChild,
    breadcrumbPathActions,
    copyEditorTabPath,
    revealEditorTabInExplorer,
    openEditorTabInTerminal,
    handleTreeKeyDown,
    expandAllProjectTree,
    collapseAllProjectTree,
    treeContextMenu,
    editorContextMenu,
  };
}
