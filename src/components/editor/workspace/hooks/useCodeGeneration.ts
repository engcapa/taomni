import { useCallback } from "react";
import { type LspCodeAction, type LspDiagnostic, type LspRange } from "../../../../lib/editor/lsp";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { applyGenerateSelection, type GenerateCandidate } from "../generateCodeWorkflow";
import { filterGenerateCodeActions } from "../workspaceSemanticEditing";
import { type OpenFileState } from "../codeWorkspaceModel";
import { workspaceSemanticIndexTokenRevisionCurrent } from "../workspaceSemanticIndex";


export interface UseCodeGenerationContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  setStatusMessage: (message: string) => void;
  setGenerateCode: import("react").Dispatch<import("react").SetStateAction<{ open: boolean; phase: "loading" | "ready" | "empty" | "running" | "error"; candidates: GenerateCandidate[]; error: string | null; }>>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  requestCodeActions: (file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], options?: { signal?: AbortSignal; allowCapabilityFallback?: boolean; }) => Promise<{ actions: LspCodeAction[]; providerActions: readonly import("../codeActionProviderAdapter").ProviderActionV4[]; context: import("../codeActionProviderAdapter").CodeActionContextIdentity | null; semanticToken: import("../workspaceSemanticIndex").WorkspaceSemanticIndexBuildToken | null; requestFailure: { kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider"; message: string; } | null; }>;
  generateCodeContextRef: import("react").RefObject<{ file: OpenFileState; range: LspRange; semanticToken: import("../workspaceSemanticIndex").WorkspaceSemanticIndexBuildToken | null; actions: LspCodeAction[]; } | null>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  runCodeAction: (action: LspCodeAction, file: OpenFileState, semanticToken?: import("../workspaceSemanticIndex").WorkspaceSemanticIndexBuildToken | null, intentionCandidateId?: string, intentionContext?: import("../codeActionProviderAdapter").CodeActionContextIdentity, receiptSessionId?: string) => Promise<{ ok: boolean; message: string | null; retryable: boolean; appliedReceipt?: import("../extractMethodFlow").ExtractReceipt; }>;
}

export function useCodeGeneration(context: UseCodeGenerationContext) {
  const {
    activeFile,
    setStatusMessage,
    setGenerateCode,
    editorSelectionRef,
    requestCodeActions,
    generateCodeContextRef,
    semanticIndex,
    runCodeAction,
  } = context;

  // §8.19.8 Generate Code: request provider source/generate CodeActions for
  // the caret, list exactly what came back, and apply the selection through
  // the existing runCodeAction pipeline (resolve → WorkspaceEdit/command with
  // semantic staleness guards). No local member templates exist anywhere.
  const requestGenerateCandidates = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading || file.library) {
      setStatusMessage("Generate requires an active workspace file");
      setGenerateCode((prev) => ({ ...prev, phase: "empty" }));
      return;
    }
    const selection = editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    setGenerateCode((prev) => ({ ...prev, open: true, phase: "loading", error: null }));
    const requested = await requestCodeActions(file, range, [], ["source"]);
    if (requested.requestFailure) {
      // Stale keeps its context-specific wording; every other failure kind
      // already surfaced its accurate message on the status line.
      generateCodeContextRef.current = null;
      setGenerateCode({
        open: true,
        phase: "error",
        candidates: [],
        error: requested.requestFailure.kind === "stale"
          ? "Generation actions became stale because the workspace changed; retry to request them again"
          : requested.requestFailure.message,
      });
      return;
    }
    const filtered = filterGenerateCodeActions(requested.actions);
    if (filtered.length === 0) {
      generateCodeContextRef.current = null;
      setGenerateCode({ open: true, phase: "empty", candidates: [], error: null });
      return;
    }
    generateCodeContextRef.current = {
      file,
      range,
      semanticToken: requested.semanticToken,
      actions: filtered.map((entry) => entry.item),
    };
    setGenerateCode({
      open: true,
      phase: "ready",
      candidates: filtered.map((entry, index) => ({
        id: String(index),
        title: entry.title,
        kind: entry.kind,
      })),
      error: null,
    });
  }, [activeFile, requestCodeActions, setStatusMessage]);

  const closeGenerateDialog = useCallback(() => {
    generateCodeContextRef.current = null;
    setGenerateCode((prev) => ({ ...prev, open: false }));
  }, []);

  const applyGenerateCandidates = useCallback(async (ids: readonly string[]) => {
    const context = generateCodeContextRef.current;
    if (!context) return;
    // Only ids that still map onto the captured provider actions.
    const selection: GenerateCandidate[] = ids.flatMap((id) => {
      const action = context.actions[Number(id)];
      return action ? [{ id, title: action.title, kind: action.kind ?? "" }] : [];
    });
    if (selection.length === 0) return;
    setGenerateCode((prev) => ({ ...prev, phase: "running", error: null }));
    const outcome = await applyGenerateSelection(selection, {
      actionFor: (candidate) => context.actions[Number(candidate.id)],
      isStale: () => !!context.semanticToken
        && !workspaceSemanticIndexTokenRevisionCurrent(semanticIndex.current(), context.semanticToken!),
      run: (action) => runCodeAction(action, context.file, context.semanticToken),
    });
    if (outcome.failedIndex != null) {
      // §8.19.8: resolve/apply failure keeps the dialog on Retry/Cancel and
      // never falls back to inserting a fixed template.
      setGenerateCode((prev) => ({
        ...prev,
        phase: "error",
        error: outcome.message ?? "Generation failed",
      }));
      return;
    }
    setStatusMessage(`Generated via ${outcome.applied} language-server action${outcome.applied === 1 ? "" : "s"}`);
    closeGenerateDialog();
  }, [closeGenerateDialog, runCodeAction, semanticIndex.current, setStatusMessage]);
  return { requestGenerateCandidates, applyGenerateCandidates, closeGenerateDialog };
}
