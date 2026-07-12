import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../types";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type EditorGroupId } from "../../../stores/codeWorkspaceStore";
import type { GoToFileItem, SearchEverywhereMode } from "./SearchEverywhere";
import type { RecentFileEntry } from "./RecentFilesPopup";
import { createDoubleShiftDetector } from "./doubleShift";
import {
  fileKey,
  fileMeta,
  NAV_HISTORY_LIMIT,
  RECENT_FILES_LIMIT,
  shouldHideEntry,
  type FlatFilesState,
  type OpenFileState,
} from "./codeWorkspaceModel";

interface UseWorkspaceNavigationOptions {
  workspaceInstanceId: string;
  activeKey: string | null;
  roots: CodeWorkspaceRootInfo[];
  flatFiles: Record<string, FlatFilesState>;
  visible: boolean;
  rootsRef: RefObject<CodeWorkspaceRootInfo[]>;
  looseFilesRef: RefObject<CodeWorkspaceLooseFileInfo[]>;
  openFilesRef: RefObject<Record<string, OpenFileState>>;
  loadFlatFiles: (rootId: string, force?: boolean) => Promise<void>;
  openFile: (
    ref: CodeWorkspaceFileRef,
    options?: { preview?: boolean; groupId?: EditorGroupId },
  ) => Promise<void>;
  setSearchEverywhereMode: (mode: SearchEverywhereMode) => void;
  setSearchEverywhereOpen: (open: boolean) => void;
  setRecentEntries: (entries: RecentFileEntry[]) => void;
  setRecentFilesOpen: (open: boolean) => void;
}

export interface WorkspaceNavigationController {
  navCan: { back: boolean; forward: boolean };
  goToFileItems: GoToFileItem[];
  goToFileLoading: boolean;
  goToFileTruncated: boolean;
  openSearchEverywhere: (mode?: SearchEverywhereMode) => void;
  openGoToFileItem: (item: GoToFileItem, options?: { split: boolean }) => void;
  navigateHistory: (delta: -1 | 1) => void;
  openRecentFiles: () => void;
  pickRecentFile: (entry: RecentFileEntry) => void;
}

export function useWorkspaceNavigation({
  workspaceInstanceId,
  activeKey,
  roots,
  flatFiles,
  visible,
  rootsRef,
  looseFilesRef,
  openFilesRef,
  loadFlatFiles,
  openFile,
  setSearchEverywhereMode,
  setSearchEverywhereOpen,
  setRecentEntries,
  setRecentFilesOpen,
}: UseWorkspaceNavigationOptions): WorkspaceNavigationController {
  const setSplitOrientation = useCodeWorkspaceStore((state) => state.setSplitOrientation);
  const [navCan, setNavCan] = useState({ back: false, forward: false });
  const navHistoryRef = useRef<{
    stack: CodeWorkspaceFileRef[];
    index: number;
    suppress: boolean;
  }>({ stack: [], index: -1, suppress: false });
  const recentFilesRef = useRef<CodeWorkspaceFileRef[]>([]);

  const openSearchEverywhere = useCallback((mode: SearchEverywhereMode = "files") => {
    rootsRef.current?.forEach((root) => void loadFlatFiles(root.id));
    setSearchEverywhereMode(mode);
    setSearchEverywhereOpen(true);
  }, [loadFlatFiles, rootsRef, setSearchEverywhereMode, setSearchEverywhereOpen]);

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

  const openGoToFileItem = useCallback((item: GoToFileItem, options?: { split: boolean }) => {
    setSearchEverywhereOpen(false);
    const ref: CodeWorkspaceFileRef = { kind: "root", rootId: item.rootId, path: item.path };
    if (options?.split) {
      const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      const targetGroupId: EditorGroupId = current.activeEditorGroupId === "primary"
        ? "secondary"
        : "primary";
      setSplitOrientation(workspaceInstanceId, "vertical");
      void openFile(ref, { groupId: targetGroupId });
      return;
    }
    void openFile(ref, { preview: true });
  }, [openFile, setSearchEverywhereOpen, setSplitOrientation, workspaceInstanceId]);

  useEffect(() => {
    if (!activeKey) return;
    const ref = openFilesRef.current?.[activeKey]?.ref;
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
  }, [activeKey, openFilesRef]);

  const navigateHistory = useCallback((delta: -1 | 1) => {
    const nav = navHistoryRef.current;
    const nextIndex = nav.index + delta;
    if (nextIndex < 0 || nextIndex >= nav.stack.length) return;
    nav.index = nextIndex;
    nav.suppress = true;
    setNavCan({ back: nextIndex > 0, forward: nextIndex < nav.stack.length - 1 });
    void openFile(nav.stack[nextIndex]);
  }, [openFile]);

  const openRecentFiles = useCallback(() => {
    const entries: RecentFileEntry[] = recentFilesRef.current.map((ref) => {
      const key = fileKey(ref);
      const meta = fileMeta(ref, rootsRef.current ?? [], looseFilesRef.current ?? []);
      return {
        key,
        ref,
        title: meta.title,
        subtitle: meta.subtitle,
        open: !!openFilesRef.current?.[key],
      };
    });
    setRecentEntries(entries);
    setRecentFilesOpen(true);
  }, [looseFilesRef, openFilesRef, rootsRef, setRecentEntries, setRecentFilesOpen]);

  const pickRecentFile = useCallback((entry: RecentFileEntry) => {
    setRecentFilesOpen(false);
    void openFile(entry.ref);
  }, [openFile, setRecentFilesOpen]);

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

  return {
    navCan,
    goToFileItems,
    goToFileLoading,
    goToFileTruncated,
    openSearchEverywhere,
    openGoToFileItem,
    navigateHistory,
    openRecentFiles,
    pickRecentFile,
  };
}
