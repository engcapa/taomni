import { useCallback, useRef, useState } from "react";
import { type LspCodeAction, type LspDocumentSymbol, type LspRange } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type CodeWorkspaceEditorGroupState, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { type GenerateCandidate } from "../generateCodeWorkflow";
import { type EditorClipboardSession } from "../workspaceClipboardSession";
import type { ClipboardObservationRecord } from "../clipboardObservationContract";
import { type QuickDocContent } from "../referenceDocumentation";
import { type LocationPeekState } from "../LocationPeek";
import { type SearchEverywhereMode } from "../SearchEverywhere";
import { type RecentFileEntry } from "../RecentFilesPopup";
import { type MarkdownViewMode, type OpenFileState, type TreeSelection } from "../codeWorkspaceModel";
import { type WorkspaceSemanticIndexBuildToken } from "../workspaceSemanticIndex";


export interface UseWorkspaceUiActionsContext {
  workspaceInstanceId: string;
  searchEverywhereTriggerRef: import("react").RefObject<HTMLElement | null>;
  patchWorkspaceUi: (instanceId: string, patch: Partial<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi>) => void;
  setStoreOpenOrder: (instanceId: string, order: string[]) => void;
  setStoreActiveKey: (instanceId: string, key: string | null) => void;
  updateStoreEditorGroup: (instanceId: string, groupId: EditorGroupId, updater: CodeWorkspaceEditorGroupState | ((prev: CodeWorkspaceEditorGroupState) => CodeWorkspaceEditorGroupState)) => void;
  setStoreActiveEditorGroup: (instanceId: string, groupId: EditorGroupId) => void;
  updateStoreExpandedRootIds: (instanceId: string, updater: string[] | ((prev: string[]) => string[])) => void;
  updateStoreExpandedDirKeys: (instanceId: string, updater: string[] | ((prev: string[]) => string[])) => void;
}

export function useWorkspaceUiActions(context: UseWorkspaceUiActionsContext) {
  const {
    workspaceInstanceId,
    searchEverywhereTriggerRef,
    patchWorkspaceUi,
    setStoreOpenOrder,
    setStoreActiveKey,
    updateStoreEditorGroup,
    setStoreActiveEditorGroup,
    updateStoreExpandedRootIds,
    updateStoreExpandedDirKeys,
  } = context;
  const setSearchEverywhereOpen = useCallback((open: boolean) => {
    if (open && !selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchEverywhereOpen) {
      searchEverywhereTriggerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    patchWorkspaceUi(workspaceInstanceId, { searchEverywhereOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchEverywhereMode = useCallback((mode: SearchEverywhereMode) => {
    patchWorkspaceUi(workspaceInstanceId, { searchEverywhereMode: mode });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRecentFilesOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { recentFilesOpen: open });
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
  const [recentLocationsOpen, setRecentLocationsOpen] = useState(false);
  // §8.19.8 Surround With dialog state (one entry, all kinds).
  const [surroundWithDialogOpen, setSurroundWithDialogOpen] = useState(false);
  // §8.19.8 Generate Code workflow state: provider candidates + phase.
  const [generateCode, setGenerateCode] = useState<{
    open: boolean;
    phase: "loading" | "ready" | "empty" | "running" | "error";
    candidates: GenerateCandidate[];
    error: string | null;
  }>({ open: false, phase: "loading", candidates: [], error: null });
  // §8.19.5 Paste-from-History popup state (session-only ring snapshot).
  const [clipboardHistoryOpen, setClipboardHistoryOpen] = useState(false);
  // ED-CLIP-004: last settled guarded clipboard result, projected as metadata
  // only. This is the observation seam a packaged runtime asserts against; the
  // prose status line cannot prove which typed enum member production chose.
  const [latestClipboardObservation, setLatestClipboardObservation] =
    useState<ClipboardObservationRecord | null>(null);
  const [clipboardHistoryEntries, setClipboardHistoryEntries] = useState<EditorClipboardSession[]>([]);
  const generateCodeContextRef = useRef<{
    file: OpenFileState;
    range: LspRange;
    semanticToken: WorkspaceSemanticIndexBuildToken | null;
    actions: LspCodeAction[];
  } | null>(null);
  const [recentLocationsChangedOnly, setRecentLocationsChangedOnly] = useState(false);
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
    updater: { value: string; nonce: number; } | ((prev: { value: string; nonce: number; }) => { value: string; nonce: number; }),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchIncludePreset;
    patchWorkspaceUi(workspaceInstanceId, {
      searchIncludePreset: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchQueryPreset = useCallback((
    updater: { value: string; nonce: number; } | ((prev: { value: string; nonce: number; }) => { value: string; nonce: number; }),
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
  return { updateEditorGroup, activateEditorGroup, setSearchEverywhereMode, setSearchEverywhereOpen, setRecentEntries, setRecentFilesOpen, setSearchFocusNonce, setSearchIncludePreset, setSelected, setExpandedRoots, setExpandedDirs, setOpenOrder, setActiveKey, setMarkdownModes, latestClipboardObservation, setPinnedDoc, setPinnedDocLocked, setQuickDocOpen, setQuickDocContent, setGenerateCode, generateCodeContextRef, setStructureSymbols, setStructureUnavailable, setStructureLoading, setStructureOpen, setSurroundWithDialogOpen, setRecentLocationsChangedOnly, setRecentLocationsOpen, setClipboardHistoryEntries, setClipboardHistoryOpen, setLocationPeek, setLatestClipboardObservation, setTreeFilter, setSearchQueryPreset, recentLocationsOpen, recentLocationsChangedOnly, clipboardHistoryOpen, clipboardHistoryEntries, generateCode, surroundWithDialogOpen };
}
