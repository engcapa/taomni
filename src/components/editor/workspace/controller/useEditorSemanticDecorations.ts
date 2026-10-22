import { useEffect } from "react";
import { lspDocumentHighlights, lspInlayHints, lspSemanticTokens, type LspDocumentDescriptor, type LspDocumentHighlight, type LspInlayHint, type LspSemanticToken, type LspPosition, type LspRange } from "../../../../lib/editor/lsp";
import { fallbackWordHighlights } from "../lspIntelligenceChrome";
import { isOccurrenceSessionValid, type OccurrenceHighlightSession } from "../occurrenceHighlightModel";
import { type OpenFileState } from "../codeWorkspaceModel";
import { LSP_HIGHLIGHT_IDLE_DELAY_MS, initialInlayHintRange, LSP_INLAY_HINT_IDLE_DELAY_MS, LSP_SEMANTIC_TOKENS_IDLE_DELAY_MS } from "./model";


export interface UseEditorSemanticDecorationsContext {
  activeEditorGroupId: string;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  autoHighlightRequestGenerationRef: import("react").RefObject<number>;
  occurrenceActiveFileKeyRef: import("react").RefObject<string | null>;
  occurrenceActiveGroupIdRef: import("react").RefObject<string>;
  occurrenceSessionRef: import("react").RefObject<OccurrenceHighlightSession | null>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  activeFileIsLarge: boolean;
  setHighlightsByGroup: (update: Parameters<import("react").Dispatch<import("react").SetStateAction<Record<string, LspDocumentHighlight[]>>>>[0]) => void;
  cursorPositions: Record<string, LspPosition>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  activeCapabilities: import("../../../../lib/editor/lsp").LspCapabilitySummary | null;
  activeLspDocumentIsSynced: boolean;
  lspDocumentEpochRef: import("react").RefObject<Record<string, number>>;
  isCurrentLspDocumentRequest: (file: OpenFileState, epoch: number) => boolean;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  occurrenceSession: OccurrenceHighlightSession | null;
  setOccurrenceSession: import("react").Dispatch<import("react").SetStateAction<OccurrenceHighlightSession | null>>;
  activeInlayHintsEnabled: boolean;
  setInlayHintsByGroup: (update: Parameters<import("react").Dispatch<import("react").SetStateAction<Record<string, LspInlayHint[]>>>>[0]) => void;
  viewportRanges: Record<string, LspRange | null>;
  setSemanticTokensByGroup: (update: Parameters<import("react").Dispatch<import("react").SetStateAction<Record<string, LspSemanticToken[]>>>>[0]) => void;
}

