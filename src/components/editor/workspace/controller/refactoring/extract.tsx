import { type LspCodeAction, type LspDiagnostic, type LspDocumentSymbol, type LspPosition, type LspRange } from "../../../../../lib/editor/lsp";
import { type CodeActionContextIdentity, type ProviderActionV4 } from "../../codeActionProviderAdapter";
import { type EditorSelectionRange } from "../../CodeMirrorHost";
import { type OpenFileState } from "../../codeWorkspaceModel";
import {
  EXTRACT_NAMING_UNAVAILABLE_MESSAGE,
  extractDirtyBufferMessage,
  extractMethodBoundaryMessage,
  extractOwnerMatches,
  extractReceiptMatches,
  findExtractedMethodSymbol,
  isExtractMethodKind,
  type ExtractOwnerSnapshot,
  type ExtractReceipt,
  type ExtractSession,
} from "../../extractMethodFlow";
import { candidateFromProviderAction, IntentionSession } from "../../intentionSession";
import { type WorkspaceSemanticIndexBuildToken } from "../../workspaceSemanticIndex";
import { type ExtractSessionState, type RenameSymbolAtResult } from "../model";

export interface ContinueExtractNamingContext {
  extractSessionRef: import("react").RefObject<ExtractSessionState | null>;
  extractOwnerSnapshot: (session: ExtractSession) => ExtractOwnerSnapshot;
  openFilesRef: import("react").RefObject<Record<string, import("../../editorGroupTypes").OpenFileViewModel>>;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  semanticIndex: import("../../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  captureMethodSymbolsSettled: (file: OpenFileState) => Promise<LspDocumentSymbol[] | null>;
  setStatusMessage: (message: string) => void;
  renameSymbolAt: (file: OpenFileState, position: LspPosition, options?: { title?: string; label?: string; confirmLabel?: string; promptName?: (defaultName: string, range: LspRange | null) => Promise<string | null>; isCurrent?: () => boolean; }) => Promise<RenameSymbolAtResult>;
  promptSymbolName: (input: { file: OpenFileState; kind: "rename" | "extract"; range: LspRange | null; defaultName: string; initialValue?: string; error?: string | null; dialog: (initialValue: string) => Promise<string | null>; }) => Promise<string | null>;
  promptExtractName: (sessionId: string, options: { title: string; label: string; confirmLabel: string; initialValue: string; }) => Promise<string | null>;
  revealNavLocation: (key: string, position: { line: number; character: number; }) => void;
  finishExtractSession: (session: ExtractSessionState) => void;
}

export function createContinueExtractNaming(controllerContext: ContinueExtractNamingContext) {
  return async (receipt: ExtractReceipt) => {
    const session = controllerContext.extractSessionRef.current;
    if (!session || session.id !== receipt.sessionId) return;
    const ownerMatches = () => controllerContext.extractSessionRef.current === session
      && extractOwnerMatches(session, controllerContext.extractOwnerSnapshot(session));
    const receiptMatches = () => {
      const live = controllerContext.openFilesRef.current[session.fileKey];
      return live
        ? extractReceiptMatches(receipt, { revision: live.documentRevision, text: live.text })
        : false;
    };
    try {
      if (!ownerMatches() || !receiptMatches()) return;
      session.phase = "symbols-after";
      // DEC-03: the provider outline can trail the freshly committed extraction,
      // so a null diff is re-read once before the method is declared unlocatable.
      let found: LspDocumentSymbol | null = null;
      for (let read = 0; read < 2 && !found; read += 1) {
        if (read > 0) {
          await new Promise((resolve) => { window.setTimeout(resolve, 400); });
          if (!ownerMatches() || !receiptMatches()) return;
        }
        const live = controllerContext.openFilesRef.current[session.fileKey];
        // A dirty buffer was mutated without a save, so the provider model still
        // holds the pre-extraction document; push the current buffer before the
        // post snapshot or the new method cannot be found at all.
        const synced = live
          ? await controllerContext.ensureWorkspaceSemanticDocumentsSynced(live.key, controllerContext.semanticIndex.current().revision)
          : null;
        const afterSymbols = synced ? await controllerContext.captureMethodSymbolsSettled(synced) : null;
        // A late symbols reply for a superseded owner or a moved B1 must not
        // open a prompt or move focus.
        if (!ownerMatches() || !receiptMatches()) return;
        found = afterSymbols && session.beforeSymbols
          ? findExtractedMethodSymbol(session.beforeSymbols, afterSymbols)
          : null;
      }
      const postLive = controllerContext.openFilesRef.current[session.fileKey];
      if (!postLive) return;
      if (!found) {
        controllerContext.setStatusMessage(EXTRACT_NAMING_UNAVAILABLE_MESSAGE);
        return;
      }
      // DEC-03/DEC-08: a dirty buffer keeps the extraction in the buffer; the
      // Rename chain's dirty gate would refuse it, so no prompt is shown.
      if (postLive.dirty) {
        controllerContext.setStatusMessage(extractDirtyBufferMessage(found.name));
        return;
      }
      session.phase = "naming";
      // DEC-07: a provider rejection keeps the committed extraction, the real
      // error text and the user's input, so the name can be corrected and
      // retried without repeating the extraction.
      let proposed: string | null = null;
      let replayName: string | null = null;
      let replays = 0;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const attemptFile = controllerContext.openFilesRef.current[session.fileKey] ?? postLive;
        const replayed = replayName;
        replayName = null;
        const outcome = await controllerContext.renameSymbolAt(attemptFile, found.selectionRange.start, {
          title: "Extract Method",
          label: "Method name",
          confirmLabel: "Rename",
          isCurrent: () => ownerMatches() && receiptMatches(),
          promptName: async (defaultName, range) => {
            if (replayed) return replayed;
            // ED-PARITY-017: in-place naming on the extracted method; Escape
            // keeps the provider default name (the extraction stays committed).
            const value = await controllerContext.promptSymbolName({
              file: attemptFile,
              kind: "extract",
              range,
              defaultName,
              initialValue: proposed ?? defaultName,
              dialog: (initialValue) => controllerContext.promptExtractName(session.id, {
                title: "Extract Method",
                label: "Method name",
                confirmLabel: "Rename",
                initialValue,
              }),
            });
            if (value && value !== defaultName) proposed = value;
            return value;
          },
        });
        if (controllerContext.extractSessionRef.current !== session) return;
        if (outcome.status === "failed" && outcome.retryable && attempt < 4) continue;
        if (outcome.status === "failed") return; // real reason already surfaced; B1 kept
        // The owner/receipt was invalidated (possibly at the mutation boundary):
        // nothing was written and the naming step must not claim otherwise.
        if (outcome.status === "stale") return;
        if (outcome.status === "empty-edit" && proposed && replays < 3 && attempt < 4) {
          // The provider answered the rename with an empty edit (its workspace
          // model can still trail the freshly written extraction). Replay the
          // same name against a settled model instead of dropping the naming
          // step; the extraction and history stay untouched. Escape/Cancel and
          // an unchanged name return "cancelled"/"unchanged" instead, so a
          // dismissed prompt can never rename anything.
          replayName = proposed;
          replays += 1;
          await new Promise((resolve) => { window.setTimeout(resolve, 1200); });
          if (!ownerMatches() || !receiptMatches()) return;
          continue;
        }
        // DEC-03: focus returns to the editor at the call-statement line. The
        // rename committed a new revision for this same owner, so only the
        // owner identity is re-checked here — a switched/closed view stays
        // untouched.
        controllerContext.revealNavLocation(session.fileKey, session.selection.start);
        return;
      }
    } finally {
      controllerContext.finishExtractSession(session);
    }
  };
}

