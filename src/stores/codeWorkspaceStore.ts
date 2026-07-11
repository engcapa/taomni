import { create } from "zustand";
import type { SearchEverywhereMode } from "../components/editor/workspace/SearchEverywhere";
import type { QuickDocContent } from "../components/editor/workspace/QuickDocPopup";
import type { LocationPeekState } from "../components/editor/workspace/LocationPeek";
import type { LspDocumentSymbol } from "../lib/editor/lsp";
import type { RecentFileEntry } from "../components/editor/workspace/RecentFilesPopup";

export type BottomDockTabId = "problems" | "search" | "references";

/**
 * Per-workspace-instance UI / chrome state that multiple presentation
 * boundaries (shell, EditorGroup, dock, popups) need without prop-drilling
 * the entire open-file model through every layer.
 *
 * Heavy file I/O and LSP session maps still live in the shell until later
 * extraction slices move them behind the same instance key.
 */
export interface CodeWorkspaceInstanceUi {
  languagePanelOpen: boolean;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  rightPaneOpen: boolean;
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
  searchIncludePreset: { value: string; nonce: number };
  searchQueryPreset: { value: string; nonce: number };
  /** Editor tab order / active key (file buffers remain in the shell). */
  openOrder: string[];
  activeKey: string | null;
  markdownModes: Record<string, "edit" | "preview" | "split">;
}

export function createDefaultCodeWorkspaceUi(): CodeWorkspaceInstanceUi {
  return {
    languagePanelOpen: true,
    bottomDockOpen: true,
    bottomDockTab: "references",
    rightPaneOpen: false,
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
    markdownModes: {},
  };
}

/** Stable fallback so React/zustand getSnapshot does not allocate every render. */
const EMPTY_UI: CodeWorkspaceInstanceUi = createDefaultCodeWorkspaceUi();

interface CodeWorkspaceStoreState {
  byInstanceId: Record<string, CodeWorkspaceInstanceUi>;
  ensureInstance: (instanceId: string) => void;
  disposeInstance: (instanceId: string) => void;
  getInstance: (instanceId: string) => CodeWorkspaceInstanceUi;
  patchInstance: (instanceId: string, patch: Partial<CodeWorkspaceInstanceUi>) => void;
  setActiveKey: (instanceId: string, key: string | null) => void;
  setOpenOrder: (instanceId: string, order: string[]) => void;
  setMarkdownMode: (instanceId: string, fileKey: string, mode: "edit" | "preview" | "split") => void;
}

export const useCodeWorkspaceStore = create<CodeWorkspaceStoreState>((set, get) => ({
  byInstanceId: {},

  ensureInstance: (instanceId) => {
    if (!instanceId) return;
    if (get().byInstanceId[instanceId]) return;
    set((state) => ({
      byInstanceId: {
        ...state.byInstanceId,
        [instanceId]: createDefaultCodeWorkspaceUi(),
      },
    }));
  },

  disposeInstance: (instanceId) => {
    if (!get().byInstanceId[instanceId]) return;
    set((state) => {
      const next = { ...state.byInstanceId };
      delete next[instanceId];
      return { byInstanceId: next };
    });
  },

  getInstance: (instanceId) => {
    return get().byInstanceId[instanceId] ?? EMPTY_UI;
  },

  patchInstance: (instanceId, patch) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: { ...current, ...patch },
        },
      };
    });
  },

  setActiveKey: (instanceId, key) => {
    get().patchInstance(instanceId, { activeKey: key });
  },

  setOpenOrder: (instanceId, order) => {
    get().patchInstance(instanceId, { openOrder: order });
  },

  setMarkdownMode: (instanceId, fileKey, mode) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            markdownModes: { ...current.markdownModes, [fileKey]: mode },
          },
        },
      };
    });
  },
}));

/** Select one instance UI slice; returns stable defaults when missing. */
export function selectCodeWorkspaceUi(
  state: CodeWorkspaceStoreState,
  instanceId: string,
): CodeWorkspaceInstanceUi {
  return state.byInstanceId[instanceId] ?? EMPTY_UI;
}
