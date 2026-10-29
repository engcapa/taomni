import { useCallback, useMemo } from "react";
import { lspWorkspaceSymbolResolve, type LspLocation } from "../../../../lib/editor/lsp";
import type { StructuralMatch } from "../../../../lib/editor/structuralSearch";
import type { WorkspaceSearchMatch } from "../../../../lib/editor/workspaceSearch";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef } from "../../../../types";
import type { EditorRevealTarget } from "../EditorGroup";
import { type GoToSymbolItem } from "../SearchEverywhere";
import { errorMessage, fileKey, relativePathWithinRoot } from "../codeWorkspaceModel";
import { createFetchWorkspaceSymbols } from "../controller/semanticQueries";
import { codePointOffsetToUtf16Offset, replaceMatchAbsolutePath } from "../replaceInFilesModel";
import { useStructuralSearchSession } from "../useStructuralSearchSession";
import { useWorkspaceLspSession } from "../useWorkspaceLspSession";
import { useWorkspaceSemanticIndex } from "../useWorkspaceSemanticIndex";
import { useWorkspaceBufferState } from "./useWorkspaceBufferState";
import { useWorkspaceDocumentLanguage } from "./useWorkspaceDocumentLanguage";
import { useWorkspaceDocumentSync } from "./useWorkspaceDocumentSync";
import { useWorkspaceLibrarySources } from "./useWorkspaceLibrarySources";
import { useWorkspaceStoreActions } from "./useWorkspaceStoreActions";
import { useWorkspaceToolWindowRouting } from "./useWorkspaceToolWindowRouting";
import { useWorkspaceTreeModel } from "./useWorkspaceTreeModel";
import { useWorkspaceUiActions } from "./useWorkspaceUiActions";


export interface UseWorkspaceSearchNavigationContext {
  documentLanguage: ReturnType<typeof useWorkspaceDocumentLanguage>;
  bufferState: ReturnType<typeof useWorkspaceBufferState>;
  semanticIndex: ReturnType<typeof useWorkspaceSemanticIndex>;
  documents: ReturnType<typeof useWorkspaceDocumentSync>;
  lsp: ReturnType<typeof useWorkspaceLspSession>;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  setStatusMessage: (message: string) => void;
  workspaceInstanceId: string;
  storeActions: ReturnType<typeof useWorkspaceStoreActions>;
  librarySources: ReturnType<typeof useWorkspaceLibrarySources>;
  workspaceUi: Omit<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi, "treeSelection">;
  projectTree: ReturnType<typeof useWorkspaceTreeModel>;
  revealNonceRef: import("react").RefObject<number>;
  setRevealTarget: import("react").Dispatch<import("react").SetStateAction<EditorRevealTarget | null>>;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  toolWindowRouting: ReturnType<typeof useWorkspaceToolWindowRouting>;
}