export interface RunExtractMethodContext {
  activeFile: import("../../editorGroupTypes").OpenFileViewModel | null;
  extractSessionRef: import("react").RefObject<ExtractSessionState | null>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  beginExtractSession: (input: { file: OpenFileState; range: LspRange; uri: string; beforeSymbols: LspDocumentSymbol[] | null; }) => ExtractSessionState | null;
  extractLiveUri: (fileKey: string) => string;
  finishExtractSession: (session: ExtractSessionState) => void;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  semanticIndex: import("../../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  captureMethodSymbolsSettled: (file: OpenFileState) => Promise<LspDocumentSymbol[] | null>;
  intentionRequestAbortRef: import("react").RefObject<AbortController | null>;
  requestCodeActions: (file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], options?: { signal?: AbortSignal; allowCapabilityFallback?: boolean; }) => Promise<{ actions: LspCodeAction[]; providerActions: readonly ProviderActionV4[]; context: CodeActionContextIdentity | null; semanticToken: WorkspaceSemanticIndexBuildToken | null; requestFailure: { kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider"; message: string; } | null; }>;
  editorPaneRef: import("react").RefObject<HTMLElement | null>;
  setStatusMessage: (message: string) => void;
  showCodeActionsMenu: (clientX: number, clientY: number, file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], sectionLabel?: string, anchor?: { clientX: number; clientY: number; }, prefetched?: { providerActions: readonly ProviderActionV4[]; context: CodeActionContextIdentity; semanticToken: WorkspaceSemanticIndexBuildToken | null; }) => Promise<void>;
  intentionSessionRef: import("react").RefObject<IntentionSession | null>;
  runCodeAction: (action: LspCodeAction, file: OpenFileState, semanticToken?: WorkspaceSemanticIndexBuildToken | null, intentionCandidateId?: string, intentionContext?: CodeActionContextIdentity, receiptSessionId?: string) => Promise<{ ok: boolean; message: string | null; retryable: boolean; appliedReceipt?: ExtractReceipt; }>;
  continueExtractNaming: (receipt: ExtractReceipt) => Promise<void>;
}

export function createRunExtractMethod(controllerContext: RunExtractMethodContext) {
  return async () => {
    const file = controllerContext.activeFile;
    if (!file || file.loading || file.library) return;
    // DEC-07 repeat protection: while one Extract Method owner is alive — from
    // its first request through naming and the rename — a repeated chord is a
    // no-op. Superseding a request that has already applied would commit a
    // second extraction and history entry (observed as a corrupted double
    // apply), so the first transaction keeps ownership until it finishes.
    const inFlight = controllerContext.extractSessionRef.current;
    if (inFlight && inFlight.phase !== "finished") return;
    const selection = controllerContext.editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    // Reserve the transaction owner synchronously, before any await: a repeated
    // chord that arrives while this run samples symbols or requests candidates
    // must see a live owner and become a no-op instead of starting a second
    // extraction that would commit twice.
    const session = controllerContext.beginExtractSession({
      file,
      range,
      uri: controllerContext.extractLiveUri(file.key),
      beforeSymbols: null,
    });
    if (!session) return;
    const abandon = () => {
      controllerContext.finishExtractSession(session);
    };
    // B0 symbols are sampled before any provider write so the post-extraction
    // snapshot can be diffed against the frozen pre-commit context. The buffer is
    // synchronized first: an undo or a previous transaction can leave the
    // provider outline trailing the live buffer, which would poison the diff.
    await controllerContext.ensureWorkspaceSemanticDocumentsSynced(file.key, controllerContext.semanticIndex.current().revision);
    if (controllerContext.extractSessionRef.current !== session) return;
    session.beforeSymbols = await controllerContext.captureMethodSymbolsSettled(file);
    if (controllerContext.extractSessionRef.current !== session) return;
    const requestAbort = new AbortController();
    controllerContext.intentionRequestAbortRef.current?.abort();
    controllerContext.intentionRequestAbortRef.current = requestAbort;
    const requested = await controllerContext.requestCodeActions(
      file,
      range,
      [],
      ["refactor.extract"],
      { signal: requestAbort.signal, allowCapabilityFallback: true },
    );
    if (requestAbort.signal.aborted || controllerContext.intentionRequestAbortRef.current !== requestAbort) {
      abandon();
      return;
    }
    // DEC-05: request failures already surfaced their accurate message.
    if (requested.requestFailure) {
      if (controllerContext.intentionRequestAbortRef.current === requestAbort) controllerContext.intentionRequestAbortRef.current = null;
      abandon();
      return;
    }
    if (requested.context?.document.uri !== session.uri) {
      // The document identity moved while the candidates were requested.
      abandon();
      return;
    }
    const methodCandidates = requested.providerActions.filter(
      (entry) => isExtractMethodKind(entry.action.kind),
    );
    const paneRect = controllerContext.editorPaneRef.current?.getBoundingClientRect();
    const rect = selection.rect;
    const anchor = rect
      ? { clientX: Math.round(rect.left), clientY: Math.round(rect.bottom) }
      : undefined;
    if (methodCandidates.length === 0) {
      // DEC-06: distinguish "nothing selected" from "this selection cannot be
      // extracted"; never claim the server offered no actions on failure.
      controllerContext.setStatusMessage(extractMethodBoundaryMessage(selection.empty));
      if (controllerContext.intentionRequestAbortRef.current === requestAbort) controllerContext.intentionRequestAbortRef.current = null;
      abandon();
      return;
    }
    if (methodCandidates.length > 1) {
      // DEC-02: render exactly the frozen method candidates. Re-requesting with
      // the parent "refactor.extract" prefix here would reintroduce
      // variable/constant/field/interface proposals into the Extract Method menu.
      await controllerContext.showCodeActionsMenu(
        anchor?.clientX ?? (paneRect?.left ?? 0) + 80,
        anchor?.clientY ?? (paneRect?.top ?? 0) + 80,
        file,
        range,
        [],
        ["refactor.extract"],
        "Extract Method",
        anchor,
        {
          providerActions: methodCandidates,
          context: requested.context!,
          semanticToken: requested.semanticToken,
        },
      );
      controllerContext.intentionRequestAbortRef.current = null;
      abandon();
      return;
    }
    const only = methodCandidates[0]!;
    if (only.disabledReason) {
      controllerContext.setStatusMessage(only.disabledReason);
      if (controllerContext.intentionRequestAbortRef.current === requestAbort) controllerContext.intentionRequestAbortRef.current = null;
      abandon();
      return;
    }
    const intentionSnapshot = controllerContext.intentionSessionRef.current?.open(
      [candidateFromProviderAction(only.action, only.evidence, only.disabledReason)],
      {
        fileKey: file.key,
        uri: requested.context!.document.uri,
        documentRevision: requested.context!.document.revision,
        providerGeneration: requested.context!.provider.generation,
        projectFingerprint: requested.context!.provider.projectFingerprint,
      },
    );
    const candidateId = intentionSnapshot?.candidates[0]?.id;
    if (!candidateId) {
      controllerContext.finishExtractSession(session);
      return;
    }
    session.phase = "resolve";
    const outcome = await controllerContext.runCodeAction(
      only.action,
      file,
      requested.semanticToken,
      candidateId,
      requested.context!,
      session.id,
    );
    if (!outcome.appliedReceipt) {
      controllerContext.finishExtractSession(session);
      return;
    }
    session.receipt = outcome.appliedReceipt;
    await controllerContext.continueExtractNaming(outcome.appliedReceipt);
  };
}
