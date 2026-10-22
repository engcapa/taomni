import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { type LspDocumentHighlight, type LspDocumentSymbol, type LspInlayHint, type LspPosition, type LspRange, type LspSemanticToken } from "../../../../lib/editor/lsp";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { type OccurrenceHighlightSession } from "../occurrenceHighlightModel";


export interface UseWorkspaceEditorTelemetryContext {
  activeKey: string | null;
  activeEditorGroupId: string;
}

export function useWorkspaceEditorTelemetry(context: UseWorkspaceEditorTelemetryContext) {
  const { activeKey, activeEditorGroupId } = context;
  const [activeSelectionStats, setActiveSelectionStats] = useState({ chars: 0, lineBreaks: 0 });
  const [cursorPositions, setCursorPositionsNow] = useState<Record<EditorGroupId, LspPosition>>({
    primary: { line: 0, character: 0 },
    secondary: { line: 0, character: 0 },
  });
  /** Latest caret per group for callbacks that must not change identity per caret move. */
  const cursorPositionsRef = useRef(cursorPositions);
  // The selection callback owns this ref synchronously. Never copy deferred
  // React state back into it: an older transition can commit between a caret
  // move and Ctrl+F8/Ctrl+Shift+F8, putting the action on the previous line.
  const [viewportRanges, setViewportRangesNow] = useState<Record<EditorGroupId, LspRange | null>>({
    primary: null,
    secondary: null,
  });
  const [syncSplitScroll, setSyncSplitScroll] = useState(false);
  const syncScrollOriginGroupIdRef = useRef<EditorGroupId | null>(null);
  const [highlightsByGroup, setHighlightsByGroupNow] = useState<Record<EditorGroupId, LspDocumentHighlight[]>>({
    primary: [],
    secondary: [],
  });
  const [inlayHintsByGroup, setInlayHintsByGroupNow] = useState<Record<EditorGroupId, LspInlayHint[]>>({
    primary: [],
    secondary: [],
  });
  const [semanticTokensByGroup, setSemanticTokensByGroupNow] = useState<Record<EditorGroupId, LspSemanticToken[]>>({
    primary: [],
    secondary: [],
  });
  const [breadcrumbSymbolsByGroup, setBreadcrumbSymbolsByGroupNow] = useState<Record<EditorGroupId, LspDocumentSymbol[]>>({
    primary: [],
    secondary: [],
  });
  // Caret, viewport and provider results arrive between keystrokes and
  // re-render the whole workspace shell. Render them as transitions so React
  // yields to typing (WebKitGTK input stalled behind these renders).
  const setCursorPositions = useCallback((update: Parameters<typeof setCursorPositionsNow>[0]) => {
    startTransition(() => setCursorPositionsNow(update));
  }, []);
  const setViewportRanges = useCallback((update: Parameters<typeof setViewportRangesNow>[0]) => {
    startTransition(() => setViewportRangesNow(update));
  }, []);
  const setHighlightsByGroup = useCallback((update: Parameters<typeof setHighlightsByGroupNow>[0]) => {
    startTransition(() => setHighlightsByGroupNow(update));
  }, []);
  const setInlayHintsByGroup = useCallback((update: Parameters<typeof setInlayHintsByGroupNow>[0]) => {
    startTransition(() => setInlayHintsByGroupNow(update));
  }, []);
  const setSemanticTokensByGroup = useCallback((update: Parameters<typeof setSemanticTokensByGroupNow>[0]) => {
    startTransition(() => setSemanticTokensByGroupNow(update));
  }, []);
  const setBreadcrumbSymbolsByGroup = useCallback((update: Parameters<typeof setBreadcrumbSymbolsByGroupNow>[0]) => {
    startTransition(() => setBreadcrumbSymbolsByGroupNow(update));
  }, []);
  const [navigationBarActiveByGroup, setNavigationBarActiveByGroup] = useState<Record<EditorGroupId, boolean>>({
    primary: false,
    secondary: false,
  });
  const [occurrenceSession, setOccurrenceSession] = useState<OccurrenceHighlightSession | null>(null);
  const occurrenceSessionRef = useRef<OccurrenceHighlightSession | null>(occurrenceSession);
  occurrenceSessionRef.current = occurrenceSession;
  const occurrenceActiveFileKeyRef = useRef<string | null>(activeKey);
  occurrenceActiveFileKeyRef.current = activeKey;
  const occurrenceActiveGroupIdRef = useRef<EditorGroupId>(activeEditorGroupId);
  occurrenceActiveGroupIdRef.current = activeEditorGroupId;
  const autoHighlightRequestGenerationRef = useRef(0);
  const occurrenceRequestGenerationRef = useRef(0);
  const breadcrumbSymbolsRef = useRef<Record<EditorGroupId, LspDocumentSymbol[]>>({
    primary: [],
    secondary: [],
  });

  // Mirrored for the AI prompt builders, which run from callbacks declared
  // before these values are in scope.
  useEffect(() => {
    breadcrumbSymbolsRef.current = breadcrumbSymbolsByGroup;
  }, [breadcrumbSymbolsByGroup]);
  return {
    breadcrumbSymbolsRef,
    cursorPositionsRef,
    autoHighlightRequestGenerationRef,
    occurrenceActiveFileKeyRef,
    occurrenceActiveGroupIdRef,
    occurrenceSessionRef,
    setHighlightsByGroup,
    cursorPositions,
    occurrenceSession,
    setOccurrenceSession,
    setInlayHintsByGroup,
    viewportRanges,
    setSemanticTokensByGroup,
    setBreadcrumbSymbolsByGroup,
    activeSelectionStats,
    breadcrumbSymbolsByGroup,
    setNavigationBarActiveByGroup,
    occurrenceRequestGenerationRef,
    setHighlightsByGroupNow,
    setSyncSplitScroll,
    navigationBarActiveByGroup,
    highlightsByGroup,
    inlayHintsByGroup,
    semanticTokensByGroup,
    setActiveSelectionStats,
    setCursorPositions,
    setViewportRanges,
    syncSplitScroll,
    syncScrollOriginGroupIdRef,
  };
}
