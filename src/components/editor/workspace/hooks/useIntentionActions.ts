import { useCallback } from "react";
import { type LspCodeAction, type LspDiagnostic, type LspDocumentSymbol, type LspPosition, type LspRange } from "../../../../lib/editor/lsp";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { languageServiceReadiness } from "../languageServiceReadiness";
import { IntentionSession } from "../intentionSession";
import { type WorkspaceCommandContext } from "../workspaceCommands";
import { type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import { createShowCodeActionsMenu } from "../controller/codeActionActions";


export interface UseIntentionActionsContext {
  intentionRequestAbortRef: import("react").RefObject<AbortController | null>;
  requestCodeActions: (file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], options?: { signal?: AbortSignal; allowCapabilityFallback?: boolean; }) => Promise<{ actions: LspCodeAction[]; providerActions: readonly import("../codeActionProviderAdapter").ProviderActionV4[]; context: import("../codeActionProviderAdapter").CodeActionContextIdentity | null; semanticToken: import("../workspaceSemanticIndex").WorkspaceSemanticIndexBuildToken | null; requestFailure: { kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider"; message: string; } | null; }>;
  showCodeInsightNotice: (message: string, action?: "configure" | null) => void;
  setStatusMessage: (message: string) => void;
  intentionSessionRef: import("react").RefObject<IntentionSession | null>;
  beginExtractSessionRef: import("react").RefObject<((input: { file: OpenFileState; range: LspRange; uri: string; beforeSymbols: LspDocumentSymbol[] | null; }) => import("../controller/model").ExtractSessionState | null) | null>;
  captureMethodSymbolsRef: import("react").RefObject<((file: OpenFileState) => Promise<LspDocumentSymbol[] | null>) | null>;
  runCodeAction: (action: LspCodeAction, file: OpenFileState, semanticToken?: import("../workspaceSemanticIndex").WorkspaceSemanticIndexBuildToken | null, intentionCandidateId?: string, intentionContext?: import("../codeActionProviderAdapter").CodeActionContextIdentity, receiptSessionId?: string) => Promise<{ ok: boolean; message: string | null; retryable: boolean; appliedReceipt?: import("../extractMethodFlow").ExtractReceipt; }>;
  continueExtractNamingRef: import("react").RefObject<((receipt: import("../extractMethodFlow").ExtractReceipt) => Promise<void>) | null>;
  finishExtractSessionRef: import("react").RefObject<((session: import("../controller/model").ExtractSessionState) => void) | null>;
  openTreeContextMenuAt: (x: number, y: number, items: import("../../../ContextMenu").MenuItem[], menuOptions?: import("../../../ContextMenu").ContextMenuAppearance) => void;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  editorPaneRef: import("react").RefObject<HTMLElement | null>;
  resolveEditorTarget: (context?: WorkspaceCommandContext) => { file: OpenFileState | null; position: LspPosition | undefined; };
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
}

export function useIntentionActions(context: UseIntentionActionsContext) {
  const {
    intentionRequestAbortRef,
    requestCodeActions,
    showCodeInsightNotice,
    setStatusMessage,
    intentionSessionRef,
    runCodeAction,
    openTreeContextMenuAt,
    activeFile,
    editorSelectionRef,
    editorPaneRef,
    resolveEditorTarget,
    lspFilesRef,
    openFilesRef,
  } = context;

  const showCodeActionsMenu = useCallback(createShowCodeActionsMenu({
    intentionRequestAbortRef,
    requestCodeActions,
    showCodeInsightNotice,
    setStatusMessage,
    intentionSessionRef,
    get beginExtractSessionRef() { return context.beginExtractSessionRef; },
    get captureMethodSymbolsRef() { return context.captureMethodSymbolsRef; },
    runCodeAction,
    get continueExtractNamingRef() { return context.continueExtractNamingRef; },
    get finishExtractSessionRef() { return context.finishExtractSessionRef; },
    openTreeContextMenuAt,
  }), [
    openTreeContextMenuAt,
    requestCodeActions,
    runCodeAction,
    setStatusMessage,
  ]);

  const openRefactorActions = useCallback(async (only: string[], sectionLabel: string) => {
    const file = activeFile;
    if (!file || file.loading || file.library) return;
    const selection = editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 80,
      file,
      range,
      [],
      only,
      sectionLabel,
    );
  }, [activeFile, showCodeActionsMenu]);

  const openCodeActionsAtCursor = useCallback(async (context?: WorkspaceCommandContext) => {
    const target = resolveEditorTarget(context);
    const file = target.file;
    if (!file || file.loading) return;
    const payload = context?.payload as {
      position?: LspPosition;
      selectionStart?: LspPosition;
      selectionEnd?: LspPosition;
      hasSelection?: boolean;
      diagnostics?: LspDiagnostic[];
      clientX?: number;
      clientY?: number;
    } | undefined;
    const selection = editorSelectionRef.current;
    const position = target.position ?? selection.start;
    const range: LspRange = payload
      ? {
        start: payload.hasSelection ? (payload.selectionStart ?? position) : position,
        end: payload.hasSelection ? (payload.selectionEnd ?? position) : position,
      }
      : {
        start: selection.start,
        end: selection.empty ? selection.start : selection.end,
      };
    const line = range.start.line;
    const diagnostics = payload?.diagnostics ?? (
      lspFilesRef.current[file.key]?.diagnostics ?? []
    ).filter((item) => item.range.start.line <= line && item.range.end.line >= line);
    // DEC-020-01: Alt+Enter with an unavailable service answers at the caret.
    const readiness = languageServiceReadiness(lspFilesRef.current[file.key] ?? null);
    if (readiness.kind !== "ready" && readiness.kind !== "idle") {
      showCodeInsightNotice(`Context actions unavailable: ${readiness.message}`, readiness.action === "configure" ? "configure" : null);
      return;
    }
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      payload?.clientX ?? (rect?.left ?? 0) + 80,
      payload?.clientY ?? (rect?.top ?? 0) + 80,
      file,
      range,
      diagnostics,
    );
  }, [resolveEditorTarget, showCodeActionsMenu]);

  const openCodeActionsForLine = useCallback(async (line: number) => {
    const file = activeFile;
    if (!file || file.loading) return;
    const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? []).filter(
      (item) => item.range.start.line <= line && item.range.end.line >= line,
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
  return { openCodeActionsAtCursor, openRefactorActions, showCodeActionsMenu, openCodeActionsForLine, openQuickFixForProblem };
}