export function useWorkspaceSearchNavigation(context: UseWorkspaceSearchNavigationContext) {
  const {
    documentLanguage,
    bufferState,
    semanticIndex,
    documents,
    lsp,
    uiActions,
    setStatusMessage,
    workspaceInstanceId,
    storeActions,
    librarySources,
    workspaceUi,
    projectTree,
    revealNonceRef,
    setRevealTarget,
    openFile,
    toolWindowRouting,
  } = context;

  const fetchWorkspaceSymbols = useCallback(createFetchWorkspaceSymbols({
    activeFile: documentLanguage.activeFile,
    openFilesRef: bufferState.openFilesRef,
    semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced: documents.ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile: lsp.descriptorForFile,
    updateLspStatusForFile: lsp.updateStatus,
  }), [
    documentLanguage.activeFile,
    documents.ensureWorkspaceSemanticDocumentsSynced,
    lsp.descriptorForFile,
    semanticIndex.beginBuild,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    semanticIndex.current,
    lsp.updateStatus,
  ]);

  const openWorkspaceSymbol = useCallback(async (
    symbol: GoToSymbolItem,
    options?: { split: boolean; },
  ) => {
    uiActions.setSearchEverywhereOpen(false);
    let location: LspLocation;
    if (!symbol.resolved) {
      if (!symbol.resolveToken) {
        setStatusMessage(`Cannot open ${symbol.name}: the language server did not provide a source location`);
        return;
      }
      try {
        const resolved = await lspWorkspaceSymbolResolve(workspaceInstanceId, symbol.resolveToken);
        if (!resolved.resolved) {
          setStatusMessage(`Cannot open ${symbol.name}: workspace symbol resolution returned no source range`);
          return;
        }
        location = {
          uri: resolved.uri,
          path: resolved.path,
          range: resolved.selectionRange,
        };
      } catch (error) {
        setStatusMessage(`Cannot open ${symbol.name}: ${errorMessage(error)}`);
        return;
      }
    } else {
      location = {
        uri: symbol.uri,
        path: symbol.path,
        range: {
          start: { line: symbol.line, character: symbol.character },
          end: { line: symbol.line, character: symbol.character },
        },
      };
    }
    let groupId: EditorGroupId | undefined;
    if (options?.split) {
      const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      storeActions.splitLayoutLeaf(workspaceInstanceId, current.activeEditorGroupId, "vertical");
      const next = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      if (next.activeEditorGroupId !== current.activeEditorGroupId) {
        groupId = next.activeEditorGroupId;
      }
    }
    await librarySources.openLspLocation(location, { groupId, preview: !options?.split });
  }, [librarySources.openLspLocation, setStatusMessage, storeActions.splitLayoutLeaf, workspaceInstanceId]);

  const seSymbolsAvailable = !!(
    documentLanguage.activeCapabilities?.workspaceSymbol
    || Object.values(workspaceUi.lspFiles).some((state) => state.status?.capabilities?.workspaceSymbol)
  );

  const openSearchMatch = useCallback(
    (match: WorkspaceSearchMatch, options: { preview: boolean; }) => {
      const absolute = replaceMatchAbsolutePath(match);
      const root = projectTree.rootsRef.current.find((candidate) => candidate.id === match.rootId)
        ?? projectTree.rootsRef.current.find((candidate) => relativePathWithinRoot(candidate.path, absolute) !== null);
      const path = root ? relativePathWithinRoot(root.path, absolute) : null;
      if (!root || path === null) {
        setStatusMessage(`Cannot open search result outside the workspace: ${absolute}`);
        return;
      }
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path };
      // Backend line numbers are 1-based; reveal targets follow LSP 0-based.
      // ED-IMPROVE-004: backend offsets are code points, reveal ranges are UTF-16.
      const line = Math.max(0, match.lineNumber - 1);
      revealNonceRef.current += 1;
      setRevealTarget({
        key: fileKey(ref),
        line,
        character: codePointOffsetToUtf16Offset(match.lineText, match.matchStart),
        nonce: revealNonceRef.current,
        focus: !options.preview,
      });
      void openFile(ref, { preview: options.preview });
    },
    [openFile, setStatusMessage],
  );

  // ED-PARITY-009: Structural Search session (dialog + result tool window).
  const structuralRoots = useMemo(
    () => projectTree.roots.map((root) => ({ id: root.id, name: root.name, path: root.path })),
    [projectTree.roots],
  );
  const structuralActiveFile = useMemo(
    () => (documentLanguage.activeFile?.ref.kind === "root" ? { rootId: documentLanguage.activeFile.ref.rootId, path: documentLanguage.activeFile.ref.path } : null),
    [documentLanguage.activeFile?.ref],
  );
  const showStructuralResults = useCallback(() => {
    toolWindowRouting.setBottomDockOpen(true);
    toolWindowRouting.setBottomDockTab("structural");
  }, []);
  const structuralSearch = useStructuralSearchSession({
    roots: structuralRoots,
    activeFile: structuralActiveFile,
    getBuffers: () => Object.values(bufferState.openFilesRef.current).flatMap((file) => (
      file.ref.kind === "root" && !file.loading && !file.error && /\.java$/i.test(file.ref.path)
        && structuralRoots.some((root) => root.id === (file.ref.kind === "root" ? file.ref.rootId : null))
        ? [{ rootId: file.ref.rootId, path: file.ref.path, text: file.text }]
        : []
    )),
    onShowResults: showStructuralResults,
    onStatus: setStatusMessage,
  });
  const openStructuralMatch = useCallback((match: StructuralMatch, options: { preview: boolean; }) => {
    const root = projectTree.rootsRef.current.find((candidate) => candidate.id === match.rootId);
    if (!root) {
      setStatusMessage(`Cannot open structural result outside the workspace: ${match.path}`);
      return;
    }
    const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: match.path };
    revealNonceRef.current += 1;
    // Select the whole matched fragment, like IDEA's usage highlight.
    setRevealTarget({
      key: fileKey(ref),
      line: match.start.line,
      character: match.start.character,
      end: { line: match.end.line, character: match.end.character },
      nonce: revealNonceRef.current,
      focus: !options.preview,
    });
    void openFile(ref, { preview: options.preview });
  }, [openFile, setStatusMessage]);
  return {
    seSymbolsAvailable,
    structuralSearch,
    openSearchMatch,
    openStructuralMatch,
    fetchWorkspaceSymbols,
    openWorkspaceSymbol,
  };
}