export function useEditorSemanticDecorations(context: UseEditorSemanticDecorationsContext) {
  const { activeEditorGroupId, activeFile, autoHighlightRequestGenerationRef, occurrenceActiveFileKeyRef, occurrenceActiveGroupIdRef, occurrenceSessionRef, openFilesRef, activeFileIsLarge, setHighlightsByGroup, cursorPositions, lspDescriptorForFile, activeCapabilities, activeLspDocumentIsSynced, lspDocumentEpochRef, isCurrentLspDocumentRequest, updateLspStatusForFile, occurrenceSession, setOccurrenceSession, activeInlayHintsEnabled, setInlayHintsByGroup, viewportRanges, setSemanticTokensByGroup } = context;

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    const requestGeneration = ++autoHighlightRequestGenerationRef.current;
    const canApply = () => (
      autoHighlightRequestGenerationRef.current === requestGeneration
      && occurrenceActiveFileKeyRef.current === file?.key
      && occurrenceActiveGroupIdRef.current === groupId
      && !occurrenceSessionRef.current
      && (!file || openFilesRef.current[file.key]?.text === file.text)
    );
    // Explicit occurrence highlighting owns this overlay until the session is
    // cleared. Cursor-driven refreshes must not replace it asynchronously.
    if (file && occurrenceSessionRef.current?.fileKey === file.key) return;
    // Large-file mode: no per-cursor highlight (LSP request nor text-scan fallback).
    if (!file || file.loading || activeFileIsLarge) {
      setHighlightsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    let cancelled = false;
    const position = cursorPositions[groupId] ?? { line: 0, character: 0 };
    const descriptor = lspDescriptorForFile(file);
    // ED-PARITY-022 DEC-022-04: Java usages are semantic; while the provider
    // cannot answer, show none rather than a same-text imitation.
    const semanticOnly = /\.java$/i.test(file.ref.path);
    if (!activeCapabilities?.documentHighlight || !descriptor) {
      const timer = window.setTimeout(() => {
        if (!cancelled && canApply()) {
          setHighlightsByGroup((current) => ({
            ...current,
            [groupId]: semanticOnly ? [] : fallbackWordHighlights(file.text, position),
          }));
        }
      }, LSP_HIGHLIGHT_IDLE_DELAY_MS);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
    if (!activeLspDocumentIsSynced) {
      setHighlightsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    const epoch = lspDocumentEpochRef.current[file.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!canApply() || !isCurrentLspDocumentRequest(file, epoch)) return;
      void lspDocumentHighlights(descriptor, position)
        .then((result) => {
          if (cancelled || !canApply() || !isCurrentLspDocumentRequest(file, epoch)) return;
          updateLspStatusForFile(file, result.status);
          setHighlightsByGroup((current) => ({ ...current, [groupId]: result.highlights }));
        })
        .catch(() => {
          if (cancelled || !canApply() || !isCurrentLspDocumentRequest(file, epoch)) return;
          setHighlightsByGroup((current) => ({
            ...current,
            [groupId]: semanticOnly ? [] : fallbackWordHighlights(file.text, position),
          }));
        });
    }, LSP_HIGHLIGHT_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.documentHighlight,
    activeEditorGroupId,
    activeFile,
    activeFileIsLarge,
    activeLspDocumentIsSynced,
    cursorPositions,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
  ]);

  useEffect(() => {
    if (!occurrenceSession) return;
    const currentRev = activeFile ? (lspDocumentEpochRef.current[activeFile.key] ?? 0) : -1;
    if (!activeFile || !isOccurrenceSessionValid(occurrenceSession, activeFile.key, currentRev)) {
      setOccurrenceSession(null);
      occurrenceSessionRef.current = null;
      setHighlightsByGroup((current) => ({
        ...current,
        [activeEditorGroupId]: [],
      }));
    }
  }, [activeEditorGroupId, activeFile, occurrenceSession]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    if (!file || file.loading || activeFileIsLarge || !activeInlayHintsEnabled || !activeCapabilities?.inlayHint) {
      setInlayHintsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    if (!activeLspDocumentIsSynced) {
      setInlayHintsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    const range = viewportRanges[groupId] ?? initialInlayHintRange(file.text);
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    let cancelled = false;
    const epoch = lspDocumentEpochRef.current[file.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(file, epoch)) return;
      void lspInlayHints(descriptor, range)
        .then((result) => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          updateLspStatusForFile(file, result.status);
          setInlayHintsByGroup((current) => ({ ...current, [groupId]: result.hints }));
        })
        .catch(() => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          setInlayHintsByGroup((current) => (
            (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
          ));
        });
    }, LSP_INLAY_HINT_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.inlayHint,
    activeEditorGroupId,
    activeFile,
    activeFileIsLarge,
    activeInlayHintsEnabled,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
    viewportRanges,
  ]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    if (!file || file.loading || activeFileIsLarge || !activeCapabilities?.semanticTokens) {
      setSemanticTokensByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    if (!activeLspDocumentIsSynced) {
      setSemanticTokensByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    let cancelled = false;
    const epoch = lspDocumentEpochRef.current[file.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(file, epoch)) return;
      void lspSemanticTokens(descriptor)
        .then((result) => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          updateLspStatusForFile(file, result.status);
          setSemanticTokensByGroup((current) => ({ ...current, [groupId]: result.tokens }));
        })
        .catch(() => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          setSemanticTokensByGroup((current) => (
            (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
          ));
        });
    }, LSP_SEMANTIC_TOKENS_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.semanticTokens,
    activeEditorGroupId,
    activeFile,
    activeFileIsLarge,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
  ]);
  return {  };
}
